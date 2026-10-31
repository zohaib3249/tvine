// Login throttling + lockout (docs/design/contrib/auth.md §3). Three tiers over one fixed window of failures:
// (username, ip) pair, username from any ip, ip for any username. Keyed by the lower-cased name AS TYPED, so an
// unknown name locks exactly like a real one (no enumeration). The pair tier means one attacker ip cannot lock
// a victim out; the account tier still stops a distributed guess.
// ponytail: in-process (single process v1, like every limiter); a shared store comes with Redis (BACKLOG #12)
import type { Settings } from '../../core/types.js'

interface Entry { count: number; since: number; lockedUntil: number }
const CAP = 100_000

export class LoginThrottle {
  private m = new Map<string, Entry>()   // insertion order = LRU
  constructor(private c: { maxFailures: number; accountMaxFailures: number; ipMaxFailures: number; windowMs: number; lockoutMs: number }) {}

  private keys(user: string, ip: string): [string, number][] {
    const u = user.trim().toLowerCase()
    return [[`p\0${u}\0${ip}`, this.c.maxFailures], [`u\0${u}`, this.c.accountMaxFailures], [`i\0${ip}`, this.c.ipMaxFailures]]
  }

  // ms until any tier unlocks; 0 = free
  locked(user: string, ip: string, now = Date.now()): number {
    let wait = 0
    for (const [k] of this.keys(user, ip)) {
      const e = this.m.get(k)
      if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now)
    }
    return wait
  }

  fail(user: string, ip: string, now = Date.now()): void {
    for (const [k, max] of this.keys(user, ip)) {
      let e = this.m.get(k)
      if (!e || now - e.since > this.c.windowMs) e = { count: 0, since: now, lockedUntil: 0 }
      e.count++
      if (e.count >= max) { e.lockedUntil = now + this.c.lockoutMs; e.count = 0; e.since = now }
      this.m.delete(k); this.m.set(k, e)
      while (this.m.size > CAP) this.m.delete(this.m.keys().next().value as string)
    }
  }

  // a correct login clears this pair (and the account's count); the ip tier keeps counting other names
  succeed(user: string, ip: string): void {
    const [[pair], [acct]] = this.keys(user, ip)
    this.m.delete(pair!)
    const e = this.m.get(acct!)
    if (e && e.lockedUntil === 0) this.m.delete(acct!)
  }
}

const throttles = new WeakMap<Settings, LoginThrottle>()
export function throttleOf(s: Settings): LoginThrottle {
  let t = throttles.get(s)
  if (!t) {
    const l = s.auth?.login ?? {}
    throttles.set(s, (t = new LoginThrottle({
      maxFailures: l.maxFailures ?? 5, accountMaxFailures: l.accountMaxFailures ?? 50, ipMaxFailures: l.ipMaxFailures ?? 100,
      windowMs: l.windowMs ?? 15 * 60_000, lockoutMs: l.lockoutMs ?? 15 * 60_000,
    })))
  }
  return t
}
