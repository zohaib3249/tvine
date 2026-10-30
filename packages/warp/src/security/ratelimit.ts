import { isIPv6 } from 'node:net'
import type { ActionRules, Sid } from '../core/types.js'

// security/ratelimit: token buckets, lazy refill on check (no timers).
// ponytail: in-process buckets; put a CDN/WAF in front for distributed abuse
type Rate = { limit: number; windowMs: number }
type Bucket = { tokens: number; at: number }

const CAP = 10_000           // LRU cap per map (ip buckets; sid buckets too, for now)
const IP_WINDOW_MULT = 5     // IP bucket is stricter: same limit spread over 5× the window

export class RateLimiter {
  private ips = new Map<string, Bucket>()   // Map insertion order = LRU order
  private sids = new Map<string, Bucket>()

  constructor(private defaults: Rate) { checkRate('settings.limits.rate', defaults) }

  // `action` (dispatch passes it once the action is known) gives an action-level rate its own
  // bucket per sid+action, so two actions with equal rates never share one.
  // No ip = only the sid bucket (dispatch checks ip + default sid bucket first, then the action's own).
  check(keys: { sid?: Sid; ip?: string; action?: string }, rules?: ActionRules['rate']):
    | { ok: true }
    | { ok: false; retryAfterMs: number } {
    const now = Date.now()
    const picks: [Map<string, Bucket>, string, Rate][] = keys.ip === undefined ? [] : [[
      this.ips, ipKey(keys.ip),
      { limit: this.defaults.limit, windowMs: this.defaults.windowMs * IP_WINDOW_MULT },
    ]]
    if (keys.sid) {
      // action-level rate gets its own bucket per sid, so other actions keep the default
      picks.push(rules
        ? [this.sids, `${keys.sid}|${keys.action ?? ''}|${rules.limit}/${rules.windowMs}`, rules]
        : [this.sids, keys.sid, this.defaults])
    }
    let retryAfterMs = 0
    const buckets = picks.map(([map, key, rate]) => {
      const b = this.refill(map, key, rate, now)
      if (b.tokens < 1) retryAfterMs = Math.max(retryAfterMs, Math.ceil((1 - b.tokens) * rate.windowMs / rate.limit))
      return b
    })
    if (retryAfterMs) return { ok: false, retryAfterMs }
    for (const b of buckets) b.tokens -= 1
    return { ok: true }
  }

  private refill(map: Map<string, Bucket>, key: string, rate: Rate, now: number): Bucket {
    const b = map.get(key) ?? { tokens: rate.limit, at: now }
    map.delete(key)
    b.tokens = Math.min(rate.limit, b.tokens + (now - b.at) * rate.limit / rate.windowMs)
    b.at = now
    map.set(key, b)
    if (map.size > CAP) map.delete(map.keys().next().value!)
    return b
  }
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
