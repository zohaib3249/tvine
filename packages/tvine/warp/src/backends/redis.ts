// The 'redis' backends (docs/design/conventions/backends.md): every piece of request state that must be the same
// on every server. Each takes its client from redis/ by alias and writes only under that alias's prefix.
// Multi-key steps are single Lua scripts (atomic). Keys are built inside scripts from the prefix, so this needs a
// single Redis (or a primary with replicas / Sentinel), not Redis Cluster.
import { createHash, randomBytes } from 'node:crypto'
import { deserialize, serialize } from 'node:v8'
import { nanoid } from 'nanoid'
import type { ActionRules, ChannelLayer, Event, Replayed, Rev, Session, Settings, Sid, Snapshot } from '../core/types.js'
import { RING } from '../core/channels.js'
import { newSession, SessionBusy, SessionStore, type SessionKey, type SessionStoreOptions } from '../core/session.js'
import { bucketsFor, checkRate, type Limiter, type RateKeys, type RateResult } from '../security/ratelimit.js'
import type { Idempotency, Replay } from '../security/idempotency.js'
import { cacheBody, type SnapBody, type SnapshotStore } from '../core/registry.js'
import { redis, type RedisClient } from '../redis/index.js'

type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

// EVALSHA, falling back to EVAL once per client after a SCRIPT FLUSH / restart (NOSCRIPT)
export class Script {
  private sha: string
  constructor(private src: string) { this.sha = sha1(src) }
  async run<T>(c: RedisClient, keys: string[], args: (string | number)[]): Promise<T> {
    const a = [String(keys.length), ...keys, ...args.map(String)]
    try { return await c.sendCommand<T>(['EVALSHA', this.sha, ...a]) } catch (e) {
      if (!String((e as Error)?.message).includes('NOSCRIPT')) throw e
      return c.sendCommand<T>(['EVAL', this.src, ...a])
    }
  }
}

// ---- sessions ------------------------------------------------------------------------------------------------
// s:<sid> hash {rev, data (v8 structured clone, base64), created, seen, ver}; c:<cookie> → sid; sc:<sid> set of
// cookies; sx zset sid → last seen (flood cap + the sweep that fires `expired` exactly once cluster-wide);
// lock:<sid> the cross-server command lock. Times (seen, expiry) are Redis's clock (TIME), never a server's. ver counts saves: a cached Session is refreshed only by a newer one.
const DEL_SESSION = `
local function del(p, sid)
  local sc = p .. 'sc:' .. sid
  for _, c in ipairs(redis.call('SMEMBERS', sc)) do redis.call('DEL', p .. 'c:' .. c) end
  redis.call('DEL', sc, p .. 's:' .. sid)
  redis.call('ZREM', p .. 'sx', sid)
end`
const LOAD = new Script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local p, sid, ttl = ARGV[1], ARGV[2], tonumber(ARGV[5])
if sid == '' then sid = redis.call('GET', p .. 'c:' .. ARGV[3]); if not sid then return false end end
local k = p .. 's:' .. sid
local h = redis.call('HMGET', k, 'rev', 'data', 'created', 'seen', 'ver')
if not h[1] then return false end
if now - tonumber(h[4]) > ttl then return false end
if ARGV[6] == '1' then
  redis.call('HSET', k, 'seen', now)
  redis.call('PEXPIRE', k, ttl)
  redis.call('ZADD', p .. 'sx', now, sid)
  local sc = p .. 'sc:' .. sid
  for _, c in ipairs(redis.call('SMEMBERS', sc)) do redis.call('PEXPIRE', p .. 'c:' .. c, ttl) end
  redis.call('PEXPIRE', sc, ttl)
  h[4] = tostring(now)
end
return {sid, h[1], h[2], h[3], h[4], h[5]}`)
const CREATE = new Script(`${DEL_SESSION}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local p, sid, ttl, max = ARGV[1], ARGV[2], tonumber(ARGV[4]), tonumber(ARGV[5])
local k = p .. 's:' .. sid
redis.call('HSET', k, 'rev', 0, 'data', ARGV[6], 'created', now, 'seen', now, 'ver', 0)
redis.call('PEXPIRE', k, ttl)
redis.call('ZADD', p .. 'sx', now, sid)
local out = {}
local n = redis.call('ZCARD', p .. 'sx') - max
if n > 0 then
  for _, old in ipairs(redis.call('ZRANGE', p .. 'sx', 0, n)) do
    if old ~= sid and #out < n then del(p, old); table.insert(out, old) end
  end
end
return out`)
const SAVE = new Script(`
local k = ARGV[1] .. 's:' .. ARGV[2]
if redis.call('EXISTS', k) == 0 then return false end
redis.call('HSET', k, 'rev', ARGV[3], 'data', ARGV[4])
return redis.call('HINCRBY', k, 'ver', 1)`)
// rev + 1 only; ver + 1 so every server's cached copy reloads (rev and data) on its next read
const BUMP_REV = new Script(`
local k = ARGV[1] .. 's:' .. ARGV[2]
if redis.call('EXISTS', k) == 0 then return false end
redis.call('HINCRBY', k, 'ver', 1)
return redis.call('HINCRBY', k, 'rev', 1)`)
const COOKIE = new Script(`
local p, sid, ttl = ARGV[1], ARGV[2], tonumber(ARGV[4])
if redis.call('EXISTS', p .. 's:' .. sid) == 0 then return false end
local sc = p .. 'sc:' .. sid
local have = redis.call('SRANDMEMBER', sc)
if have then return have end
redis.call('SET', p .. 'c:' .. ARGV[3], sid, 'PX', ttl)
redis.call('SADD', sc, ARGV[3])
redis.call('PEXPIRE', sc, ttl)
return ARGV[3]`)
const ROTATE = new Script(`${DEL_SESSION}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local p, old, new, ttl = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[5])
local h = redis.call('HMGET', p .. 's:' .. old, 'rev', 'data', 'created', 'ver')
if not h[1] then return false end
del(p, old)
local k = p .. 's:' .. new
redis.call('HSET', k, 'rev', h[1], 'data', h[2], 'created', h[3], 'seen', now, 'ver', tonumber(h[4]) + 1)
redis.call('PEXPIRE', k, ttl)
redis.call('ZADD', p .. 'sx', now, new)
return tonumber(h[4]) + 1`)
const DELETE = new Script(`${DEL_SESSION}
if redis.call('EXISTS', ARGV[1] .. 's:' .. ARGV[2]) == 0 then return 0 end
del(ARGV[1], ARGV[2]); return 1`)
const SWEEP = new Script(`${DEL_SESSION}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local p, out = ARGV[1], {}
for _, sid in ipairs(redis.call('ZRANGEBYSCORE', p .. 'sx', '-inf', now - tonumber(ARGV[2]), 'LIMIT', 0, ARGV[3])) do
  del(p, sid); table.insert(out, sid)
end
return out`)
const UNLOCK = new Script(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

const enc = (data: Map<string, unknown>) => serialize(data).toString('base64')
const dec = (b64: string) => deserialize(Buffer.from(b64, 'base64')) as Map<string, unknown>

export interface RedisSessionOptions extends SessionStoreOptions { alias: string; lockMs: number; log?: Log }

// The shared store: Redis holds the truth; this process keeps one Session object per sid it touched (the base
// class's maps), refreshed whenever Redis has a newer save. Lifecycle hooks fire once cluster-wide: `created` on
// the server that made the session, `expired` on the server whose sweep / flood cap / delete / rotate removed it.
export class RedisSessionStore extends SessionStore {
  private alias: string
  private lockMs: number
  private ver = new WeakMap<Session, number>()
  private prefix: string

  constructor(settings: Settings['session'], opts: RedisSessionOptions) {
    super(settings, opts)
    this.alias = opts.alias
    this.lockMs = opts.lockMs
    this.prefix = redis.key(opts.alias, 'sess', '')
  }

  private client() { return redis.get(this.alias) }
  private get ttl() { return this.settings.ttlMs }

  override async create(s: Session = newSession()): Promise<Session> {
    const evicted = await CREATE.run<string[]>(await this.client(), [], [this.prefix, s.sid, s.createdAt, this.ttl, this.settings.max ?? 100_000, enc(s.data)])
    for (const sid of evicted) this.evict(sid)   // #20 flood cap, cluster-wide: the oldest go, with their hooks
    this.cache(s, 0)
    this.created(s.sid)
    return s
  }

  override async resolve(key: SessionKey): Promise<Session | undefined> { return this.load(key, true) }
  override async peek(key: SessionKey): Promise<Session | undefined> { return this.load(key, false) }

  private async load(key: SessionKey, touch: boolean): Promise<Session | undefined> {
    const local = key.sid !== undefined ? this.once.get(key.sid) : undefined
    if (local) return local
    if (key.sid === undefined && key.cookie === undefined) return undefined
    const r = await LOAD.run<[string, string, string, string, string, string] | null>(await this.client(), [],
      [this.prefix, key.sid ?? '', key.cookie ?? '', Date.now(), this.ttl, touch ? 1 : 0])
    if (!r) {
      // gone in Redis (rotated, expired, deleted on any server): forget the cached copy, no hooks (the sweep fires them)
      const sid = this.sidOf(key)
      if (sid !== undefined) this.forget(sid)
      return undefined
    }
    const [sid, rev, data, created, seen, ver] = r
    if (this.tooOld(Number(created))) { await this.delete(sid); return undefined }
    let s = this.byId.get(sid)
    if (!s) s = this.cache({ sid, rev: Number(rev), data: dec(data), createdAt: Number(created), lastSeen: Number(seen) }, Number(ver))
    else {
      if (Number(ver) > (this.ver.get(s) ?? -1)) { s.rev = Number(rev); s.data = dec(data); this.ver.set(s, Number(ver)) }
      s.lastSeen = Number(seen)
      this.byId.delete(sid); this.byId.set(sid, s)
    }
    if (key.cookie !== undefined && key.sid === undefined) this.link(key.cookie, sid)
    return s
  }

  private cache(s: Session, ver: number): Session {
    this.adopt(s)
    this.ver.set(s, ver)
    // the local map is only a cache: past the cap the least recently used copy is dropped (Redis keeps it)
    while (this.byId.size > (this.settings.max ?? 100_000)) this.forget(this.byId.keys().next().value as Sid)
    return s
  }

  override async cookieFor(sid: Sid): Promise<string> {
    const c = await COOKIE.run<string | null>(await this.client(), [], [this.prefix, sid, nanoid(), this.ttl])
    if (!c) throw new Error('cookieFor: unknown sid')
    this.link(c, sid)
    return c
  }

  override async save(s: Session): Promise<void> {
    const ver = await SAVE.run<number | null>(await this.client(), [], [this.prefix, s.sid, s.rev, enc(s.data)])
    if (ver !== null) this.ver.set(s, Number(ver))
  }

  override async bumpRev(sid: Sid): Promise<Rev | undefined> {
    const rev = await BUMP_REV.run<number | null>(await this.client(), [], [this.prefix, sid])
    if (rev === null) return undefined
    const s = this.byId.get(sid)
    if (s) s.rev = Number(rev)   // its ver stays behind: the next load refreshes the data too
    return Number(rev)
  }

  override async rotate(old: Session): Promise<Session> {
    if (this.once.get(old.sid) === old) return this.rotateDeferred(old)
    if (this.byId.get(old.sid) !== old) throw new Error('rotate: unknown sid')
    const s: Session = { ...old, sid: nanoid(), data: old.data, lastSeen: Date.now() }
    const ver = await ROTATE.run<number | null>(await this.client(), [], [this.prefix, old.sid, s.sid, s.lastSeen, this.ttl])
    if (ver === null) throw new Error('rotate: session is gone')
    this.ver.set(s, Number(ver))
    return this.rotated(old, s)
  }

  // the cached object is current (refreshed from Redis) and its sid still exists there
  override async isLive(s: Session): Promise<boolean> {
    if (this.once.get(s.sid) === s) return true
    if (this.byId.get(s.sid) !== s) return false
    return (await this.load({ sid: s.sid }, false)) === s
  }

  override async delete(sid: Sid): Promise<void> {
    const n = await DELETE.run<number>(await this.client(), [], [this.prefix, sid])
    if (n || this.byId.has(sid)) this.evict(sid)
  }

  override async sweep(): Promise<number> {
    const now = Date.now()
    let n = 0
    for (;;) {   // the claimed ones are this server's to announce; 500 per round trip
      const gone = await SWEEP.run<string[]>(await this.client(), [], [this.prefix, this.ttl, 500])
      for (const sid of gone) this.evict(sid)
      n += gone.length
      if (gone.length < 500) break
    }
    for (const s of [...this.byId.values()]) if (now - s.lastSeen > this.ttl) this.forget(s.sid)   // stale cache copies
    return n
  }

  // SET NX PX with a random token; waits (10 → 50 ms steps) up to the lock's own TTL, then gives up (rate_limited)
  override async lock<T>(sid: Sid, fn: () => Promise<T>): Promise<T> {
    const c = await this.client()
    const key = `${this.prefix}lock:${sid}`, token = randomBytes(12).toString('hex')
    const until = Date.now() + this.lockMs
    for (let wait = 10; ; wait = Math.min(50, wait * 2)) {
      if (await c.sendCommand(['SET', key, token, 'NX', 'PX', String(this.lockMs)]) === 'OK') break
      if (Date.now() > until) throw new SessionBusy()
      await new Promise((ok) => setTimeout(ok, wait))
    }
    try { return await fn() } finally { await UNLOCK.run(c, [key], [token]).catch(() => undefined) }
  }
}

// ---- channels ------------------------------------------------------------------------------------------------
// send: one script INCRs the layer-wide seq, appends to the group's stream (ch:g:<name>, the last RING events,
// id <seq>-0) and PUBLISHes `<seq>:<json {g,e}>` on ch. Every server holds ONE subscription to ch and fans an event
// out to its own subscribers of that group — including the sender's, so all servers see one order per group.
const SEND = new Script(`
local p = ARGV[1]
local seq = redis.call('INCR', p .. 'ch:seq')
local k = p .. 'ch:g:' .. ARGV[2]
redis.call('XADD', k, 'MAXLEN', ARGV[5], seq .. '-0', 'e', ARGV[3])
redis.call('PEXPIRE', k, ARGV[6])
redis.call('PUBLISH', p .. 'ch', seq .. ':' .. ARGV[4])
return seq`)
const STREAM_TTL_MS = 86_400_000   // a group nobody sends on for a day loses its replay buffer

export class RedisChannelLayer implements ChannelLayer {
  private subs = new Map<string, Set<(e: Event, seq: number) => void>>()
  private seq = 0
  private prefix: string
  private closed = false
  readonly ready: Promise<void>

  constructor(private alias: string, private log: Log = () => {}) {
    this.prefix = redis.key(alias, '')
    this.ready = this.listen()
    this.ready.catch(() => undefined)
  }

  private async listen(): Promise<void> {
    const sub = await redis.subscriber(this.alias)
    await sub.SUBSCRIBE(`${this.prefix}ch`, (msg) => this.deliver(msg))
  }

  private deliver(msg: string): void {
    if (this.closed) return
    const i = msg.indexOf(':')
    const seq = Number(msg.slice(0, i))
    let env: { g: string; e: Event }
    try { env = JSON.parse(msg.slice(i + 1)) } catch { return }
    if (seq > this.seq) this.seq = seq
    const set = this.subs.get(env.g)
    if (!set) return
    for (const fn of [...set]) { try { fn(env.e, seq) } catch { /* a subscriber's own problem */ } }
  }

  group(name: string) {
    return {
      add: (fn: (e: Event, seq: number) => void): (() => void) => {
        let set = this.subs.get(name)
        if (!set) this.subs.set(name, (set = new Set()))
        set.add(fn)
        return () => { const s = this.subs.get(name); s?.delete(fn); if (s && !s.size) this.subs.delete(name) }
      },
      send: (e: Event): void => {
        void (async () => {
          await SEND.run(await redis.get(this.alias), [], [this.prefix, name, JSON.stringify(e), JSON.stringify({ g: name, e }), RING, STREAM_TTL_MS])
        })().catch((err: unknown) => this.log('error', 'channel send failed', { group: name.startsWith('sid:') ? 'sid:…' : name, error: String((err as Error)?.message ?? err) }))
      },
      size: (): number => this.subs.get(name)?.size ?? 0,
      since: async (cursor: number): Promise<Replayed[]> => {
        if (!Number.isSafeInteger(cursor) || cursor < 0) return []
        const rows = await (await redis.get(this.alias)).sendCommand<[string, string[]][]>(['XRANGE', `${this.prefix}ch:g:${name}`, `(${cursor}-0`, '+'])
        const out: Replayed[] = []
        for (const [id, fields] of rows) { try { out.push({ seq: Number(id.split('-')[0]), e: JSON.parse(fields[1]!) as Event }) } catch { /* skip a bad row */ } }
        return out
      },
    }
  }

  head(): number { return this.seq }

  drop(name: string): void {
    this.subs.delete(name)
    void redis.get(this.alias).then((c) => c.sendCommand(['DEL', `${this.prefix}ch:g:${name}`])).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    this.subs.clear()
    try { await (await redis.subscriber(this.alias)).UNSUBSCRIBE(`${this.prefix}ch`) } catch { /* already closed */ }
  }
}

// ---- rate limits ---------------------------------------------------------------------------------------------
// The memory limiter's token bucket (continuous refill = a sliding window without per-request entries), as one
// script over every bucket of the check: all-or-nothing, on Redis's clock (servers' clocks never disagree).
const RATE = new Script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local retry, toks = 0, {}
for i, k in ipairs(KEYS) do
  local limit, win = tonumber(ARGV[2 * i - 1]), tonumber(ARGV[2 * i])
  local b = redis.call('HMGET', k, 't', 'a')
  local tokens = tonumber(b[1]) or limit
  local at = tonumber(b[2]) or now
  tokens = math.min(limit, tokens + math.max(0, now - at) * limit / win)
  toks[i] = tokens
  if tokens < 1 then retry = math.max(retry, math.ceil((1 - tokens) * win / limit)) end
end
for i, k in ipairs(KEYS) do
  local tk = toks[i]
  if retry == 0 then tk = tk - 1 end
  redis.call('HSET', k, 't', string.format('%.17g', tk), 'a', now)
  redis.call('PEXPIRE', k, ARGV[2 * i])
end
return retry`)

export class RedisRateLimiter implements Limiter {
  constructor(private alias: string, private defaults: { limit: number; windowMs: number }) { checkRate('settings.limits.rate', defaults) }
  async check(keys: RateKeys, rules?: ActionRules['rate']): Promise<RateResult> {
    const b = bucketsFor(keys, rules, this.defaults)
    if (!b.length) return { ok: true }
    const retry = await RATE.run<number>(await redis.get(this.alias), b.map((x) => redis.key(this.alias, 'rl', x.ip ? 'ip' : 'sid', x.key)), b.flatMap((x) => [x.rate.limit, x.rate.windowMs]))
    return retry > 0 ? { ok: false, retryAfterMs: Number(retry) } : { ok: true }
  }
}

// ---- idempotency ---------------------------------------------------------------------------------------------
// idem:<sha1(sid, cmdId)> → {h: params hash, j: events json}, kept for ttlMs; …:run while a server runs it.
// ponytail: no per-sid cap (memory keeps 1000): Redis holds every cmdId for ttlMs, bounded by the rate limit.
export class RedisIdempotency implements Idempotency {
  constructor(private alias: string, private ttlMs: number) {}
  private key(sid: Sid, cmdId: string) { return redis.key(this.alias, 'idem', sha1(`${sid}\0${cmdId}`)) }
  async replay(sid: Sid, cmdId: string, paramsHash: string): Promise<Replay> {
    const v = await (await redis.get(this.alias)).sendCommand<string | null>(['GET', this.key(sid, cmdId)])
    if (!v) return { hit: false }
    const { h, j } = JSON.parse(v) as { h: string; j: string }
    return h !== paramsHash ? { hit: 'conflict' } : { hit: true, events: JSON.parse(j) as Event[] }
  }
  async remember(sid: Sid, cmdId: string, paramsHash: string, events: Event[]): Promise<void> {
    await (await redis.get(this.alias)).sendCommand(['SET', this.key(sid, cmdId), JSON.stringify({ h: paramsHash, j: JSON.stringify(events) }), 'PX', String(this.ttlMs)])
  }
  async claim(sid: Sid, cmdId: string, ttlMs: number): Promise<boolean> {
    return (await (await redis.get(this.alias)).sendCommand(['SET', `${this.key(sid, cmdId)}:run`, '1', 'NX', 'PX', String(ttlMs)])) === 'OK'
  }
  async release(sid: Sid, cmdId: string): Promise<void> {
    await (await redis.get(this.alias)).sendCommand(['DEL', `${this.key(sid, cmdId)}:run`])
  }
}

// ---- login throttle (contrib/auth/throttle.ts semantics, shared) ---------------------------------------------
const THROTTLE_FAIL = new Script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local win, lock = tonumber(ARGV[4]), tonumber(ARGV[5])
for i, k in ipairs(KEYS) do
  local e = redis.call('HMGET', k, 'c', 's', 'l')
  local c, s, l = tonumber(e[1]), tonumber(e[2]), tonumber(e[3])
  if not c or (l <= now and now - s > win) then c, s, l = 0, now, 0 end
  c = c + 1
  if c >= tonumber(ARGV[i]) then l = math.max(l, now + lock) end
  redis.call('HSET', k, 'c', c, 's', s, 'l', l)
  redis.call('PEXPIREAT', k, math.max(s + win, l) + 1000)
end
return 1`)
const THROTTLE_LOCKED = new Script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local win = tonumber(ARGV[1])
local function live(k)
  local e = redis.call('HMGET', k, 'c', 's', 'l')
  local c, s, l = tonumber(e[1]), tonumber(e[2]), tonumber(e[3])
  if c and (l > now or now - s <= win) then return {c = c, l = l} end
  return nil
end
local pair, acct, ip = live(KEYS[1]), live(KEYS[2]), live(KEYS[3])
local wait = 0
for _, e in ipairs({pair or false, ip or false}) do if e and e.l > now then wait = math.max(wait, e.l - now) end end
local failed = pair and (pair.c > 0 or pair.l > now)
if acct and acct.l > now and failed then wait = math.max(wait, acct.l - now) end
return wait`)

export interface ThrottleLike {
  locked(user: string, ip: string): number | Promise<number>
  fail(user: string, ip: string): void | Promise<void>
  succeed(user: string, ip: string): void | Promise<void>
}
export class RedisLoginThrottle implements ThrottleLike {
  constructor(private alias: string, private c: { maxFailures: number; accountMaxFailures: number; ipMaxFailures: number; windowMs: number; lockoutMs: number },
    private keysOf: (user: string, ip: string) => { pair: string; acct: string; ip: string }) {}
  // usernames never stored in clear: keys are hashes of the throttle's own keys
  private keys(user: string, ip: string) { const k = this.keysOf(user, ip); return [k.pair, k.acct, k.ip].map((x) => redis.key(this.alias, 'lt', sha1(x))) }
  async locked(user: string, ip: string): Promise<number> {
    return Number(await THROTTLE_LOCKED.run<number>(await redis.get(this.alias), this.keys(user, ip), [this.c.windowMs]))
  }
  async fail(user: string, ip: string): Promise<void> {
    await THROTTLE_FAIL.run(await redis.get(this.alias), this.keys(user, ip), [this.c.maxFailures, this.c.accountMaxFailures, this.c.ipMaxFailures, this.c.windowMs, this.c.lockoutMs])
  }
  async succeed(user: string, ip: string): Promise<void> {
    await (await redis.get(this.alias)).sendCommand(['DEL', this.keys(user, ip)[0]!])
  }
}

// ---- tab agent marks (transport/tab.ts forcedAgent, shared) --------------------------------------------------
// tabmark:<sha1(sid)> zset: one member per process (its marking's end, Redis clock). A process clearing its own
// marking never shortens another's (two workers forwarding commands of one session at once).
const MARK_SET = new Script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ms = tonumber(ARGV[2])
if ms > 0 then redis.call('ZADD', KEYS[1], now + ms, ARGV[1]) else redis.call('ZREM', KEYS[1], ARGV[1]) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
if top[2] then redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(top[2]) - now)) end
return 1`)
const MARK_HAS = new Script(`
local t = redis.call('TIME')
return redis.call('ZCOUNT', KEYS[1], '(' .. (tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)), '+inf')`)
export class RedisAgentMarks {
  private me = randomBytes(8).toString('hex')
  constructor(private alias: string) {}
  private key(sid: Sid) { return redis.key(this.alias, 'tabmark', sha1(sid)) }
  async set(sid: Sid, ms: number): Promise<void> { await MARK_SET.run(await redis.get(this.alias), [this.key(sid)], [this.me, Math.max(0, Math.ceil(ms))]) }
  async has(sid: Sid): Promise<boolean> { return Number(await MARK_HAS.run(await redis.get(this.alias), [this.key(sid)], [])) > 0 }
}

// ---- snapshot cache ------------------------------------------------------------------------------------------
// snap:<sha1(route)> hash {etag, body, ver} for ttlMs; snap:ver is the shared data version (every committed write
// on any server INCRs it, core/registry.ts SnapshotCache semantics). An entry is served only at the current ver.
const SNAP_GET = new Script(`
local v = redis.call('GET', KEYS[2]) or '0'
local h = redis.call('HMGET', KEYS[1], 'etag', 'body', 'ver')
if not h[1] then return false end
if h[3] ~= v then redis.call('DEL', KEYS[1]); return false end
return {h[1], h[2]}`)
const SNAP_SET = new Script(`
local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'etag', ARGV[2], 'body', ARGV[3], 'ver', v)
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`)

export class RedisSnapshotCache implements SnapshotStore {
  private pending = new Set<Promise<unknown>>()
  private off: () => void
  constructor(private alias: string, private ttlMs: number, onWrite: (fn: () => void) => () => void, private log: Log = () => {}) {
    this.off = onWrite(() => {
      const p = redis.get(this.alias).then((c) => c.sendCommand(['INCR', this.verKey]))
        .catch((e: unknown) => this.log('error', 'snapshot cache invalidation failed', { error: String((e as Error)?.message ?? e) }))
        .finally(() => this.pending.delete(p))
      this.pending.add(p)
    })
  }
  private get verKey() { return redis.key(this.alias, 'snap', 'ver') }
  private key(route: string) { return redis.key(this.alias, 'snap', sha1(route)) }
  async version(): Promise<number> { return Number(await (await redis.get(this.alias)).sendCommand<string | null>(['GET', this.verKey]) ?? 0) }
  async get(route: string): Promise<{ etag: string; body: SnapBody } | undefined> {
    if (this.ttlMs <= 0) return undefined
    const r = await SNAP_GET.run<[string, string] | null>(await redis.get(this.alias), [this.key(route), this.verKey], [])
    return r ? { etag: r[0], body: JSON.parse(r[1]) as SnapBody } : undefined
  }
  async set(route: string, snap: SnapBody | Snapshot, ver?: number): Promise<string> {
    const { etag, body } = cacheBody(snap)
    if (this.ttlMs <= 0) return etag
    await SNAP_SET.run(await redis.get(this.alias), [this.key(route), this.verKey], [ver ?? await this.version(), etag, JSON.stringify(body), this.ttlMs])
    return etag
  }
  // this process's writes are counted in Redis (dispatch awaits it before replying)
  async settle(): Promise<void> { await Promise.all([...this.pending]) }
  close(): void { this.off() }
}

