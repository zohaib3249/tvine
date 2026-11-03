import { isIPv6 } from 'node:net'
import type { ActionRules, Sid } from '../core/types.js'

// security/ratelimit: token buckets, lazy refill on check (no timers).
// ponytail: in-process buckets; put a CDN/WAF in front for distributed abuse
type Rate = { limit: number; windowMs: number }
type Bucket = { tokens: number; at: number }

const CAP = 10_000           // buckets kept per generation (ip map; sid map): 10k..20k live per map
const IP_WINDOW_MULT = 5     // IP bucket is stricter: same limit spread over 5× the window

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number }
export type RateKeys = { sid?: Sid; ip?: string; action?: string }
export type RateItem = { keys: RateKeys; rules?: ActionRules['rate'] }
// settings.limits.backend: 'memory' = RateLimiter (this file), 'redis' = backends/redis.ts (same algorithm, atomic Lua).
// THE per-request contract (both stores): dispatch makes ONE checkAll per command (core/dispatch.ts step 3), with
//   [{ keys: { ip, sid? } }]                                  the ip bucket + the session's default bucket (3a)
//   + { keys: { sid, action }, rules }                        an action's own rate (3b), when it has one
//   + { keys: { ip } }                                        a cookie-less api call's first contact (transport/api.ts)
// The buckets are the union of bucketsFor() over the items (a bucket listed twice is charged twice); all-or-nothing:
// any bucket short → nothing is charged, retryAfterMs = the longest wait. check(k, r) === checkAll([{ keys: k, rules: r }]).
// A session that is not stored (ephemeral / deferred: an anonymous call) has no sid bucket: dispatch keys it by ip.
export interface Limiter {
  check(keys: RateKeys, rules?: ActionRules['rate']): RateResult | Promise<RateResult>
  checkAll?(items: RateItem[]): RateResult | Promise<RateResult>
}

// One call for every item (a store without checkAll: one check per item, in order, stopping at the first refusal).
export async function checkAll(l: Limiter, items: RateItem[]): Promise<RateResult> {
  if (!items.length) return { ok: true }
  if (l.checkAll) return l.checkAll(items)
  for (const i of items) { const r = await l.check(i.keys, i.rules); if (!r.ok) return r }
  return { ok: true }
}

export class RateLimiter implements Limiter {
  private ips = new Generations<Bucket>(CAP)
  private sids = new Generations<Bucket>(CAP)

  constructor(private defaults: Rate) { checkRate('settings.limits.rate', defaults) }

  // `action` (dispatch passes it once the action is known) gives an action-level rate its own
  // bucket per sid+action, so two actions with equal rates never share one.
  check(keys: RateKeys, rules?: ActionRules['rate']): RateResult { return this.checkAll([{ keys, rules }]) }

  checkAll(items: RateItem[]): RateResult {
    const now = Date.now()
    let retryAfterMs = 0
    const buckets: Bucket[] = []
    for (const it of items) {
      for (const { ip, key, rate } of bucketsFor(it.keys, it.rules, this.defaults)) {
        const b = this.refill(ip ? this.ips : this.sids, key, rate, now)
        // a bucket listed twice must hold two tokens
        const need = 1 + buckets.reduce((n, x) => n + (x === b ? 1 : 0), 0)
        if (b.tokens < need) retryAfterMs = Math.max(retryAfterMs, Math.ceil((need - b.tokens) * rate.windowMs / rate.limit))
        buckets.push(b)
      }
    }
    if (retryAfterMs) return { ok: false, retryAfterMs }
    for (const b of buckets) b.tokens -= 1
    return { ok: true }
  }

  // O(1): only the touched bucket refills (lazily, from its own last-seen time)
  private refill(map: Generations<Bucket>, key: string, rate: Rate, now: number): Bucket {
    let b = map.get(key)
    if (!b) { b = { tokens: rate.limit, at: now }; map.set(key, b); return b }   // a new client: a full bucket
    b.tokens = Math.min(rate.limit, b.tokens + (now - b.at) * rate.limit / rate.windowMs)
    b.at = now
    return b
  }
}

// Bounded map with approximate LRU in O(1): writes go to `cur`; once it holds `cap` keys it becomes `old` and the
// previous `old` is dropped whole. A key read from `old` moves back to `cur`. So the `cap` most recent keys are always
// kept and at most 2*cap live. (A delete+set LRU on one Map was O(evicted) per request: V8's Map iterator walks the
// deleted slots at the front, and a flood of fresh keys evicted on every request.)
// A forgotten bucket comes back full, as a new client's would.
export class Generations<V> {
  private cur = new Map<string, V>()
  private old = new Map<string, V>()
  constructor(private cap: number) {}
  get size() { return this.cur.size + this.old.size }
  get(key: string): V | undefined {
    const v = this.cur.get(key)
    if (v !== undefined || this.old.size === 0) return v
    const o = this.old.get(key)
    if (o !== undefined) { this.old.delete(key); this.set(key, o) }
    return o
  }
  set(key: string, v: V): void {
    if (this.cur.size >= this.cap && !this.cur.has(key)) { this.old = this.cur; this.cur = new Map() }
    this.cur.set(key, v)
  }
}

// A rate no client can reach (a lifted limit: a burst of 1M+ and a refill of 1M+/s): no bucket at all.
const unlimited = (r: Rate) => r.limit >= 1e6 && r.limit / r.windowMs >= 1000

// The buckets one check takes a token from (shared by every backend, so both count the same keys):
// the client ip's (same limit over IP_WINDOW_MULT x the window), and the sid's — default rate, or an action's own
// rate in a bucket of its own per sid + action, so other actions keep the default. An 'ephemeral:' sid (a one-call
// session) gets no sid bucket; unreachable rates get none either.
export function bucketsFor(keys: RateKeys, rules: ActionRules['rate'] | undefined, defaults: Rate): { ip: boolean; key: string; rate: Rate }[] {
  const out: { ip: boolean; key: string; rate: Rate }[] = []
  if (keys.ip !== undefined) {
    const rate = { limit: defaults.limit, windowMs: defaults.windowMs * IP_WINDOW_MULT }
    if (!unlimited(rate)) out.push({ ip: true, key: ipKey(keys.ip), rate })
  }
  if (keys.sid && !keys.sid.startsWith('ephemeral:')) {
    const b = rules
      ? { ip: false, key: `${keys.sid}|${keys.action ?? ''}|${rules.limit}/${rules.windowMs}`, rate: rules }
      : { ip: false, key: keys.sid, rate: defaults }
    if (!unlimited(b.rate)) out.push(b)
  }
  return out
}

// #20: one IPv6 client usually owns a whole /64, so per-address buckets would let it rotate freely;
// IPv6 is keyed by its /64 prefix (any spelling), IPv4 per address. Every IPv4-mapped form
// (::ffff:a.b.c.d, ::ffff:0102:0304, uncompressed too) is that IPv4 address, so one client has one key.
// ponytail: NAT64 (64:ff9b::/96) stays an IPv6 /64 — every IPv4 client behind one NAT64 gateway shares a
// bucket; unmap it too if a deployment sits behind NAT64.
export function ipKey(ip: string): string {
  if (!isIPv6(ip)) return ip
  const g = groups(ip.toLowerCase())
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.')
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

// the 8 16-bit groups of a valid IPv6 address (a dotted IPv4 tail is two groups)
function groups(ip: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  const v6 = dotted ? ip.slice(0, dotted.index) + [(+dotted[1]! << 8) | +dotted[2]!, (+dotted[3]! << 8) | +dotted[4]!].map((x) => x.toString(16)).join(':') : ip
  const [head, tail] = v6.split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return all.map((x) => parseInt(x, 16))
}

// Boot-time validation (manifest rules and settings defaults): a 0 limit or window would deny forever / divide by 0.
export function checkRate(id: string, r?: Rate): void {
  if (r && !(r.limit >= 1 && r.windowMs > 0)) {
    throw new Error(`${id}: invalid rate ${JSON.stringify(r)} (need limit >= 1 and windowMs > 0)`)
  }
}

// Pure size check; the transport passes the body length and maps 413 to the response.
export function bodyCap(bytes: number, cap: number): { ok: true } | { ok: false; status: 413 } {
  return bytes > cap ? { ok: false, status: 413 } : { ok: true }
}
