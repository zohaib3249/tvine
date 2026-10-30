import { nanoid } from 'nanoid'
import type { ChannelLayer, Event, Rev, Session, Settings, Sid, Snapshot } from './types.js'
import { MemoryChannelLayer } from './channels.js'
import { ev } from './events.js'
import { dataVersion } from '../data/engine.js'

export const SNAP_CAP = 5000, SNAP_PER_SID = 8

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
  private watchers: ((sid: Sid, kind: 'created' | 'expired') => void)[] = []
  // progressive-disclosure.md §expand: the last snapshot each sid saw of a page (expand serves L2 from it).
  // ONE LRU keyed `sid\0page` (total cap SNAP_CAP, SNAP_PER_SID per sid); a key always names its sid, so a
  // session never reads another's entry. Dropped with the session.
  private snaps = new Map<string, { snap: Snapshot; data: number }>()
  private snapCount = new Map<Sid, number>()
  private once = new Map<Sid, Session>()   // ephemeral(): outside the flood cap, cookies and session hooks

  constructor(private settings: Settings['session'], opts: SessionStoreOptions = {}) {
    this.channels = opts.channels ?? new MemoryChannelLayer()
    this.onEvict = opts.onEvict
  }

  // byId's insertion order is recency (resolve re-inserts), so the first key is the least recently used
  create(): Session {
    const now = Date.now()
    const s: Session = { sid: nanoid(), rev: 0, data: new Map(), createdAt: now, lastSeen: now }
    while (this.byId.size >= this.settings.max) this.evict(this.byId.keys().next().value as Sid)   // #20: flood cap
    this.byId.set(s.sid, s)
    for (const w of this.watchers) w(s.sid, 'created')
    return s
  }

  // A session for one call only (an anonymous api read, an agent-render read): resolvable by sid until
  // dropEphemeral(), never stored by cookie, never counted against the flood cap, no session hooks.
  ephemeral(data: Map<string, unknown> = new Map()): Session {
    const now = Date.now()
    const s: Session = { sid: `ephemeral:${nanoid()}`, rev: 0, data, createdAt: now, lastSeen: now }
    this.once.set(s.sid, s)
    return s
  }
  dropEphemeral(sid: Sid): void { this.once.delete(sid) }

  resolve(key: { sid?: Sid; cookie?: string }): Session | undefined {
    const sid = key.sid ?? (key.cookie !== undefined ? this.byCookie.get(key.cookie) : undefined)
    if (sid === undefined) return undefined
    const e = this.once.get(sid)
    if (e) return e
    const s = this.byId.get(sid)
    if (!s) return undefined
    if (!this.alive(s)) {
      this.evict(sid) // lazy expiry
      return undefined
    }
    s.lastSeen = Date.now()
    this.byId.delete(sid); this.byId.set(sid, s)   // most recently used last
    return s
  }

  // Like resolve() but read-only: TTL-checked, never refreshes lastSeen or evicts (liveness polling).
  peek(key: { sid?: Sid; cookie?: string }): Session | undefined {
    const sid = key.sid ?? (key.cookie !== undefined ? this.byCookie.get(key.cookie) : undefined)
    const s = sid === undefined ? undefined : this.once.get(sid) ?? this.byId.get(sid)
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

  // Remember the snapshot `sid` was just shown (rendered for that sid), with the data version it saw.
  remember(snap: Snapshot, data = dataVersion()): void {
    if (!snap.sid || !this.byId.has(snap.sid)) return
    const k = `${snap.sid}\0${snap.page}`
    if (this.snaps.delete(k)) this.count(snap.sid, -1)
    if ((this.snapCount.get(snap.sid) ?? 0) >= SNAP_PER_SID) {   // this sid's oldest page
      for (const key of this.snaps.keys()) if (key.startsWith(`${snap.sid}\0`)) { this.dropSnap(key); break }
    }
    this.snaps.set(k, { snap, data })
    this.count(snap.sid, 1)
    if (this.snaps.size > SNAP_CAP) this.dropSnap(this.snaps.keys().next().value as string)
  }

  // The cached snapshot of `page` for `sid`, only while the session is at that rev and no data was written since.
  recall(sid: Sid, page: string, data = dataVersion()): Snapshot | undefined {
    const k = `${sid}\0${page}`, e = this.snaps.get(k), s = this.byId.get(sid)
    if (!s || !e || e.snap.rev !== s.rev || e.data !== data) return undefined
    this.snaps.delete(k); this.snaps.set(k, e)   // LRU touch
    return e.snap
  }

  get snapSize(): number { return this.snaps.size }

  private count(sid: Sid, d: number) {
    const n = (this.snapCount.get(sid) ?? 0) + d
    if (n > 0) this.snapCount.set(sid, n); else this.snapCount.delete(sid)
  }
  private dropSnap(k: string) {
    if (this.snaps.delete(k)) this.count(k.slice(0, k.indexOf('\0')), -1)
  }

  get size(): number { return this.byId.size }

  // Drop a session now (e.g. one created for a render that was then refused): the normal evict path.
  delete(sid: Sid): void { if (this.byId.has(sid)) this.evict(sid) }

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
    for (const k of this.snaps.keys()) if (k.startsWith(`${sid}\0`)) this.dropSnap(k)   // ponytail: scan on evict; index by sid if SNAP_CAP grows
    for (const c of this.cookiesBySid.get(sid) ?? []) this.byCookie.delete(c)
    this.cookiesBySid.delete(sid)
    this.channels.drop(`sid:${sid}`)
    this.onEvict?.(sid)
    for (const w of this.watchers) w(sid, 'expired')
  }

  // Lifecycle observer (the `session` hook). The watcher must not throw (Hooks.emit isolates).
  watch(fn: (sid: Sid, kind: 'created' | 'expired') => void): () => void {
    this.watchers.push(fn)
    return () => { this.watchers = this.watchers.filter((w) => w !== fn) }
  }
}
