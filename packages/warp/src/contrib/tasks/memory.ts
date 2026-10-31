// memoryBroker: the job store in this process's memory (docs/design/contrib/tasks.md §Brokers) — dev and tests only.
// Same semantics as the file / redis brokers: every method runs synchronously (so it is one atomic step), claims
// fence with a token, delayed jobs wait in their own heap. Nothing survives a restart, and a separate process
// (`tvine worker`, `tvine tasks`) cannot see it: those refuse broker 'memory' loudly.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Broker, Claim, ChordSpec, Final, NewJob, QueueStats, SigJSON, WorkerInfo } from './broker.js'
import type { JobRow, JobStatus } from './models.js'
import { bus, checkClaim, shown, type Moved, type StoreStatus } from './shared.js'

type Row = { -readonly [K in keyof Omit<JobRow, 'status'>]: JobRow[K] } & { status: StoreStatus; ver: number }
interface Entry { id: string; ver: number; priority: number; runAt: number }

// a binary heap; stale entries (the row moved on: other ver / status) are dropped lazily when they reach the top
export class Heap<T> {
  private a: T[] = []
  constructor(private less: (x: T, y: T) => boolean) {}
  get size(): number { return this.a.length }
  peek(): T | undefined { return this.a[0] }
  push(v: T): void {
    const a = this.a
    a.push(v)
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (!this.less(a[i]!, a[p]!)) break
      ;[a[i], a[p]] = [a[p]!, a[i]!]; i = p
    }
  }
  pop(): T | undefined {
    const a = this.a, top = a[0], last = a.pop()
    if (a.length && last !== undefined) {
      a[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m]!, a[i]!]; i = m
      }
    }
    return top
  }
}

const readyFirst = (x: Entry, y: Entry) => x.priority !== y.priority ? x.priority > y.priority : x.runAt !== y.runAt ? x.runAt < y.runAt : x.id < y.id
const DEFAULTS = { result: null, error: null, attempts: 0, maxRetries: 3, leaseUntil: null, worker: null, token: null, acksLate: true, expiresAt: null, progress: null, message: null, sid: null, userId: null, groupId: null, groupIndex: null, chain: null, parentId: null, dupOf: null, uniqueKey: null, cancel: false, startedAt: null, finishedAt: null, purgeAt: null }
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

export function memoryBroker(): Broker { return new MemoryBroker() }

export class MemoryBroker implements Broker {
  private jobs = new Map<string, Row>()
  private ready = new Map<string, Heap<Entry>>()           // per queue
  private delayed = new Heap<Entry>((x, y) => x.runAt < y.runAt)
  private running = new Set<string>()
  private groups = new Map<string, { remaining: number; callback: SigJSON; status: 'pending' | 'fired' | 'failed'; purgeAt: number | null }>()
  private locks = new Map<string, { owner: string; expiresAt: number }>()
  private schedules = new Map<string, { spec: string; nextRunAt: number; lastRunAt: number | null }>()
  private workers = new Map<string, WorkerInfo & { startedAt: number; beatAt: number; running: number; processed: number }>()
  private ev = new EventEmitter()

  constructor() { this.ev.setMaxListeners(0) }

  private out(r: Row): JobRow { const { ver: _v, ...rest } = r; return clone({ ...rest, status: shown(r.status) }) }
  private wake(): void { setImmediate(() => { this.ev.emit('wake'); bus.emit('enqueued') }) }
  private moved(r: Row): void {
    if (!r.sid) return
    const m: Moved = { id: r.id, task: r.task, status: shown(r.status), progress: r.progress, message: r.message, sid: r.sid, userId: r.userId }
    setImmediate(() => this.ev.emit('moved', m))
  }
  // every status change goes through here: a new ver invalidates the row's old heap entries
  private place(r: Row, now = Date.now()): void {
    r.ver++
    this.running.delete(r.id)
    if (r.status === 'queued' && r.runAt > now) r.status = 'scheduled'
    if (r.status === 'scheduled') this.delayed.push({ id: r.id, ver: r.ver, priority: r.priority, runAt: r.runAt })
    else if (r.status === 'queued') this.heap(r.queue).push({ id: r.id, ver: r.ver, priority: r.priority, runAt: r.runAt })
    else if (r.status === 'running') this.running.add(r.id)
  }
  private heap(q: string): Heap<Entry> {
    let h = this.ready.get(q)
    if (!h) this.ready.set(q, (h = new Heap(readyFirst)))
    return h
  }
  private insert(j: NewJob, now: number): Row {
    const r = { ...DEFAULTS, ...clone(j), ver: 0 } as Row
    this.jobs.set(r.id, r)
    this.place(r, now)
    return r
  }

  async enqueue(jobs: NewJob[], chord?: ChordSpec) {
    if (!jobs.length || this.jobs.has(jobs[0]!.id)) return
    const now = Date.now()
    if (chord) this.groups.set(chord.id, { remaining: chord.remaining, callback: clone(chord.callback), status: 'pending', purgeAt: null })
    for (const j of jobs) this.insert(j, now)
    this.wake()
  }

  async enqueueUnique(job: NewJob, key: string, windowMs: number, ttlMs: number) {
    if (this.jobs.has(job.id)) return
    if (await this.lock(key, job.id, windowMs)) return this.enqueue([{ ...job, uniqueKey: key }])
    const now = Date.now()
    this.insert({ ...job, status: 'deduped', dupOf: this.locks.get(key)?.owner ?? null, finishedAt: now, purgeAt: now + ttlMs }, now)
  }

  async get(id: string) { const r = this.jobs.get(id); return r && this.out(r) }

  // ponytail: a full scan + sort (dev / tests sizes); an index per status if memory ever holds millions
  async list({ status, queue, limit }: { status?: string; queue?: string; limit: number }) {
    return [...this.jobs.values()]
      .filter((r) => (!status || shown(r.status) === status) && (!queue || r.queue === queue))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((r) => this.out(r))
  }

  private promote(now: number): void {
    for (let e = this.delayed.peek(); e && e.runAt <= now; e = this.delayed.peek()) {
      this.delayed.pop()
      const r = this.jobs.get(e.id)
      if (r && r.ver === e.ver && r.status === 'scheduled') { r.status = 'queued'; this.place(r, now) }
    }
  }
  private nextAt(): number | undefined {
    for (let e = this.delayed.peek(); e; e = this.delayed.peek()) {
      const r = this.jobs.get(e.id)
      if (r && r.ver === e.ver && r.status === 'scheduled') return e.runAt
      this.delayed.pop()
    }
    return undefined
  }
  private top(h: Heap<Entry>): Entry | undefined {
    for (let e = h.peek(); e; e = h.peek()) {
      const r = this.jobs.get(e.id)
      if (r && r.ver === e.ver && r.status === 'queued') return e
      h.pop()
    }
    return undefined
  }

  async claim({ worker, queues, n, leaseMs, now = Date.now(), skipTasks = [] }: Claim) {
    checkClaim(n, queues)
    this.promote(now)
    const token = randomUUID(), skip = new Set(skipTasks), aside: [Heap<Entry>, Entry][] = [], jobs: JobRow[] = []
    const heaps = queues === '*' ? [...this.ready.values()] : queues.map((q) => this.ready.get(q)).filter((h): h is Heap<Entry> => !!h)
    while (jobs.length < n) {
      let best: [Heap<Entry>, Entry] | undefined
      for (const h of heaps) {
        const e = this.top(h)
        if (e && (!best || readyFirst(e, best[1]))) best = [h, e]
      }
      if (!best || best[1].runAt > now) break
      best[0].pop()
      const r = this.jobs.get(best[1].id)!
      if (skip.has(r.task)) { aside.push(best); continue }
      Object.assign(r, { status: 'running', worker, token, leaseUntil: now + leaseMs, attempts: r.attempts + 1, startedAt: now, updatedAt: now })
      this.place(r, now)
      this.moved(r)
      jobs.push(this.out(r))
    }
    for (const [h, e] of aside) h.push(e)
    return { token, jobs, ...(jobs.length < n && { nextAt: this.nextAt() }) }
  }

  private live(id: string, token: string): Row | undefined {
    const r = this.jobs.get(id)
    return r && r.token === token && r.status === 'running' ? r : undefined
  }

  async heartbeat(runs: { id: string; token: string }[], leaseMs: number) {
    const now = Date.now(), lost: string[] = [], cancelled: string[] = []
    for (const { id, token } of runs) {
      const r = this.live(id, token)
      if (!r) { lost.push(id); continue }
      r.leaseUntil = now + leaseMs
      if (r.cancel) cancelled.push(id)
    }
    return { lost, cancelled }
  }

  async progress(id: string, token: string, pct: number, message: string | null) {
    const r = this.live(id, token)
    if (!r) return false
    Object.assign(r, { progress: pct, message, updatedAt: Date.now() })
    this.moved(r)
    return true
  }

  private settle(r: Row, patch: Partial<Row>): void {
    Object.assign(r, patch, { updatedAt: Date.now() })
    this.place(r)
    this.moved(r)
  }

  async succeed(job: JobRow, token: string, o: Parameters<Broker['succeed']>[2]) {
    const r = this.live(job.id, token)
    if (!r) return false
    const now = Date.now()
    // build first (it may throw only before any write): the chord callback needs the members' results
    let fire: NewJob | undefined, fired = false
    const g = r.groupId ? this.groups.get(r.groupId) : undefined
    if (g?.status === 'pending' && g.remaining === 1) {
      const members = [...this.jobs.values()].filter((m) => m.groupId === r.groupId).sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))
      fire = o.callback?.(clone(g.callback), members.map((m) => (m.id === r.id ? clone(o.result) : clone(m.result))))
      fired = true
    }
    this.settle(r, { status: 'success', result: clone(o.result), error: null, progress: 100, finishedAt: now, purgeAt: o.purgeAt, leaseUntil: null })
    if (o.next) this.insert(o.next, now)
    if (g?.status === 'pending') {
      g.remaining--
      if (fired) { g.status = 'fired'; g.purgeAt = r.purgeAt; if (fire) this.insert(fire, now) }
    }
    if (r.uniqueKey) await this.unlock(r.uniqueKey, r.id)
    if (o.next || fire) this.wake()
    return true
  }

  private afterFinal(r: Row, status: JobStatus, purgeAt: number): void {
    if (r.uniqueKey && this.locks.get(r.uniqueKey)?.owner === r.id) this.locks.delete(r.uniqueKey)
    const g = r.groupId ? this.groups.get(r.groupId) : undefined
    if (g?.status === 'pending' && status !== 'success') { g.status = 'failed'; g.purgeAt = purgeAt }
  }

  async finish(job: JobRow, token: string, status: Final, o: { error?: string | null; purgeAt: number }) {
    const r = this.live(job.id, token)
    if (!r) return false
    this.settle(r, { status, finishedAt: Date.now(), purgeAt: o.purgeAt, leaseUntil: null, ...(o.error !== undefined && { error: o.error }) })
    this.afterFinal(r, status, o.purgeAt)
    return true
  }

  async requeue(id: string, token: string, o: { runAt: number; error?: string | null; refund?: boolean }) {
    const r = this.live(id, token)
    if (!r) return false
    this.settle(r, { status: 'queued', runAt: o.runAt, worker: null, token: null, leaseUntil: null, ...(o.error !== undefined && { error: o.error }), ...(o.refund && { attempts: r.attempts - 1 }) })
    this.wake()
    return true
  }

  async expired(now: number, limit: number) {
    const out: JobRow[] = []
    for (const id of this.running) {
      const r = this.jobs.get(id)!
      if (r.leaseUntil != null && r.leaseUntil < now) out.push(this.out(r))
      if (out.length >= limit) break
    }
    return out
  }

  async cancel(id: string, ttlMs: number) {
    const r = this.jobs.get(id)
    if (!r) return undefined
    const now = Date.now()
    if (r.status === 'queued' || r.status === 'scheduled') {
      this.settle(r, { status: 'cancelled', finishedAt: now, purgeAt: now + ttlMs })
      this.afterFinal(r, 'cancelled', now + ttlMs)
      return 'cancelled' as const
    }
    if (r.status === 'running') { r.cancel = true; r.updatedAt = now }
    return shown(r.status)
  }

  async retry(id: string) {
    const r = this.jobs.get(id)
    if (!r) return undefined
    if (!['dead', 'expired', 'cancelled'].includes(r.status)) return shown(r.status)
    const now = Date.now()
    this.settle(r, { status: 'queued', attempts: 0, runAt: now, error: null, finishedAt: null, purgeAt: null, cancel: false, expiresAt: null })
    this.wake()
    return 'requeued' as const
  }

  async purge(status: JobStatus) {
    let n = 0
    for (const [id, r] of this.jobs) if (shown(r.status) === status) { this.jobs.delete(id); this.running.delete(id); n++ }
    return n
  }

  async lock(key: string, owner: string, ttlMs: number, now = Date.now()) {
    const l = this.locks.get(key)
    if (l && l.owner !== owner && l.expiresAt > now) return false
    this.locks.set(key, { owner, expiresAt: now + ttlMs })
    return true
  }
  async unlock(key: string, owner: string) { if (this.locks.get(key)?.owner === owner) this.locks.delete(key) }

  async schedule(name: string, spec: string, first: () => number) {
    const s = this.schedules.get(name)
    if (s && s.spec === spec) return { nextRunAt: s.nextRunAt, fresh: false }
    const nextRunAt = first()
    this.schedules.set(name, { spec, nextRunAt, lastRunAt: s?.lastRunAt ?? null })
    return { nextRunAt, fresh: true }
  }

  async fire(name: string, due: number, next: number, jobs: NewJob[]) {
    const s = this.schedules.get(name)
    if (!s || s.nextRunAt !== due) return false
    Object.assign(s, { nextRunAt: next, lastRunAt: Date.now() })
    const now = Date.now()
    for (const j of jobs) this.insert(j, now)
    if (jobs.length) this.wake()
    return true
  }

  async register(w: WorkerInfo) { const now = Date.now(); this.workers.set(w.name, { ...w, startedAt: now, beatAt: now, running: 0, processed: 0 }) }
  async beat(name: string, running: number, processed: number) { const w = this.workers.get(name); if (w) Object.assign(w, { beatAt: Date.now(), running, processed }) }
  async unregister(name: string) { this.workers.delete(name) }

  async cleanup(now: number) {
    for (const [id, r] of this.jobs) {
      if (r.purgeAt == null || r.purgeAt > now) continue
      if (r.groupId && this.groups.get(r.groupId)?.status === 'pending') continue
      this.jobs.delete(id)
    }
    for (const [id, g] of this.groups) if (g.purgeAt != null && g.purgeAt <= now) this.groups.delete(id)
    for (const [k, l] of this.locks) if (l.expiresAt <= now - 60_000) this.locks.delete(k)
    for (const [k, w] of this.workers) if (w.beatAt < now - 86_400_000) this.workers.delete(k)
  }

  async stats(leaseMs: number): Promise<QueueStats> {
    const now = Date.now(), c = { queued: 0, scheduled: 0, running: 0, dead: 0 }
    for (const r of this.jobs.values()) if (r.status in c) c[r.status as keyof typeof c]++
    return {
      ...c,
      workers: [...this.workers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ name: w.name, queues: w.queues, running: w.running, processed: w.processed, beatAgoMs: now - w.beatAt, stale: now - w.beatAt > leaseMs })),
    }
  }

  watch(fn: (j: Moved) => void) {
    const on = (m: Moved) => { try { fn(m) } catch { /* a watcher's own failure */ } }
    this.ev.on('moved', on)
    return () => { this.ev.off('moved', on) }
  }

  onWake(fn: () => void) {
    this.ev.on('wake', fn)
    return () => { this.ev.off('wake', fn) }
  }

  async close() { this.ev.removeAllListeners() }
}
