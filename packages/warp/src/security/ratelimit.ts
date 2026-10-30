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
      this.ips, keys.ip,
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
