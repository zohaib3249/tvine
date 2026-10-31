// Login throttling + lockout (docs/design/contrib/auth.md §3). Failures in a fixed window, three tiers:
// - pair (username, ip): hard lock after maxFailures — one attacker cannot keep guessing one account;
// - ip: hard lock after ipMaxFailures — one attacker cannot spray many accounts;
// - account (username from any ip): after accountMaxFailures the account is "under attack": every pair that
//   has failed in the window is refused, but a pair with NO failures still gets its try. A distributed attack
//   gets one guess per new ip (/64); the victim, from an ip that never failed, can still sign in (no lockout DoS).
// Keys use the NFKC lower-cased name AS TYPED (unknown names lock exactly like real ones: no enumeration) and
// ips grouped like the rate limiter (IPv6 by /64, so rotating addresses inside a /64 does not reset anything).
// settings.limits.backend: 'memory' = LoginThrottle (per process), 'redis' = backends/redis.ts (same rules, shared).
import type { Settings } from '../../core/types.js'
import { ipKey } from '../../security/ratelimit.js'
import { RedisLoginThrottle, type ThrottleLike } from '../../backends/redis.js'

interface Entry { count: number; since: number; lockedUntil: number }
export interface ThrottleConfig { maxFailures: number; accountMaxFailures: number; ipMaxFailures: number; windowMs: number; lockoutMs: number }

export const normName = (u: string) => u.normalize('NFKC').trim().toLowerCase()

export class LoginThrottle implements ThrottleLike {
  private m = new Map<string, Entry>()   // insertion order = LRU
  constructor(private c: ThrottleConfig, private cap = 100_000) {}

  private keys(user: string, ip: string) { return throttleKeys(user, ip) }
  private live(k: string, now: number): Entry | undefined {
    const e = this.m.get(k)
    return e && (e.lockedUntil > now || now - e.since <= this.c.windowMs) ? e : undefined
  }

  // ms until this (user, ip) may try again; 0 = free
  locked(user: string, ip: string, now = Date.now()): number {
    const k = this.keys(user, ip)
    const pair = this.live(k.pair, now), acct = this.live(k.acct, now), byIp = this.live(k.ip, now)
    let wait = 0
    for (const e of [pair, byIp]) if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now)
    const pairFailed = !!pair && (pair.count > 0 || pair.lockedUntil > now)
    if (acct && acct.lockedUntil > now && pairFailed) wait = Math.max(wait, acct.lockedUntil - now)
    return wait
  }

  fail(user: string, ip: string, now = Date.now()): void {
    const k = this.keys(user, ip)
    for (const [key, max] of [[k.pair, this.c.maxFailures], [k.acct, this.c.accountMaxFailures], [k.ip, this.c.ipMaxFailures]] as const) {
      let e = this.m.get(key)
      if (!e || (e.lockedUntil <= now && now - e.since > this.c.windowMs)) e = { count: 0, since: now, lockedUntil: 0 }
      e.count++
      if (e.count >= max) e.lockedUntil = Math.max(e.lockedUntil, now + this.c.lockoutMs)
      this.m.delete(key); this.m.set(key, e)
    }
    this.evict(now)
  }

  // a correct sign-in clears its pair; the account and ip tiers keep counting (an attack elsewhere goes on)
  succeed(user: string, ip: string): void { this.m.delete(this.keys(user, ip).pair) }

  // oldest first, but a running lock is never dropped (eviction must not be a way to unlock)
  private evict(now: number): void {
    if (this.m.size <= this.cap) return
    for (const [k, e] of this.m) {
      if (this.m.size <= this.cap) return
      if (e.lockedUntil <= now) this.m.delete(k)
    }
  }
  get size(): number { return this.m.size }
}

export function throttleKeys(user: string, ip: string) {
  const u = normName(user), i = ipKey(ip)
  return { pair: `p\0${u}\0${i}`, acct: `u\0${u}`, ip: `i\0${i}` }
}

const throttles = new WeakMap<Settings, ThrottleLike>()
export function throttleOf(s: Settings): ThrottleLike {
  let t = throttles.get(s)
  if (!t) {
    const l = s.auth?.login ?? {}
    const c = {
      maxFailures: l.maxFailures ?? 5, accountMaxFailures: l.accountMaxFailures ?? 50, ipMaxFailures: l.ipMaxFailures ?? 100,
      windowMs: l.windowMs ?? 15 * 60_000, lockoutMs: l.lockoutMs ?? 15 * 60_000,
    }
    throttles.set(s, (t = s.limits?.backend === 'redis' ? new RedisLoginThrottle(s.limits.redis, c, throttleKeys) : new LoginThrottle(c)))
  }
  return t
}
