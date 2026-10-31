// One settings file picks every backend (docs/design/conventions/backends.md). Each selector defaults to
// 'memory' (in-process, single server); 'redis' takes settings.redis[<the selector's redis alias>].
import type { ChannelLayer, Settings } from '../core/types.js'
import { MemoryChannelLayer } from '../core/channels.js'
import { SessionStore, type SessionStoreOptions } from '../core/session.js'
import { SnapshotCache, type SnapshotStore } from '../core/registry.js'
import { onDataVersion } from '../data/engine.js'
import { IdempotencyCache, type Idempotency } from '../security/idempotency.js'
import { RateLimiter, type Limiter } from '../security/ratelimit.js'
import { RedisAgentMarks, RedisChannelLayer, RedisIdempotency, RedisRateLimiter, RedisSessionStore, RedisSnapshotCache } from './redis.js'
import { redis } from '../redis/index.js'

type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

export function channelsFor(settings: Settings, log?: Log): ChannelLayer {
  return settings.channels?.backend === 'redis' ? new RedisChannelLayer(settings.channels.redis, log) : new MemoryChannelLayer()
}

export function sessionsFor(settings: Settings, opts: SessionStoreOptions = {}, log?: Log): SessionStore {
  if (settings.session.backend !== 'redis') return new SessionStore(settings.session, opts)
  // a command (handler + middleware + its snapshot render) holds the session at most this long
  const lockMs = 4 * settings.limits.handlerMs + 15_000
  return new RedisSessionStore(settings.session, { ...opts, alias: settings.session.redis, lockMs, log })
}

// rate: the bucket defaults (settings.limits.rate, or a module's own, e.g. password reset 3/hour)
export function limiterFor(settings: Settings, rate: { limit: number; windowMs: number } = settings.limits.rate): Limiter {
  return settings.limits?.backend === 'redis' ? new RedisRateLimiter(settings.limits.redis, rate) : new RateLimiter(rate)
}

export function idempotencyFor(settings: Settings): Idempotency {
  return settings.limits?.backend === 'redis' ? new RedisIdempotency(settings.limits.redis, settings.session.ttlMs) : new IdempotencyCache(settings.session.ttlMs)
}

// shared tab agent marking; undefined = in-process only
export function marksFor(settings: Settings): RedisAgentMarks | undefined {
  return settings.limits?.backend === 'redis' ? new RedisAgentMarks(settings.limits.redis) : undefined
}

export function snapshotCacheFor(settings: Settings, version: () => number, log?: Log): SnapshotStore & { settle?(): Promise<void>; close?(): void } {
  const c = settings.snapshotCache
  return c.backend === 'redis' ? new RedisSnapshotCache(c.redis, c.ttlMs, onDataVersion, log) : new SnapshotCache(c.ttlMs, 1000, version)
}

// `tvine check` / health: which backend each subsystem runs on
export function backendTable(settings: Settings): { subsystem: string; key: string; backend: string; redis?: string }[] {
  const row = (subsystem: string, key: string, b: string, alias: string) => ({ subsystem, key, backend: b, ...(b === 'redis' && { redis: alias }) })
  return [
    row('sessions', 'session.backend', settings.session.backend, settings.session.redis),
    row('channels (SSE fan-out, replay)', 'channels.backend', settings.channels.backend, settings.channels.redis),
    row('rate limits, idempotency, login throttle, tab agent marks', 'limits.backend', settings.limits.backend, settings.limits.redis),
    row('snapshot cache', 'snapshotCache.backend', settings.snapshotCache.backend, settings.snapshotCache.redis),
    row('tasks broker', 'tasks.broker', settings.tasks.broker ?? '(tvine.tasks default)', settings.tasks.redis),
  ]
}

// /tvine/health section: backends + the state of the redis clients opened so far (never a url)
export function backendHealth(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const r of backendTable(settings)) out[r.key.split('.')[0]!] = r.redis ? `redis:${r.redis}` : r.backend
  const conns = redis.health()
  if (Object.keys(conns).length) out.redis = conns
  return out
}
