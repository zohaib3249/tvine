import { nanoid } from 'nanoid'
import type { ChannelLayer, Event, Rev, Session, Settings, Sid } from './types.js'
import { MemoryChannelLayer } from './channels.js'
import { ev } from './events.js'

// core-session.md: one store, two keys (sid for agents, cookie for humans), per-sid event group.
export interface SessionStoreOptions {
  channels?: ChannelLayer
  onEvict?: (sid: Sid) => void   // fired once per evicted sid (lets idempotency/ratelimit clean up)
}

export class SessionStore {
  private byId = new Map<Sid, Session>()
  private byCookie = new Map<string, Sid>()
  private cookiesBySid = new Map<Sid, Set<string>>()
  private channels: ChannelLayer
  private onEvict?: (sid: Sid) => void

  constructor(private settings: Settings['session'], opts: SessionStoreOptions = {}) {
    this.channels = opts.channels ?? new MemoryChannelLayer()
    this.onEvict = opts.onEvict
  }

  create(): Session {
    const now = Date.now()
    const s: Session = { sid: nanoid(), rev: 0, data: new Map(), createdAt: now, lastSeen: now }
    this.byId.set(s.sid, s)
    return s
  }

  resolve(key: { sid?: Sid; cookie?: string }): Session | undefined {
    const sid = key.sid ?? (key.cookie !== undefined ? this.byCookie.get(key.cookie) : undefined)
    if (sid === undefined) return undefined
    const s = this.byId.get(sid)
    if (!s) return undefined
    if (!this.alive(s)) {
      this.evict(sid) // lazy expiry
      return undefined
    }
    s.lastSeen = Date.now()
    return s
  }

  // Like resolve() but read-only: TTL-checked, never refreshes lastSeen or evicts (liveness polling).
  peek(key: { sid?: Sid; cookie?: string }): Session | undefined {
    const sid = key.sid ?? (key.cookie !== undefined ? this.byCookie.get(key.cookie) : undefined)
    const s = sid === undefined ? undefined : this.byId.get(sid)
    return s && this.alive(s) ? s : undefined
  }

  private alive(s: Session): boolean {
    return Date.now() - s.lastSeen <= this.settings.ttlMs
  }

  link(cookie: string, sid: Sid): void {
    this.byCookie.set(cookie, sid)
    let set = this.cookiesBySid.get(sid)
    if (!set) this.cookiesBySid.set(sid, (set = new Set()))
    set.add(cookie)
  }

  // Reverse mapping; creates and links a cookie on first use.
  cookieFor(sid: Sid): string {
    const existing = this.cookiesBySid.get(sid)
    if (existing?.size) return existing.values().next().value as string
    if (!this.byId.has(sid)) throw new Error(`cookieFor: unknown sid ${sid}`)
    const cookie = nanoid()
    this.link(cookie, sid)
    return cookie
  }

  bump(sid: Sid, source: 'human' | 'agent' = 'human'): Rev {
    const s = this.byId.get(sid)
    if (!s) throw new Error(`bump: unknown sid ${sid}`)
    s.rev++
    this.channels.group(`sid:${sid}`).send(ev.update(sid, s.rev, source))
    return s.rev
  }

  subscribe(sid: Sid, fn: (e: Event) => void): () => void {
    return this.channels.group(`sid:${sid}`).add(fn)
  }

  get size(): number { return this.byId.size }

  // ponytail: full scan per call; caller runs it on an interval of ttl/4. Cap+cursor if sessions get numerous.
  sweep(): number {
    const now = Date.now()
    let evicted = 0
    for (const s of [...this.byId.values()]) {
      if (now - s.lastSeen > this.settings.ttlMs) {
        this.evict(s.sid)
        evicted++
      }
    }
    return evicted
  }

  private evict(sid: Sid): void {
    this.byId.delete(sid)
    for (const c of this.cookiesBySid.get(sid) ?? []) this.byCookie.delete(c)
    this.cookiesBySid.delete(sid)
    this.channels.drop(`sid:${sid}`)
    this.onEvict?.(sid)
  }
}
