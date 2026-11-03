// Named Redis connections (docs/design/conventions/backends.md). ONE place opens Redis: settings.redis.<alias>
// (default ← REDIS_URL) → a lazy client per alias. Sessions, channels, limits, the snapshot cache and the tasks
// broker all take their client from here by alias; nobody builds a client of their own.
//
// - The `redis` wire driver is an optional peer dependency, loaded on first use (install hint otherwise).
// - Errors and logs never carry the url's credentials: messages are scrubbed and name the alias + host only.
// - Every key a subsystem writes goes through key(alias, ...): the alias's prefix (default 'tvine:') first, so
//   two apps can share one Redis by giving each its own prefix.
// - One handler per process (globalThis, like data/db.ts connections): configure() is idempotent for an
//   unchanged alias, so a second server in the same process keeps the first one's clients.
import { AsyncResource } from 'node:async_hooks'
import type { RedisConnection, Settings } from '../core/types.js'

// The subset of node-redis we rely on (structural, so the driver stays an optional peer).
export interface RedisClient {
  sendCommand<T = unknown>(args: readonly (string | Buffer)[]): Promise<T>
  duplicate(): RedisClient
  connect(): Promise<unknown>
  close(): Promise<void>
  destroy(): void
  on(event: 'error', fn: (e: unknown) => void): unknown
  readonly isReady: boolean
  SUBSCRIBE(channels: string | string[], fn: (message: string, channel: string) => void): Promise<void>
  PSUBSCRIBE(patterns: string | string[], fn: (message: string, channel: string) => void): Promise<void>
  UNSUBSCRIBE(channels?: string | string[], fn?: (message: string, channel: string) => void): Promise<void>
  PUNSUBSCRIBE(patterns?: string | string[]): Promise<void>
}

export const DEFAULT_PREFIX = 'tvine:'
const DEFAULT_CONNECT_MS = 5_000
type Log = (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
const consoleLog: Log = (level, msg, data) => console.error(JSON.stringify({ level, msg, ...data }))

// redis://user:pass@host:6379/0 → redis://host:6379/0 (for messages; never the credentials)
export function safeUrl(url: string): string {
  try { const u = new URL(url); u.username = ''; u.password = ''; return u.toString() } catch { return '<invalid redis url>' }
}
// strip the url and its password from any driver message
function scrub(msg: string, url: string): string {
  let out = msg.split(url).join(safeUrl(url))
  try {
    const u = new URL(url)
    for (const s of [u.password, decodeURIComponent(u.password), u.username && `${u.username}:`].filter((x) => x && x.length >= 3)) out = out.split(s as string).join('***')
  } catch { /* nothing more to strip */ }
  return out
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

// node-redis arms a 5 s AbortSignal.timeout per command. A timer keeps the async context it was made in (with
// AsyncLocalStorage: the whole request, its req/res and handler scope) until it fires, and that timer is never
// cleared: under load every request stayed reachable for 5 s (10k req/s on a cached read = GBs of heap). Commands are
// started in this module's own context instead; the caller's await still resumes in its own context.
// ponytail: the context is the one this module was first evaluated in (boot), not a guaranteed-empty one.
const DETACHED = new AsyncResource('tvine.redis')
export function detach(c: RedisClient): RedisClient {
  const send = c.sendCommand.bind(c)
  c.sendCommand = ((args: readonly (string | Buffer)[], ...rest: unknown[]) => DETACHED.runInAsyncScope(() => (send as (...a: unknown[]) => Promise<unknown>)(args, ...rest))) as RedisClient['sendCommand']
  return c
}

let driver: Promise<{ createClient(o: object): RedisClient }> | undefined
async function loadDriver(): Promise<{ createClient(o: object): RedisClient }> {
  driver ??= import('redis').then((m) => m as unknown as { createClient(o: object): RedisClient }, () => {
    driver = undefined
    throw new Error('settings.redis needs the redis driver: install it in your app (pnpm add redis@6)')
  })
  return driver
}

interface Open { conf: RedisConnection; client?: Promise<RedisClient>; sub?: Promise<RedisClient> }

export class RedisConnections {
  private conns = new Map<string, Open>()
  private log: Log = consoleLog
  private lastErr = new Map<string, number>()

  // Registers aliases (opens nothing). An alias whose config changed drops its old clients; an unchanged one keeps them.
  configure(all: Settings['redis'], log?: Log): void {
    if (log) this.log = log
    for (const [alias, c] of Object.entries(all)) {
      const old = this.conns.get(alias)
      if (old && same(old.conf, c)) continue
      if (old) void this.closeOne(old)
      this.conns.set(alias, { conf: c })
    }
  }

  has(alias = 'default'): boolean { return this.conns.has(alias) }
  aliases(): string[] { return [...this.conns.keys()] }

  // `${prefix}${parts.join(':')}` for the alias: every key a subsystem touches goes through here.
  key(alias: string, ...parts: string[]): string { return `${this.conf(alias).prefix ?? DEFAULT_PREFIX}${parts.join(':')}` }
  prefix(alias = 'default'): string { return this.conf(alias).prefix ?? DEFAULT_PREFIX }

  // The command client for an alias, connected on first use (shared by every subsystem on that alias).
  get(alias = 'default'): Promise<RedisClient> {
    const o = this.open(alias)
    return (o.client ??= this.connect(alias, o.conf).catch((e) => { o.client = undefined; throw e }))
  }

  // A second connection for SUBSCRIBE (a subscribed connection can run no other command). Shared per alias.
  subscriber(alias = 'default'): Promise<RedisClient> {
    const o = this.open(alias)
    return (o.sub ??= this.connect(alias, o.conf).catch((e) => { o.sub = undefined; throw e }))
  }

  // /tvine/health: sync and cheap — the state of the clients opened so far, never the url
  health(): Record<string, { ready: boolean; host: string }> {
    const out: Record<string, { ready: boolean; host: string }> = {}
    for (const [alias, o] of this.conns) if (o.client) out[alias] = { ready: this.readyNow.get(alias) ?? false, host: hostOf(o.conf.url) }
    return out
  }
  private readyNow = new Map<string, boolean>()

  // round trip (tvine check): ms, or a scrubbed error
  async ping(alias = 'default'): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
    const t0 = performance.now()
    try {
      await (await this.get(alias)).sendCommand(['PING'])
      return { ok: true, ms: Math.round(performance.now() - t0) }
    } catch (e) { return { ok: false, error: messageOf(e) } }
  }

  // Graceful: QUIT each open client (pending replies are delivered first); a client that will not close is destroyed.
  // Aliases stay configured: a later get() reconnects.
  async close(): Promise<void> {
    await Promise.all([...this.conns.values()].map((o) => this.closeOne(o)))
  }

  private async closeOne(o: Open): Promise<void> {
    const cs = await Promise.all([o.client, o.sub].map((p) => p?.catch(() => undefined)))
    o.client = o.sub = undefined
    await Promise.all(cs.map(async (c) => {
      if (!c) return
      try { await Promise.race([c.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 2_000).unref())]) } catch { try { c.destroy() } catch { /* gone */ } }
    }))
  }

  private conf(alias: string): RedisConnection {
    const o = this.conns.get(alias)
    if (!o) throw new Error(`redis connection "${alias}" is not configured (settings.redis.${alias}${alias === 'default' ? ' or REDIS_URL' : ''})`)
    return o.conf
  }
  private open(alias: string): Open { this.conf(alias); return this.conns.get(alias)! }

  private async connect(alias: string, conf: RedisConnection): Promise<RedisClient> {
    const { createClient } = await loadDriver()
    const tls = conf.tls ?? conf.url.startsWith('rediss://')
    let up = false   // first connect fails after a few tries (boot error); once up, reconnect forever with backoff
    const client = createClient({
      url: conf.url,
      socket: { connectTimeout: conf.connectTimeoutMs ?? DEFAULT_CONNECT_MS, ...(tls && { tls: true }),
        reconnectStrategy: (n: number, cause: unknown) => (!up && n >= 2 ? (cause instanceof Error ? cause : new Error(String(cause))) : Math.min(50 * 2 ** n, 2_000)) },
      // a request must fail fast while Redis is down, never hang in an offline queue
      disableOfflineQueue: true,
    })
    const where = `redis "${alias}" (${hostOf(conf.url)})`
    // without an 'error' listener a dropped connection would crash the process; logged at most every 10 s
    client.on('error', (e: unknown) => {
      this.readyNow.set(alias, false)
      const now = Date.now()
      if (now - (this.lastErr.get(alias) ?? 0) < 10_000) return
      this.lastErr.set(alias, now)
      this.log('error', `${where}: ${scrub(messageOf(e), conf.url)}`)
    })
    ;(client as unknown as { on(ev: string, fn: () => void): void }).on('ready', () => this.readyNow.set(alias, true))
    try { await client.connect() } catch (e) {
      try { client.destroy() } catch { /* never connected */ }
      throw new Error(`${where}: cannot connect: ${scrub(messageOf(e), conf.url)}`)
    }
    up = true
    this.readyNow.set(alias, true)
    return detach(client)
  }
}

const same = (a: RedisConnection, b: RedisConnection) => a.url === b.url && a.tls === b.tls && a.prefix === b.prefix && a.connectTimeoutMs === b.connectTimeoutMs
function hostOf(url: string): string { try { return new URL(url).host } catch { return '?' } }

const REDIS = Symbol.for('tvine.redis')
export const redis: RedisConnections = ((globalThis as { [REDIS]?: RedisConnections })[REDIS] ??= new RedisConnections())

// The stable API other modules build on (sessions, channels, limits, cache, tasks brokers):
export const configureRedis = (settings: { redis: Settings['redis'] }, log?: Log): void => redis.configure(settings.redis, log)
export const getRedis = (alias = 'default'): Promise<RedisClient> => redis.get(alias)
export const getSubscriber = (alias = 'default'): Promise<RedisClient> => redis.subscriber(alias)
export const redisKey = (alias: string, ...parts: string[]): string => redis.key(alias, ...parts)
export const closeRedis = (): Promise<void> => redis.close()
