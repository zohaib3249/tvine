// The job store boundary (docs/design/contrib/tasks.md §Broker). task.ts, worker.ts, beat.ts, relay.ts, views.ts and
// cli.ts reach jobs, chords, locks, schedules and worker rows ONLY through `Broker`. `settings.tasks.broker` picks
// the store: 'file' (default: its own SQLite WAL file, file.ts), 'memory' (one process, memory.ts), 'redis'
// (multi-host, redis.ts) or 'db' (`dbBroker()` below: the tasks_* tables of the app's database).
// Every write after a claim matches id + token + status='running': the token fences a worker whose lease expired,
// so it can never overwrite the attempt that re-claimed its job.
import { randomUUID } from 'node:crypto'
import { connections, type Connection } from '../../data/db.js'
import { atomic } from '../../data/engine.js'
import { dec } from '../../index.js'
import { DEFAULTS } from '../../settings.js'
import { fileBroker } from './file.js'
import { memoryBroker } from './memory.js'
import { FINAL, Group, Job, Lock, Schedule, WorkerRow, type JobRow, type JobStatus } from './models.js'
import { redisBroker } from './redis.js'
import { bus, checkClaim, notify, type Moved } from './shared.js'

export { bus, notify, type Moved }

export type NewJob = Omit<JobRow, 'result' | 'error' | 'leaseUntil' | 'worker' | 'token' | 'progress' | 'message' | 'startedAt' | 'finishedAt' | 'purgeAt' | 'attempts' | 'cancel'> & Partial<JobRow>
export interface SigJSON { task: string; args?: unknown; immutable?: boolean; opts?: { countdown?: number; priority?: number; queue?: string } }
export interface ChordSpec { id: string; remaining: number; callback: SigJSON }
export interface Claim { worker: string; queues: string[] | '*'; n: number; leaseMs: number; now?: number; skipTasks?: string[] }
export interface WorkerInfo { name: string; queues: string; concurrency: number; pid: number; host: string }
export interface QueueStats {
  queued: number; scheduled: number; running: number; dead: number
  workers: { name: string; queues: string; running: number; processed: number; beatAgoMs: number; stale: boolean }[]
}
export type Final = Exclude<JobStatus, 'queued' | 'running' | 'deduped'>

export interface Broker {
  // idempotent by job id (an outbox row relayed twice enqueues once); a chord's counter row with its members
  enqueue(jobs: NewJob[], chord?: ChordSpec): Promise<void>
  // one live job per key: the lock is taken with a non-aborting insert; a duplicate becomes a `deduped` row (dupOf)
  enqueueUnique(job: NewJob, key: string, windowMs: number, ttlMs: number): Promise<void>
  get(id: string): Promise<JobRow | undefined>
  list(f: { status?: string; queue?: string; limit: number }): Promise<JobRow[]>
  // claimed rows (running, attempt counted) + their lease token. skipTasks: rate-limited tasks this worker must not take now.
  // nextAt (when fewer than n came back): the earliest delayed job's runAt, so an idle worker wakes for it
  claim(c: Claim): Promise<{ token: string; jobs: JobRow[]; nextAt?: number }>
  // extend leases; which were lost (re-claimed / settled elsewhere) and which were revoked meanwhile
  heartbeat(runs: { id: string; token: string }[], leaseMs: number): Promise<{ lost: string[]; cancelled: string[] }>
  progress(id: string, token: string, pct: number, message: string | null): Promise<boolean>
  // success + its follow-ups in ONE transaction: the next chain link; for a chord member, the count-down and (once)
  // the callback built by `callback(sig, results)` (undefined = canvas broken there)
  succeed(job: JobRow, token: string, o: { result: unknown; purgeAt: number; next?: NewJob; callback?: (sig: SigJSON, results: unknown[]) => NewJob | undefined }): Promise<boolean>
  // a final status (+ unique lock released, a chord whose member did not succeed failed). expiredBefore (the reaper):
  // only while the lease is still past it — a worker that heartbeat meanwhile keeps its job (no second run)
  finish(job: JobRow, token: string, status: Final, o: { error?: string | null; purgeAt: number; expiredBefore?: number }): Promise<boolean>
  // back to queued (retry / release / rate limit); refund = the attempt does not count
  requeue(id: string, token: string, o: { runAt: number; error?: string | null; refund?: boolean; expiredBefore?: number }): Promise<boolean>
  expired(now: number, limit: number): Promise<JobRow[]>
  cancel(id: string, ttlMs: number): Promise<JobStatus | undefined>   // queued → cancelled; running → cancel flag
  retry(id: string): Promise<JobStatus | 'requeued' | undefined>      // ops: dead / expired / cancelled → queued
  purge(status: JobStatus): Promise<number>
  // a lease-style lock: renew (same owner), take (free), or take over (expired)
  lock(key: string, owner: string, ttlMs: number, now?: number): Promise<boolean>
  unlock(key: string, owner: string): Promise<void>
  // beat state: the schedule's next time (created / re-timed when the spec changed: fresh = nothing due yet)
  schedule(name: string, spec: string, first: () => number): Promise<{ nextRunAt: number; fresh: boolean }>
  // compare-and-set nextRunAt due → next, inserting `jobs` in the same transaction; false = another beat won
  fire(name: string, due: number, next: number, jobs: NewJob[]): Promise<boolean>
  register(w: WorkerInfo): Promise<void>
  beat(name: string, running: number, processed: number): Promise<void>
  unregister(name: string): Promise<void>
  // result TTL and housekeeping. callback: rebuilds a chord callback a crashed member left half-fired (redis)
  cleanup(now: number, o?: { callback?: (sig: SigJSON, results: unknown[], parent: JobRow) => NewJob | undefined }): Promise<void>
  stats(leaseMs: number): Promise<QueueStats>
  // job rows that moved (progress, status) for rows with an owner session; returns unsubscribe
  watch(fn: (j: Moved) => void, o?: { minMs?: number; maxMs?: number }): () => void
  // pushed wake-ups (another process enqueued / requeued): the worker claims at once. A broker with onWake also
  // calls fn on a safety poll (≤5 s); without it the worker polls settings.tasks.pollMs
  onWake?(fn: () => void): () => void
  compact?(): Promise<{ before: number; after: number }>
  close?(): Promise<void>
}

const later = notify
const MAX_CLAIM = 100
const isDup = (e: unknown, what: string) => (e as { code?: string })?.code === 'domain' && String((e as Error).message).includes(`${what} must be unique`)

export function dbBroker(o: { alias?: string } = {}): Broker {
  // ponytail: the ORM routes every model to the default connection; a separate job database needs per-alias
  // routing (Model.objects.using(alias), task-orm) — refused loudly until then, never silently ignored
  if ((o.alias ?? 'default') !== 'default') throw new Error(`dbBroker({ alias: '${o.alias}' }): a separate job database needs per-alias ORM routing, not available yet`)
  return new DbBroker()
}

class DbBroker implements Broker {
  async enqueue(jobs: NewJob[], chord?: ChordSpec) {
    if (!jobs.length) return
    try {
      await atomic(async () => {
        if (chord) await Group.create({ ...chord, createdAt: Date.now() })
        for (const j of jobs) await Job.create(j as never)
      })
    } catch (e) {
      if (!(isDup(e, 'tasks_job.id') || isDup(e, 'tasks_group.id')) || !(await Job.get(jobs[0]!.id))) throw e
      return   // already enqueued (an outbox row relayed twice)
    }
    later('enqueued')
  }

  async enqueueUnique(job: NewJob, key: string, windowMs: number, ttlMs: number) {
    if (await this.lock(key, job.id, windowMs)) {
      try { await this.enqueue([{ ...job, uniqueKey: key }]) } catch (e) { await this.unlock(key, job.id); throw e }
      return
    }
    if (await Job.get(job.id)) return   // relayed twice
    const held = await Lock.objects.filter({ key }).first()
    const now = Date.now()
    await this.enqueue([{ ...job, status: 'deduped', dupOf: held?.owner ?? null, finishedAt: now, purgeAt: now + ttlMs }])
  }

  get(id: string) { return Job.get(id).catch(() => undefined) }   // a malformed id (pg uuid) is simply not found

  async list({ status, queue, limit }: { status?: string; queue?: string; limit: number }) {
    let qs = Job.objects.order('-createdAt')
    if (status) qs = qs.filter({ status })
    if (queue) qs = qs.filter({ queue })
    return (await qs.page({ size: limit })).items
  }

  async claim({ worker, queues, n, leaseMs, now = Date.now(), skipTasks = [] }: Claim) {
    checkClaim(n, queues)
    const token = randomUUID()
    const set = { worker, token, leaseUntil: now + leaseMs, now }
    const f: Filter = { queues, now, skip: skipTasks.slice(0, 100) }
    const conn = connections.get()
    let ids: string[]
    if (conn.dialect.name === 'sqlite') {
      // the engine's serial queue (+ BEGIN IMMEDIATE) makes the single UPDATE … RETURNING exclusive, across processes too
      ids = await atomic(async () => (await conn.driver.query(...claimUpdate(conn, set, f, n, ''))).map((r) => String(r.id)))
    } else if (conn.dialect.name === 'postgres') {
      ids = (await conn.driver.query(...claimUpdate(conn, set, f, n, ' FOR UPDATE SKIP LOCKED'))).map((r) => String(r.id))
    } else {
      // mysql 8 / mariadb 10.6: no UPDATE … RETURNING and no LIMIT in an IN subquery — lock, then update, one
      // transaction. A filesorted FOR UPDATE locks every row it READS (not only the LIMIT), so one claimer would lock
      // the whole queue: pick candidates without locks, then lock just those by primary key, skipping taken ones.
      ids = await conn.driver.transaction(async (tx) => {
        const cand = (await tx.query(...select(conn, f, Math.min(3 * n, 3 * MAX_CLAIM), ''))).map((r) => String(r.id))
        if (!cand.length) return []
        const got = (await tx.query(...lockIds(conn, cand, n, now))).map((r) => String(r.id))
        if (got.length) await tx.exec(...update(conn, set, got))
        return got
      })
    }
    if (!ids.length) return { token, jobs: [] }
    const jobs = await Job.objects.filter([{ field: 'id', op: 'in', value: ids }]).all()
    return { token, jobs: jobs.filter((j) => j.token === token).sort((x, y) => y.priority - x.priority || x.runAt - y.runAt || (x.id < y.id ? -1 : 1)) }
  }

  async heartbeat(runs: { id: string; token: string }[], leaseMs: number) {
    const now = Date.now(), lost: string[] = []
    for (const r of runs) {
      if ((await Job.objects.filter({ id: r.id, token: r.token, status: 'running' }).update({ leaseUntil: now + leaseMs })) !== 1) lost.push(r.id)
    }
    const live = runs.filter((r) => !lost.includes(r.id)).map((r) => r.id)
    const cancelled = live.length ? (await Job.objects.filter([{ field: 'id', op: 'in', value: live }, { field: 'cancel', op: 'eq', value: true }]).all()).map((j) => j.id) : []
    return { lost, cancelled }
  }

  async progress(id: string, token: string, pct: number, message: string | null) {
    const ok = (await Job.objects.filter({ id, token, status: 'running' }).update({ progress: pct, message, updatedAt: Date.now() })) === 1
    if (ok) later('moved')
    return ok
  }

  private settle(id: string, token: string, patch: Record<string, unknown>, expiredBefore?: number) {
    const qs = Job.objects.filter({ id, token, status: 'running' })
    return (expiredBefore === undefined ? qs : qs.filter([{ field: 'leaseUntil', op: 'lt', value: expiredBefore }])).update({ ...patch, updatedAt: Date.now() }).then((n) => n === 1)
  }

  async succeed(job: JobRow, token: string, o: Parameters<Broker['succeed']>[2]) {
    const ok = await atomic(async () => {
      if (!(await this.settle(job.id, token, { status: 'success', result: o.result, error: null, progress: 100, finishedAt: Date.now(), purgeAt: o.purgeAt, leaseUntil: null }))) return false
      if (o.next) await Job.create(o.next as never)
      if (job.groupId) await this.chordStep(job, o.callback)
      if (job.uniqueKey) await this.unlock(job.uniqueKey, job.id)
      return true
    })
    if (ok) { later('enqueued'); later('moved') }
    return ok
  }

  // a chord member succeeded (inside its success transaction): count down; the one reaching 0 fires the callback once.
  // The decrement takes the group row's lock until commit, so concurrent members see each other's counts.
  private async chordStep(job: JobRow, build?: (sig: SigJSON, results: unknown[]) => NewJob | undefined) {
    const id = job.groupId!
    if (!(await Group.objects.filter({ id, status: 'pending' }).update({ remaining: dec(1) }))) return   // plain group, or a failed chord
    const g = await Group.get(id)
    if (!g || g.remaining > 0) return
    if (!(await Group.objects.filter({ id, status: 'pending' }).update({ status: 'fired', purgeAt: job.purgeAt ?? Date.now() + 86_400_000 }))) return
    const members = await Job.objects.filter({ groupId: id }).order('groupIndex').all()
    const cb = build?.(g.callback as SigJSON, members.map((m) => m.result))
    if (cb) await Job.create(cb as never)
  }

  async finish(job: JobRow, token: string, status: Final, o: { error?: string | null; purgeAt: number; expiredBefore?: number }) {
    const ok = await atomic(async () => {
      if (!(await this.settle(job.id, token, { status, finishedAt: Date.now(), purgeAt: o.purgeAt, leaseUntil: null, ...(o.error !== undefined && { error: o.error }) }, o.expiredBefore))) return false
      await this.afterFinal(job, status, o.purgeAt)
      return true
    })
    if (ok) later('moved')
    return ok
  }

  private async afterFinal(job: Pick<JobRow, 'id' | 'uniqueKey' | 'groupId'>, status: JobStatus, purgeAt: number) {
    if (job.uniqueKey) await this.unlock(job.uniqueKey, job.id)
    if (job.groupId && status !== 'success') await Group.objects.filter({ id: job.groupId, status: 'pending' }).update({ status: 'failed', purgeAt })
  }

  async requeue(id: string, token: string, o: { runAt: number; error?: string | null; refund?: boolean; expiredBefore?: number }) {
    const ok = await this.settle(id, token, {
      status: 'queued', runAt: o.runAt, worker: null, token: null, leaseUntil: null,
      ...(o.error !== undefined && { error: o.error }), ...(o.refund && { attempts: dec(1) }),
    }, o.expiredBefore)
    if (ok) { later('moved'); if (o.runAt <= Date.now()) later('enqueued') }
    return ok
  }

  async expired(now: number, limit: number) {
    return (await Job.objects.filter([{ field: 'status', op: 'eq', value: 'running' }, { field: 'leaseUntil', op: 'lt', value: now }]).page({ size: limit })).items
  }

  async cancel(id: string, ttlMs: number): Promise<JobStatus | undefined> {
    for (let i = 0; i < 3; i++) {
      const j = await this.get(id)
      if (!j) return undefined
      const now = Date.now()
      if (j.status === 'queued') {
        const ok = await atomic(async () => {
          if (!(await Job.objects.filter({ id, status: 'queued' }).update({ status: 'cancelled', finishedAt: now, purgeAt: now + ttlMs, updatedAt: now }))) return false
          await this.afterFinal(j, 'cancelled', now + ttlMs)
          return true
        })
        if (ok) { later('moved'); return 'cancelled' }
        continue   // it moved under us: decide again
      }
      if (j.status === 'running') await Job.objects.filter({ id, status: 'running' }).update({ cancel: true, updatedAt: now })
      return j.status
    }
    return (await this.get(id))?.status
  }

  async retry(id: string) {
    const j = await this.get(id)
    if (!j) return undefined
    if (!['dead', 'expired', 'cancelled'].includes(j.status)) return j.status
    const now = Date.now()
    const n = await Job.objects.filter({ id, status: j.status }).update({ status: 'queued', attempts: 0, runAt: now, error: null, finishedAt: null, purgeAt: null, cancel: false, expiresAt: null, updatedAt: now })
    if (n) later('enqueued')
    return n ? 'requeued' as const : (await this.get(id))?.status
  }

  purge(status: JobStatus) { return Job.objects.filter({ status }).delete() }

  async lock(key: string, owner: string, ttlMs: number, now = Date.now()) {
    if (await Lock.objects.filter({ key, owner }).update({ expiresAt: now + ttlMs })) return true
    if (await insertIgnoreLock(key, owner, now + ttlMs)) return true
    return (await Lock.objects.filter([{ field: 'key', op: 'eq', value: key }, { field: 'expiresAt', op: 'lte', value: now }]).update({ owner, expiresAt: now + ttlMs })) === 1
  }

  async unlock(key: string, owner: string) { await Lock.objects.filter({ key, owner }).delete() }

  async schedule(name: string, spec: string, first: () => number) {
    const row = await Schedule.objects.filter({ name }).first()
    if (!row) {
      const nextRunAt = first()
      try { await Schedule.create({ name, spec, nextRunAt }) } catch (e) { if (!isDup(e, 'tasks_schedule.name')) throw e }
      return { nextRunAt, fresh: true }
    }
    if (row.spec !== spec) {   // its schedule changed in code: the next time from now
      const nextRunAt = first()
      await Schedule.objects.filter({ name, spec: row.spec }).update({ spec, nextRunAt })
      return { nextRunAt, fresh: true }
    }
    return { nextRunAt: row.nextRunAt, fresh: false }
  }

  async fire(name: string, due: number, next: number, jobs: NewJob[]) {
    const won = await atomic(async () => {
      if (!(await Schedule.objects.filter({ name, nextRunAt: due }).update({ nextRunAt: next, lastRunAt: Date.now() }))) return false
      for (const j of jobs) await Job.create(j as never)
      return true
    })
    if (won && jobs.length) later('enqueued')
    return won
  }

  async register(w: WorkerInfo) {
    const now = Date.now()
    await WorkerRow.objects.filter({ name: w.name }).delete()
    await WorkerRow.create({ ...w, startedAt: now, beatAt: now })
  }
  async beat(name: string, running: number, processed: number) { await WorkerRow.objects.filter({ name }).update({ beatAt: Date.now(), running, processed }) }
  async unregister(name: string) { await WorkerRow.objects.filter({ name }).delete() }

  // finished rows past their purgeAt — except members of a chord still pending (its callback needs their results)
  async cleanup(now: number) {
    await Job.objects.filter([{ field: 'purgeAt', op: 'lte', value: now }, { field: 'groupId', op: 'eq', value: null }]).delete()
    const grouped = await Job.objects.filter([{ field: 'purgeAt', op: 'lte', value: now }, { field: 'groupId', op: 'ne', value: null }]).all(1000)
    const gids = [...new Set(grouped.map((j) => j.groupId!))]
    const pending = new Set(gids.length ? (await Group.objects.filter([{ field: 'id', op: 'in', value: gids }, { field: 'status', op: 'eq', value: 'pending' }]).all()).map((g) => g.id) : [])
    const gone = grouped.filter((j) => !pending.has(j.groupId!)).map((j) => j.id)
    if (gone.length) await Job.objects.filter([{ field: 'id', op: 'in', value: gone }]).delete()
    await Group.objects.filter([{ field: 'purgeAt', op: 'lte', value: now }]).delete()
    await Lock.objects.filter([{ field: 'expiresAt', op: 'lte', value: now - 60_000 }]).delete()
    await WorkerRow.objects.filter([{ field: 'beatAt', op: 'lt', value: now - 86_400_000 }]).delete()
  }

  async stats(leaseMs: number): Promise<QueueStats> {
    const now = Date.now()
    const count = (status: JobStatus, extra: { field: string; op: 'lte' | 'gt'; value: number }[] = []) =>
      Job.objects.filter([{ field: 'status', op: 'eq', value: status }, ...extra]).count()
    const [queued, scheduled, running, dead, workers] = await Promise.all([
      count('queued', [{ field: 'runAt', op: 'lte', value: now }]), count('queued', [{ field: 'runAt', op: 'gt', value: now }]),
      count('running'), count('dead'), WorkerRow.objects.order('name').all(200),
    ])
    return {
      queued, scheduled, running, dead,
      workers: workers.map((w) => ({ name: w.name, queues: w.queues, running: w.running, processed: w.processed, beatAgoMs: now - w.beatAt, stale: now - w.beatAt > leaseMs })),
    }
  }

  // ponytail: a DB store has no pub/sub, so watchers poll tasks_job by updatedAt — at minMs while rows move (and at
  // once on an in-process write), backing off to maxMs when idle. A Redis store pushes instead.
  // Clock skew: updatedAt is the WRITER's clock; rows are re-read OVERLAP ms back, so skew between processes up to
  // that is tolerated (more = a late row may be missed; its final status still lands via tasks.status).
  watch(fn: (j: JobRow) => void, { minMs = 250, maxMs = 2_000 }: { minMs?: number; maxMs?: number } = {}) {
    const OVERLAP = 2_000, PAGE = 100, MAX_PAGES = 50
    let cursor = Date.now() - OVERLAP, delay = minMs, stopped = false, again = false
    let timer: NodeJS.Timeout | undefined, busy: Promise<void> | undefined
    const seen = new Map<string, number>()
    const arm = () => { if (!stopped) { clearTimeout(timer); timer = setTimeout(poll, delay); timer.unref() } }
    const poll = (): Promise<void> => {
      if (stopped) return Promise.resolve()
      if (busy) { again = true; return busy }
      return (busy = (async () => {
        let moved = false
        try {
          do {
            again = false
            const qs = Job.objects.filter([{ field: 'updatedAt', op: 'gte', value: cursor - OVERLAP }, { field: 'sid', op: 'ne', value: null }]).order('updatedAt')
            let top = cursor, page: string | undefined, n = 0
            do {   // keyset pages (updatedAt, id): a busy window is read through, never re-read in a loop
              const p = await qs.page({ size: PAGE, cursor: page })
              for (const j of p.items) {
                top = Math.max(top, j.updatedAt)
                if (seen.get(j.id) === j.updatedAt) continue
                seen.set(j.id, j.updatedAt)
                moved = true
                try { fn(j) } catch { /* a watcher's own failure */ }
              }
              page = p.nextCursor
            } while (page && ++n < MAX_PAGES && !stopped)
            cursor = top
            for (const [id, at] of seen) if (at < cursor - 2 * OVERLAP) seen.delete(id)
          } while (again && !stopped)
        } catch { /* db down / closing: next poll retries */ }
        delay = moved ? minMs : Math.min(maxMs, delay * 2)
        busy = undefined
        arm()
      })())
    }
    const wake = () => { delay = minMs; void poll() }
    bus.on('moved', wake)
    void poll()
    return () => { stopped = true; clearTimeout(timer); bus.off('moved', wake) }
  }
}

// ---- the configured store ------------------------------------------------------------------
export type TasksSettings = typeof DEFAULTS.tasks
let conf: TasksSettings = DEFAULTS.tasks
let current: Broker | undefined

export function openBroker(t: TasksSettings): Broker {
  switch (t.broker ?? 'file') {
    case 'db': return dbBroker()
    case 'memory': return memoryBroker()
    case 'redis': return redisBroker({ alias: t.redis ?? 'default', leaseMs: t.leaseMs })
    case 'file': return fileBroker({ path: t.file, durable: t.durable })
    default: throw new Error(`settings.tasks.broker "${String(t.broker)}": use 'file', 'memory', 'redis' or 'db'`)
  }
}

export const broker = (): Broker => (current ??= openBroker(conf))
export function setBroker(b: Broker): void { current = b }
export const brokerKind = (): TasksSettings['broker'] => conf.broker

// settings.tasks changed (configureTasks): a different store is opened on next use; the old one is closed
export function configureBroker(t: TasksSettings): void {
  const key = (x: TasksSettings) => JSON.stringify([x.broker, x.file, x.durable, x.redis])
  const changed = key(t) !== key(conf)
  conf = t
  if (changed && current) { const old = current; current = undefined; void old.close?.() }
}
export async function closeBroker(): Promise<void> {
  const b = current
  current = undefined
  await b?.close?.()
}

// ---- raw statements: constant identifiers through quoteIdent, every value a param -------------
type Stmt = [sql: string, params: unknown[]]
interface Filter { queues: string[] | '*'; now: number; skip: string[] }
const quoter = (c: Connection) => (n: string) => c.dialect.quoteIdent(n)
function binder(c: Connection, params: unknown[]) {
  return (v: unknown) => { params.push(v); return c.dialect.param(params.length) }
}
function where(c: Connection, p: (v: unknown) => string, f: Filter): string {
  const q = quoter(c)
  return `${q('status')} = ${p('queued')} AND ${q('runAt')} <= ${p(f.now)}` +
    (f.queues === '*' ? '' : ` AND ${q('queue')} IN (${f.queues.map(p).join(', ')})`) +
    (f.skip.length ? ` AND ${q('task')} NOT IN (${f.skip.map(p).join(', ')})` : '')
}
function setClause(c: Connection, p: (v: unknown) => string, s: { worker: string; token: string; leaseUntil: number; now: number }): string {
  const q = quoter(c)
  return `${q('status')} = ${p('running')}, ${q('worker')} = ${p(s.worker)}, ${q('token')} = ${p(s.token)}, ${q('leaseUntil')} = ${p(s.leaseUntil)}, ` +
    `${q('attempts')} = ${q('attempts')} + ${p(1)}, ${q('startedAt')} = ${p(s.now)}, ${q('updatedAt')} = ${p(s.now)}`
}
const ORDER = (c: Connection) => { const q = quoter(c); return `ORDER BY ${q('priority')} DESC, ${q('runAt')} ASC, ${q('id')} ASC` }
const T = (c: Connection) => c.dialect.quoteIdent('tasks_job')

function claimUpdate(c: Connection, s: Parameters<typeof setClause>[2], f: Filter, n: number, lock: string): Stmt {
  const params: unknown[] = [], p = binder(c, params), q = quoter(c)
  return [`UPDATE ${T(c)} SET ${setClause(c, p, s)} WHERE ${q('id')} IN (SELECT ${q('id')} FROM ${T(c)} WHERE ${where(c, p, f)} ${ORDER(c)} LIMIT ${p(n)}${lock}) RETURNING ${q('id')}`, params]
}
function select(c: Connection, f: Filter, n: number, lock: string): Stmt {
  const params: unknown[] = [], p = binder(c, params), q = quoter(c)
  return [`SELECT ${q('id')} FROM ${T(c)} WHERE ${where(c, p, f)} ${ORDER(c)} LIMIT ${p(n)}${lock}`, params]
}
function lockIds(c: Connection, ids: string[], n: number, now: number): Stmt {
  const params: unknown[] = [], p = binder(c, params), q = quoter(c)
  return [`SELECT ${q('id')} FROM ${T(c)} WHERE ${q('id')} IN (${ids.map(p).join(', ')}) AND ${where(c, p, { queues: '*', now, skip: [] })} ${ORDER(c)} LIMIT ${p(n)} FOR UPDATE SKIP LOCKED`, params]
}
function update(c: Connection, s: Parameters<typeof setClause>[2], ids: string[]): Stmt {
  const params: unknown[] = [], p = binder(c, params), q = quoter(c)
  return [`UPDATE ${T(c)} SET ${setClause(c, p, s)} WHERE ${q('id')} IN (${ids.map(p).join(', ')}) AND ${q('status')} = ${p('queued')}`, params]
}

// a non-aborting insert: never raises a unique violation (a postgres transaction would be aborted by one)
async function insertIgnoreLock(key: string, owner: string, expiresAt: number): Promise<boolean> {
  const c = connections.get(), q = quoter(c), params: unknown[] = [], p = binder(c, params)
  const cols = `(${q('key')}, ${q('owner')}, ${q('expiresAt')}) VALUES (${p(key)}, ${p(owner)}, ${p(expiresAt)})`
  const sql = c.dialect.name === 'mysql' ? `INSERT IGNORE INTO ${q('tasks_lock')} ${cols}` : `INSERT INTO ${q('tasks_lock')} ${cols} ON CONFLICT DO NOTHING`
  const run = () => c.driver.exec(sql, params).then((r) => r.changes === 1)
  return c.dialect.name === 'sqlite' ? atomic(run) : run()   // sqlite: through the engine's queue
}

export { FINAL }
