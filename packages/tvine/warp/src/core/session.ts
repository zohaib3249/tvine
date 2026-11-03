import { nanoid } from 'nanoid'
import type { ChannelLayer, Event, Rev, Session, Settings, Sid, Snapshot } from './types.js'
import { MemoryChannelLayer } from './channels.js'
import { ev } from './events.js'
import { dataVersion } from '../data/engine.js'

export const SNAP_CAP = 5000, SNAP_PER_SID = 8
// A session nobody came back for yet (an API client that drops cookies mints one per mutation): these sit in an LRU of
// their own, so such a client costs at most FRESH_CAP sessions, not session.max for a whole day. A session counts as
// come back when it is resolved again at least FRESH_MS after it was made (later than its own first request).
// ponytail: time-based, not per-request; a client that returns within FRESH_MS is confirmed on its next call after that.
export const FRESH_CAP = 10_000, FRESH_MS = 1_000

// core-session.md: one store, two keys (sid for agents, cookie for humans), per-sid event group.
// The API is async because the store may be shared (settings.session.backend = 'redis', backends/redis.ts):
// this class is the in-process ('memory') store AND the local object cache a shared store builds on. Within one
// process a sid always maps to ONE Session object (isLive compares identity; dispatch stages data on it).
export interface SessionStoreOptions {
  channels?: ChannelLayer
  onEvict?: (sid: Sid) => void   // fired once per evicted sid (lets idempotency/ratelimit clean up)
}

export type SessionKey = { sid?: Sid; cookie?: string }

// THE session cookie's attributes (secreview M2): from settings only, never guessed per request.
export const cookieOpts = (s: Settings) =>
  ({ httpOnly: true as const, sameSite: s.session.sameSite, secure: s.session.secure, path: '/', maxAge: Math.floor(s.session.ttlMs / 1000) })
export function cookieHeader(s: Settings, value: string): string {
  const o = cookieOpts(s)
  return `${s.session.cookieName}=${value}; Path=/; Max-Age=${o.maxAge}; HttpOnly; SameSite=${o.sameSite[0]!.toUpperCase()}${o.sameSite.slice(1)}${o.secure ? '; Secure' : ''}`
}

export class SessionStore {
  protected byId = new Map<Sid, Session>()
  protected byCookie = new Map<string, Sid>()
  protected cookiesBySid = new Map<Sid, Set<string>>()
  protected channels: ChannelLayer
  private onEvict?: (sid: Sid) => void
  private watchers: ((sid: Sid, kind: 'created' | 'expired') => void)[] = []
  // progressive-disclosure.md §expand: the last snapshot each sid saw of a page (expand serves L2 from it).
  // ONE LRU keyed `sid\0page` (total cap SNAP_CAP, SNAP_PER_SID per sid); a key always names its sid, so a
  // session never reads another's entry. Dropped with the session. Always per process (a cache: a miss re-renders).
  private snaps = new Map<string, { snap: Snapshot; data: number }>()
  private snapCount = new Map<Sid, number>()
  protected once = new Map<Sid, Session>()   // ephemeral(): outside the flood cap, cookies and session hooks
  protected fresh = new Set<Sid>()            // created, not seen again yet (FRESH_CAP); insertion order = oldest first

  constructor(protected settings: Pick<Settings['session'], 'ttlMs'> & Partial<Settings['session']>, opts: SessionStoreOptions = {}) {
    this.channels = opts.channels ?? new MemoryChannelLayer()
    this.onEvict = opts.onEvict
  }

  // byId's insertion order is recency (resolve re-inserts), so the first key is the least recently used
  async create(): Promise<Session> {
    while (this.byId.size >= (this.settings.max ?? Infinity)) this.evict(this.byId.keys().next().value as Sid)   // #20: flood cap
    const s = this.adopt(newSession())
    this.created(s.sid)
    this.fresh.add(s.sid)
    if (this.fresh.size > FRESH_CAP) this.evict(this.fresh.values().next().value as Sid)
    return s
  }

  // A session for one call only (an anonymous api read, an agent-render read): resolvable by sid until
  // dropEphemeral(), never stored by cookie, never counted against the flood cap, no session hooks, never shared.
  ephemeral(data: Map<string, unknown> = new Map()): Session {
    const now = Date.now()
    const s: Session = { sid: `ephemeral:${nanoid()}`, rev: 0, data, createdAt: now, lastSeen: now }
    this.once.set(s.sid, s)
    return s
  }
  dropEphemeral(sid: Sid): void { this.once.delete(sid) }

  async resolve(key: SessionKey): Promise<Session | undefined> {
    const sid = this.sidOf(key)
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
    if (s.lastSeen - s.createdAt >= FRESH_MS) this.fresh.delete(sid)   // came back: a normal session from now on
    this.byId.delete(sid); this.byId.set(sid, s)   // most recently used last
    return s
  }

  // Like resolve() but read-only: TTL-checked, never refreshes lastSeen or evicts (liveness polling).
  async peek(key: SessionKey): Promise<Session | undefined> {
    const sid = this.sidOf(key)
    const s = sid === undefined ? undefined : this.once.get(sid) ?? this.byId.get(sid)
    return s && this.alive(s) ? s : undefined
  }

  protected sidOf(key: SessionKey): Sid | undefined {
    return key.sid ?? (key.cookie !== undefined ? this.byCookie.get(key.cookie) : undefined)
  }

  protected alive(s: Session): boolean {
    return Date.now() - s.lastSeen <= this.settings.ttlMs && !this.tooOld(s.createdAt)
  }
  // settings.session.maxAgeMs: an absolute lifetime on top of the sliding idle ttl (a busy session still ends).
  // Counted from the session's creation (a login rotation keeps it).
  protected tooOld(createdAt: number): boolean {
    const max = this.settings.maxAgeMs
    return max !== undefined && max > 0 && Date.now() - createdAt > max
  }

  link(cookie: string, sid: Sid): void {
    this.byCookie.set(cookie, sid)
    let set = this.cookiesBySid.get(sid)
    if (!set) this.cookiesBySid.set(sid, (set = new Set()))
    set.add(cookie)
  }

  // Reverse mapping; creates and links a cookie on first use.
  async cookieFor(sid: Sid): Promise<string> {
    const existing = this.cookiesBySid.get(sid)
    if (existing?.size) return existing.values().next().value as string
    if (!this.byId.has(sid)) throw new Error('cookieFor: unknown sid')
    const cookie = nanoid()
    this.link(cookie, sid)
    return cookie
  }

  // A committed change: rev + 1 (the session's data is saved with it), then the `update` event on its group.
  async bump(sid: Sid, source: 'human' | 'agent' = 'human', action?: string): Promise<Rev> {
    const s = this.byId.get(sid)
    if (!s) throw new Error('bump: unknown sid')
    s.rev++
    await this.save(s)
    this.channels.group(`sid:${sid}`).send(ev.update(sid, s.rev, source, action))
    return s.rev
  }

  // rev + 1 ONLY (the data is not written): for a writer outside the command path (the tasks progress relay), so it
  // can never overwrite a command's data. The new rev, or undefined when the session is gone. Memory: the object.
  async bumpRev(sid: Sid): Promise<Rev | undefined> {
    const s = this.once.get(sid) ?? this.byId.get(sid)
    if (!s) return undefined
    return ++s.rev
  }

  // Persist the session's data without a rev bump (a readOnly action may still write session.data).
  // Memory: the object IS the store.
  async save(_s: Session): Promise<void> {}

  // One command at a time per sid ACROSS servers (dispatch already serializes within a process). Memory: no-op.
  lock<T>(_sid: Sid, fn: () => Promise<T>): Promise<T> { return fn() }

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

  // sessions held by THIS process (a shared store: the ones cached here)
  get size(): number { return this.byId.size }

  // Session fixation (cycle the key): a NEW Session object (same data, rev) under a fresh sid. The old one is
  // evicted like an expired one (cookies, channel group, snapshots, limiter/idempotency via onEvict) and stays a
  // dead object: anyone still holding it (a command queued on the old sid) must re-check with isLive() and never
  // learns the new sid. The caller hands out the new sid / cookie.
  async rotate(old: Session): Promise<Session> {
    if (this.byId.get(old.sid) !== old) throw new Error('rotate: unknown sid')
    return this.rotated(old, { ...old, sid: nanoid(), data: old.data, lastSeen: Date.now() })
  }

  protected rotated(old: Session, s: Session): Session {
    this.evict(old.sid)
    old.data = new Map()   // the dead object keeps nothing
    this.byId.set(s.sid, s)
    this.created(s.sid)
    for (const r of this.rotations) r(old.sid, s.sid)
    return s
  }

  // old sid → new sid after a rotate() (state that must follow the session, e.g. the tab hub's agent marking).
  // Never hands the new sid to holders of the old one; listeners must not throw.
  private rotations: ((from: Sid, to: Sid) => void)[] = []
  onRotate(fn: (from: Sid, to: Sid) => void): () => void {
    this.rotations.push(fn)
    return () => { this.rotations = this.rotations.filter((r) => r !== fn) }
  }

  // Still the live session under its own sid (not rotated away, evicted or expired). A shared store also
  // re-reads it here, so a command that waited in the queue runs on the latest data and rev.
  async isLive(s: Session): Promise<boolean> { return this.liveHere(s) }
  protected liveHere(s: Session): boolean { return (this.once.get(s.sid) ?? this.byId.get(s.sid)) === s && this.alive(s) }

  // Drop a session now (e.g. one created for a render that was then refused): the normal evict path.
  async delete(sid: Sid): Promise<void> { if (this.byId.has(sid)) this.evict(sid) }

  // ponytail: full scan per call; caller runs it on an interval of ttl/4. Cap+cursor if sessions get numerous.
  async sweep(): Promise<number> {
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

  // put a session object in the local map (a shared store: loaded or created elsewhere)
  protected adopt(s: Session): Session {
    this.byId.set(s.sid, s)
    return s
  }
  protected created(sid: Sid): void { for (const w of this.watchers) w(sid, 'created') }

  // Forget a session HERE only (a shared store found it gone): cookies, snapshots; no hooks, no channel drop.
  protected forget(sid: Sid): void {
    this.byId.delete(sid)
    this.fresh.delete(sid)
    for (const k of this.snaps.keys()) if (k.startsWith(`${sid}\0`)) this.dropSnap(k)
    for (const c of this.cookiesBySid.get(sid) ?? []) this.byCookie.delete(c)
    this.cookiesBySid.delete(sid)
  }

  // The session ended (expired, evicted, rotated away, deleted): once, with hooks.
  protected evict(sid: Sid): void {
    this.forget(sid)
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

// lock() could not get the session within its time (another server holds it): dispatch answers rate_limited
export class SessionBusy extends Error { constructor() { super('session is busy on another server'); this.name = 'SessionBusy' } }

export function newSession(sid: Sid = nanoid()): Session {
  const now = Date.now()
  return { sid, rev: 0, data: new Map(), createdAt: now, lastSeen: now }
}
