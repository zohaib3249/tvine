import { createHash } from 'node:crypto'
import type { Event, Sid } from '../core/types.js'

// security/idempotency: cmdId dedup. Replays return the ORIGINAL events (stored as JSON).
const CAP = 1000   // per sid

type Entry = { hash: string; at: number; json: string }
export type Replay = { hit: false } | { hit: true; events: Event[] } | { hit: 'conflict' }

// Canonical JSON (sorted keys) so equal params hash equally regardless of key order.
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v

export const hashParams = (params: unknown): string =>
  createHash('sha1').update(JSON.stringify(canon(params)) ?? 'null').digest('hex')

// settings.limits.backend: 'memory' = IdempotencyCache, 'redis' = backends/redis.ts. A shared store also
// claims a running sid:cmdId across servers (claim/release), so a retry on another server never runs it twice.
export interface Idempotency {
  replay(sid: Sid, cmdId: string, paramsHash: string): Replay | Promise<Replay>
  remember(sid: Sid, cmdId: string, paramsHash: string, events: Event[]): void | Promise<void>
  claim?(sid: Sid, cmdId: string, ttlMs: number): Promise<boolean>   // false: running on another server
  release?(sid: Sid, cmdId: string): Promise<void>
}

export class IdempotencyCache implements Idempotency {
  private bySid = new Map<Sid, Map<string, Entry>>()

  constructor(private ttlMs: number) {}

  remember(sid: Sid, cmdId: string, paramsHash: string, events: Event[]): void {
    let m = this.bySid.get(sid)
    if (!m) this.bySid.set(sid, (m = new Map()))
    m.delete(cmdId)
    m.set(cmdId, { hash: paramsHash, at: Date.now(), json: JSON.stringify(events) })
    if (m.size > CAP) m.delete(m.keys().next().value!)
  }

  replay(sid: Sid, cmdId: string, paramsHash: string): Replay {
    const m = this.bySid.get(sid)
    const e = m?.get(cmdId)
    if (!m || !e) return { hit: false }
    if (Date.now() - e.at > this.ttlMs) {
      m.delete(cmdId)
      return { hit: false }
    }
    if (e.hash !== paramsHash) return { hit: 'conflict' }
    m.delete(cmdId)
    m.set(cmdId, e)   // LRU touch
    return { hit: true, events: JSON.parse(e.json) }
  }
}
