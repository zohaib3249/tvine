// TODO(task-connect): replace this file with `import { getRedis } from "../../redis/index.js"` once it is on main.
// ponytail: a local stand-in for the central named redis connections (packages/warp/src/redis, branch task-connect:
// `getRedis(alias)` configured by `settings.redis = { default: { url, tls?, prefix? } }` + REDIS_URL). Same
// signature, so swapping is one import. Until then: configureRedis() or REDIS_URL for the 'default' alias.
import { createRequire } from 'node:module'
import type { Redis, RedisOptions } from 'ioredis'

export interface RedisConn { url: string; tls?: RedisOptions['tls']; prefix?: string }
let conns: Record<string, RedisConn> = {}
const clients = new Map<string, Redis>()

export function configureRedis(c: Record<string, RedisConn>): void { conns = { ...c } }

export function redisConf(alias = 'default'): RedisConn {
  const c = conns[alias] ?? (alias === 'default' && process.env.REDIS_URL ? { url: process.env.REDIS_URL } : undefined)
  if (!c || !c.url.trim()) throw new Error(`redis connection "${alias}" is not configured: set settings.redis.${alias}.url${alias === 'default' ? ' or REDIS_URL' : ''}`)
  return c
}

// the optional peer dependency, loaded on first use
export function loadIoredis(): typeof import('ioredis').default {
  try { return (createRequire(import.meta.url)('ioredis') as { default: typeof import('ioredis').default }).default }
  catch { throw new Error("settings.tasks.broker 'redis' needs the ioredis package: npm i ioredis") }
}

// a fresh client for a connection (rediss:// = TLS; `tls` adds CA / client certs). The url never appears in errors.
export function connect(alias = 'default'): Redis {
  const c = redisConf(alias)
  const IORedis = loadIoredis()
  let u: URL
  try { u = new URL(c.url) } catch { throw new Error(`redis connection "${alias}": the url is not valid (redis://… or rediss://…)`) }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error(`redis connection "${alias}": use a redis:// or rediss:// url`)
  const tls = u.protocol === 'rediss:' ? { ...(c.tls ?? {}) } : c.tls
  return new IORedis(c.url, { lazyConnect: false, maxRetriesPerRequest: 20, enableAutoPipelining: true, ...(tls && { tls }) })
}

export function getRedis(alias = 'default'): Redis {
  let r = clients.get(alias)
  if (!r) clients.set(alias, (r = connect(alias)))
  return r
}

export async function closeRedis(alias?: string): Promise<void> {
  for (const [k, r] of clients) {
    if (alias && k !== alias) continue
    clients.delete(k)
    await r.quit().catch(() => r.disconnect())
  }
}
