// Single-use claims + short-lived secrets (challenge nonces, captcha answers, Web Bot Auth replays) on a store with NO
// eviction: the limits backend (settings.limits.backend 'redis' → SET NX PX, every server) or an in-process TTL map that
// only ever drops EXPIRED entries. A flood can't push a used nonce out (the evicting cache could: review H1); the /start
// and /verify rate limits bound how many entries live at once. Backend errors throw: callers fail closed.
import type { Settings } from '../../core/types.js'
import { getRedis, redisKey } from '../../redis/index.js'

const mem = new Map<string, { exp: number; v: string }>()
let sweptAt = 0
function sweep(now: number): void {
  if (now - sweptAt < 10_000) return
  sweptAt = now
  for (const [k, e] of mem) if (e.exp <= now) mem.delete(k)
}
const redisOf = (s: Settings | undefined) => (s?.limits?.backend === 'redis' ? s.limits.redis : undefined)

export const claims = {
  // true the first time `key` is claimed within ttlMs (on every server with redis)
  async claim(s: Settings | undefined, key: string, ttlMs: number): Promise<boolean> {
    const alias = redisOf(s)
    if (alias) return (await (await getRedis(alias)).sendCommand(['SET', redisKey(alias, 'shield', 'claim', key), '1', 'NX', 'PX', String(ttlMs)])) === 'OK'
    const now = Date.now()
    sweep(now)
    const e = mem.get(`c:${key}`)
    if (e && e.exp > now) return false
    mem.set(`c:${key}`, { exp: now + ttlMs, v: '1' })
    return true
  },
  async set(s: Settings | undefined, key: string, value: string, ttlMs: number): Promise<void> {
    const alias = redisOf(s)
    if (alias) { await (await getRedis(alias)).sendCommand(['SET', redisKey(alias, 'shield', 'kv', key), value, 'PX', String(ttlMs)]); return }
    sweep(Date.now())
    mem.set(`v:${key}`, { exp: Date.now() + ttlMs, v: value })
  },
  // read and delete in one step (a captcha answer is checked once)
  async take(s: Settings | undefined, key: string): Promise<string | undefined> {
    const alias = redisOf(s)
    if (alias) return (await (await getRedis(alias)).sendCommand(['GETDEL', redisKey(alias, 'shield', 'kv', key)])) as string | null ?? undefined
    const e = mem.get(`v:${key}`)
    mem.delete(`v:${key}`)
    return e && e.exp > Date.now() ? e.v : undefined
  },
  // fixed-window counter (attempt limits): the count after this hit
  async count(s: Settings | undefined, key: string, windowMs: number): Promise<number> {
    const alias = redisOf(s)
    if (alias) {
      const r = await getRedis(alias), k = redisKey(alias, 'shield', 'n', key)
      const n = Number(await r.sendCommand(['INCR', k]))
      if (n === 1) await r.sendCommand(['PEXPIRE', k, String(windowMs)])
      return n
    }
    const now = Date.now()
    sweep(now)
    const e = mem.get(`n:${key}`)
    const n = e && e.exp > now ? Number(e.v) + 1 : 1
    mem.set(`n:${key}`, { exp: e && e.exp > now ? e.exp : now + windowMs, v: String(n) })
    return n
  },
  size: () => mem.size,
  clear: () => mem.clear(),
}
