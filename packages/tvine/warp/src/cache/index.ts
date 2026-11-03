// Cache framework (docs/design/conventions/cache.md). settings.caches.<alias> picks a
// backend per named cache: memory (per-process LRU), redis (settings.redis.<alias>, shared), file (a directory),
// dummy (no-op). `cache` is caches.default; `caches.<alias>` (or caches.get(alias)) any other one.
//
// Keys are `<keyPrefix>:<version>:<key>`. Values are JSON (Dates and bigints round trip;
// class instances come back as plain objects). Timeouts are seconds: undefined = the cache's default,
// null = forever, 0 = do not store.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionCtx, ActionDef, CacheSettings, Settings } from '../core/types.js'
import { getRedis, redisKey } from '../redis/index.js'
import { CACHE_DEFAULTS } from '../settings.js'
import { metrics, statTap, stats } from '../core/metrics.js'
import { getLogger } from '../log.js'

const cacheLog = getLogger('tvine.cache')

type Timeout = number | null | undefined

// ---- JSON with Dates / bigints ------------------------------------------------------------------
export function encode(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v, function (this: Record<string, unknown>, k, val) {
    const raw = this[k]
    if (raw instanceof Date) return { $date: raw.toISOString() }
    if (typeof val === 'bigint') return { $bigint: val.toString() }
    return val
  })
}
export function decode(s: string): unknown {
  return JSON.parse(s, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v)
      if (keys.length === 1 && typeof v.$date === 'string') return new Date(v.$date)
      if (keys.length === 1 && typeof v.$bigint === 'string') return BigInt(v.$bigint)
    }
    return v
  })
}

// ---- stores: raw strings, ms expiry --------------------------------------------------------------
export interface Store {
  get(k: string): Promise<string | undefined>
  set(k: string, v: string, ttlMs: number | null, nx?: boolean): Promise<boolean>
  delete(k: string): Promise<boolean>
  incr(k: string, by: number): Promise<number>          // throws when k is missing
  touch(k: string, ttlMs: number | null): Promise<boolean>
  clear(prefix: string): Promise<void>
  close?(): void
}

const missing = (k: string) => new Error(`cache key "${k}" not found`)
const expiry = (ttlMs: number | null) => (ttlMs === null ? Infinity : Date.now() + ttlMs)

// LRU: Map insertion order; a hit moves the entry to the end, an insert past maxEntries drops the oldest.
export class MemoryStore implements Store {
  private m = new Map<string, { v: string; exp: number }>()
  constructor(private max: number) {}
  private live(k: string) {
    const e = this.m.get(k)
    if (!e) return undefined
    if (e.exp <= Date.now()) { this.m.delete(k); return undefined }
    this.m.delete(k); this.m.set(k, e)
    return e
  }
  async get(k: string) { return this.live(k)?.v }
  async set(k: string, v: string, ttlMs: number | null, nx?: boolean) {
    if (nx && this.live(k)) return false
    this.m.delete(k)
    this.m.set(k, { v, exp: expiry(ttlMs) })
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!)
    return true
  }
  async delete(k: string) { return this.m.delete(k) }
  async incr(k: string, by: number) {
    const e = this.live(k)
    if (!e) throw missing(k)
    const n = Number(JSON.parse(e.v)) + by
    if (!Number.isFinite(n)) throw new Error(`cache key "${k}" does not hold a number`)
    e.v = String(n)
    return n
  }
  async touch(k: string, ttlMs: number | null) { const e = this.live(k); if (e) e.exp = expiry(ttlMs); return !!e }
  async clear(prefix: string) { for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.m.delete(k) }
}

// One file per key: sha256(key).cache = {"k","exp","v"}. Written to a temp file then renamed (a reader never sees
// half a file). ponytail: incr is read-modify-write, not atomic across processes.
export class FileStore implements Store {
  constructor(private dir: string, private max: number) {}
  private path(k: string) { return join(this.dir, `${createHash('sha256').update(k).digest('hex')}.cache`) }
  private read(k: string): { k: string; exp: number | null; v: string } | undefined {
    let e: { k: string; exp: number | null; v: string }
    try { e = JSON.parse(readFileSync(this.path(k), 'utf8')) } catch { return undefined }
    if (e.k !== k) return undefined
    if (e.exp !== null && e.exp <= Date.now()) { rmSync(this.path(k), { force: true }); return undefined }
    return e
  }
  private write(k: string, v: string, exp: number | null) {
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify({ k, exp, v }))
    renameSync(tmp, this.path(k))
  }
  private files() { try { return readdirSync(this.dir).filter((f) => f.endsWith('.cache')) } catch { return [] } }
  async get(k: string) { return this.read(k)?.v }
  async set(k: string, v: string, ttlMs: number | null, nx?: boolean) {
    if (nx && this.read(k)) return false
    this.write(k, v, ttlMs === null ? null : Date.now() + ttlMs)
    // cull: past maxEntries drop the oldest third (by mtime)
    const fs = this.files()
    if (fs.length > this.max) {
      const old = fs.map((f) => ({ f, t: statSync(join(this.dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 })).sort((a, b) => a.t - b.t)
      for (const { f } of old.slice(0, Math.ceil(fs.length / 3))) rmSync(join(this.dir, f), { force: true })
    }
    return true
  }
  async delete(k: string) { const had = !!this.read(k); rmSync(this.path(k), { force: true }); return had }
  async incr(k: string, by: number) {
    const e = this.read(k)
    if (!e) throw missing(k)
    const n = Number(JSON.parse(e.v)) + by
    if (!Number.isFinite(n)) throw new Error(`cache key "${k}" does not hold a number`)
    this.write(k, String(n), e.exp)
    return n
  }
  async touch(k: string, ttlMs: number | null) {
    const e = this.read(k)
    if (e) this.write(k, e.v, ttlMs === null ? null : Date.now() + ttlMs)
    return !!e
  }
  async clear(prefix: string) {
    for (const f of this.files()) {
      try { if ((JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as { k: string }).k.startsWith(prefix)) rmSync(join(this.dir, f), { force: true }) } catch { /* gone */ }
    }
  }
}

export class DummyStore implements Store {
  async get() { return undefined }
  async set() { return true }
  async delete() { return false }
  async incr(k: string): Promise<number> { throw missing(k) }
  async touch() { return false }
  async clear() {}
}

// INCRBY only when the key exists (keeps its TTL): a missing key throws
const INCR = "if redis.call('EXISTS', KEYS[1]) == 0 then return redis.error_reply('missing') end return redis.call('INCRBY', KEYS[1], ARGV[1])"
const glob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&')

// Keys: <redis prefix>cache:<cache alias>:<made key>
export class RedisStore implements Store {
  constructor(private alias: string, private ns: string) {}
  private k(k: string) { return redisKey(this.alias, 'cache', this.ns, k) }
  private async c() { return getRedis(this.alias) }
  async get(k: string) { return (await (await this.c()).sendCommand<string | null>(['GET', this.k(k)])) ?? undefined }
  async set(k: string, v: string, ttlMs: number | null, nx?: boolean) {
    const args = ['SET', this.k(k), v, ...(ttlMs === null ? [] : ['PX', String(Math.max(1, Math.round(ttlMs)))]), ...(nx ? ['NX'] : [])]
    return (await (await this.c()).sendCommand(args)) === 'OK'
  }
  async delete(k: string) { return Number(await (await this.c()).sendCommand(['DEL', this.k(k)])) > 0 }
  async incr(k: string, by: number) {
    try { return Number(await (await this.c()).sendCommand(['EVAL', INCR, '1', this.k(k), String(by)])) } catch (e) {
      if (/missing/.test((e as Error).message)) throw missing(k)
      throw e
    }
  }
  async touch(k: string, ttlMs: number | null) {
    const c = await this.c()
    return Number(await c.sendCommand(ttlMs === null ? ['PERSIST', this.k(k)] : ['PEXPIRE', this.k(k), String(Math.max(1, Math.round(ttlMs)))])) > 0
      || (ttlMs === null && Number(await c.sendCommand(['EXISTS', this.k(k)])) > 0)
  }
  async clear(prefix: string) {
    const c = await this.c()
    let cursor = '0'
    do {
      const [next, keys] = await c.sendCommand<[string, string[]]>(['SCAN', cursor, 'MATCH', `${glob(this.k(prefix))}*`, 'COUNT', '500'])
      cursor = next
      if (keys.length) await c.sendCommand(['DEL', ...keys])
    } while (cursor !== '0')
  }
}

// ---- the cache API ------------------------------------------------------------------------
const TAGGED = '\u0000t'   // a tagged entry: TAGGED + {"t":{tag:version},"v":value}

export class Cache {
  constructor(readonly alias: string, readonly conf: CacheSettings, readonly store: Store, private tagSet: string[] = []) {}

  makeKey(key: string, version = this.conf.version): string { return `${this.conf.keyPrefix}:${version}:${key}` }
  private ttl(t: Timeout): number | null {
    const s = t === undefined ? this.conf.timeout : t
    return s === null ? null : s * 1000
  }
  private tagKey(tag: string) { return this.makeKey(`tag:${tag}`, 0) }

  // keyFor helper: stable key from parts (objects hashed)
  static keyFor(...parts: unknown[]): string {
    return parts.map((p) => (typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean' ? String(p) : createHash('sha256').update(encode(sorted(p))).digest('hex').slice(0, 32))).join(':')
  }
  keyFor(...parts: unknown[]): string { return Cache.keyFor(...parts) }

  private async pack(v: unknown): Promise<string> {
    if (!this.tagSet.length) return encode(v)
    const t: Record<string, string> = {}
    for (const tag of this.tagSet) {
      const k = this.tagKey(tag)
      await this.store.set(k, randomUUID(), null, true)
      t[tag] = (await this.store.get(k))!
    }
    return TAGGED + encode({ t, v })
  }
  private async unpack(s: string | undefined): Promise<{ hit: boolean; v?: unknown }> {
    const r = await this.unpacked(s)
    metrics.inc(r.hit ? 'tvine_cache_hits_total' : 'tvine_cache_misses_total', { cache: this.alias })
    if (stats.tap) statTap({ k: 'cache', alias: this.alias, hit: r.hit })
    return r
  }
  private async unpacked(s: string | undefined): Promise<{ hit: boolean; v?: unknown }> {
    if (s === undefined) return { hit: false }
    if (!s.startsWith(TAGGED)) return { hit: true, v: decode(s) }
    const e = decode(s.slice(TAGGED.length)) as { t: Record<string, string>; v: unknown }
    for (const [tag, ver] of Object.entries(e.t)) if ((await this.store.get(this.tagKey(tag))) !== ver) return { hit: false }
    return { hit: true, v: e.v }
  }

  async get<T = unknown>(key: string, dflt?: T, version?: number): Promise<T | undefined> {
    const r = await this.unpack(await this.store.get(this.makeKey(key, version)))
    return r.hit ? (r.v as T) : dflt
  }
  // { hit, v }: tells a stored null apart from a miss
  async lookup(key: string, version?: number): Promise<{ hit: boolean; v?: unknown }> { return this.unpack(await this.store.get(this.makeKey(key, version))) }
  async has(key: string, version?: number): Promise<boolean> { return (await this.unpack(await this.store.get(this.makeKey(key, version)))).hit }
  async set(key: string, value: unknown, timeout?: Timeout, version?: number): Promise<void> {
    const ttl = this.ttl(timeout), k = this.makeKey(key, version)
    if (ttl === 0) { await this.store.delete(k); return }
    await this.store.set(k, await this.pack(value), ttl)
  }
  // only when absent; true when stored
  async add(key: string, value: unknown, timeout?: Timeout, version?: number): Promise<boolean> {
    const ttl = this.ttl(timeout)
    if (ttl === 0) return false
    return this.store.set(this.makeKey(key, version), await this.pack(value), ttl, true)
  }
  async getOrSet<T>(key: string, dflt: T | (() => T | Promise<T>), timeout?: Timeout, version?: number): Promise<T> {
    const r = await this.unpack(await this.store.get(this.makeKey(key, version)))
    if (r.hit) return r.v as T
    const v = typeof dflt === 'function' ? await (dflt as () => T | Promise<T>)() : dflt
    await this.set(key, v, timeout, version)
    return v
  }
  async delete(key: string, version?: number): Promise<boolean> { return this.store.delete(this.makeKey(key, version)) }
  async touch(key: string, timeout?: Timeout, version?: number): Promise<boolean> { return this.store.touch(this.makeKey(key, version), this.ttl(timeout)) }
  // atomic on redis (INCRBY) and memory; a missing key throws
  async incr(key: string, delta = 1, version?: number): Promise<number> { return this.store.incr(this.makeKey(key, version), delta) }
  async decr(key: string, delta = 1, version?: number): Promise<number> { return this.incr(key, -delta, version) }
  async getMany<T = unknown>(keys: string[], version?: number): Promise<Record<string, T>> {
    const out: Record<string, T> = {}
    for (const k of keys) { const r = await this.unpack(await this.store.get(this.makeKey(k, version))); if (r.hit) out[k] = r.v as T }
    return out
  }
  async setMany(data: Record<string, unknown>, timeout?: Timeout, version?: number): Promise<string[]> {
    for (const [k, v] of Object.entries(data)) await this.set(k, v, timeout, version)
    return []   // the keys that failed to insert
  }
  async deleteMany(keys: string[], version?: number): Promise<void> { for (const k of keys) await this.delete(k, version) }
  async incrVersion(key: string, delta = 1, version = this.conf.version): Promise<number> {
    const r = await this.unpack(await this.store.get(this.makeKey(key, version)))
    if (!r.hit) throw missing(key)
    await this.set(key, r.v, undefined, version + delta)
    await this.delete(key, version)
    return version + delta
  }
  async decrVersion(key: string, delta = 1, version?: number): Promise<number> { return this.incrVersion(key, -delta, version) }
  // only this cache's keys (its keyPrefix), never the whole store
  async clear(): Promise<void> { await this.store.clear(`${this.conf.keyPrefix}:`) }

  // cache.tags(['product:12']).set(...): the entry dies when any of its tags is invalidated
  tags(tags: string[]): Cache { return new Cache(this.alias, this.conf, this.store, [...this.tagSet, ...tags]) }
  async invalidateTags(tags: string[]): Promise<void> { for (const t of tags) await this.store.set(this.tagKey(t), randomUUID(), null) }
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v

// ---- registry ----------------------------------------------------------------------------------
interface Reg { conf: Record<string, CacheSettings>; built: Map<string, Cache> }
const REG = Symbol.for('tvine.caches')
const reg: Reg = ((globalThis as { [REG]?: Reg })[REG] ??= { conf: { default: CACHE_DEFAULTS }, built: new Map() })

function storeFor(alias: string, c: CacheSettings): Store {
  switch (c.backend) {
    case 'redis': return new RedisStore(c.redis, alias)
    case 'file': return new FileStore(c.location!, c.maxEntries)
    case 'dummy': return new DummyStore()
    default: return new MemoryStore(c.maxEntries)
  }
}

// settings.caches (boot: loadSettings). A changed alias gets a fresh cache; an unchanged one keeps its store.
export function configureCaches(settings: Pick<Settings, 'caches'>): void {
  for (const [a, c] of Object.entries(settings.caches)) {
    if (JSON.stringify(reg.conf[a]) !== JSON.stringify(c)) reg.built.delete(a)
  }
  reg.conf = { ...settings.caches }
}

export interface Caches { get(alias?: string): Cache; readonly [alias: string]: Cache | ((alias?: string) => Cache) }
function get(alias = 'default'): Cache {
  let c = reg.built.get(alias)
  if (!c) {
    const conf = reg.conf[alias]
    if (!conf) throw new Error(`cache "${alias}" is not configured (settings.caches.${alias})`)
    reg.built.set(alias, (c = new Cache(alias, conf, storeFor(alias, conf))))
  }
  return c
}
// caches.default / caches.get('sessions')
export const caches = new Proxy({ get } as Caches, { get: (t, p) => (p === 'get' ? get : typeof p === 'string' ? get(p) : (t as never)[p]) }) as { get(alias?: string): Cache } & Record<string, Cache>
// cache = caches.default, resolved per call (settings may be configured after import)
export const cache: Cache = new Proxy({} as Cache, {
  get: (_t, p) => { const c = get(); const v = (c as unknown as Record<PropertyKey, unknown>)[p]; return typeof v === 'function' ? (v as Function).bind(c) : v },
})

// ---- per-view caching (rules.cache) -----------------------------------------------------------
export const VARY_BUILTIN = ['user', 'session', 'query'] as const
export function checkViewCache(id: string, rules: ActionDef['rules']): void {
  const c = rules?.cache
  if (!c) return
  if (!rules?.readOnly) throw new Error(`action ${id}: rules.cache needs rules.readOnly (only read actions are cached)`)
  if (!(typeof c.timeout === 'number' && c.timeout > 0)) throw new Error(`action ${id}: rules.cache.timeout is seconds > 0`)
  if (rules.secretResult) throw new Error(`action ${id}: rules.cache cannot store a secretResult (a one-time secret)`)
  for (const v of c.varyOn ?? []) if (!/^[a-z0-9-]+$/i.test(v)) throw new Error(`action ${id}: rules.cache.varyOn "${v}" is not user, session, query or a header name`)
}

// The handler's result, from the cache when fresh. Keyed by action, params and varyOn (default ['user']:
// never shared across users unless varyOn leaves 'user' out; a signed-out caller keys by its session, so two
// anonymous visitors never share). A throw (error, redirect) is never stored. A cache that fails is skipped
// (logged): the handler runs and its result is returned.
export async function cachedRun(def: ActionDef, params: unknown, ctx: ActionCtx, run: () => Promise<unknown>): Promise<unknown> {
  const rc = def.rules!.cache!
  const c = caches.get(rc.cache ?? 'default')
  const r = ctx.request, varyOn = rc.varyOn ?? ['user']
  // a signed-in user without an id cannot be told apart from another: not cached
  if (varyOn.includes('user') && r.user.isAuthenticated && r.user.id === undefined) return run()
  const vary = varyOn.map((v) => {
    if (v === 'user') return r.user.isAuthenticated ? `u=${r.user.id}` : `u=-:s=${ctx.sid}`
    if (v === 'session') return `s=${ctx.sid}`
    if (v === 'query') return `q=${[...r.query].sort().join('&')}`
    return `h:${v.toLowerCase()}=${r.headers.get(v) ?? ''}`
  })
  const key = Cache.keyFor('view', def.id, params ?? null, vary)
  const warn = (step: string, e: unknown) => cacheLog.error(`view cache ${step} failed; handler result used`, { action: def.id, cache: c.alias, error: (e as Error).message })
  let hit: { hit: boolean; v?: unknown } = { hit: false }
  try { hit = await c.lookup(key) } catch (e) { warn('read', e) }
  if (hit.hit) return hit.v
  const out = await run()
  try { await (rc.tags?.length ? c.tags(rc.tags) : c).set(key, out, rc.timeout) } catch (e) { warn('write', e) }
  return out
}
