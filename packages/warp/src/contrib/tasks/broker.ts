// The queue transport (docs/design/contrib/tasks.md §Broker interface). DbBroker keeps jobs in tasks_job; a
// Redis broker (#12) implements the same interface (results, chords and beat state stay in the DB).
// Every write after the claim matches id + token + status='running': the token fences a worker whose lease
// expired, so it can never overwrite the attempt that re-claimed its job.
import { randomUUID } from 'node:crypto'
import { connections, type Connection } from '../../data/db.js'
import { atomic } from '../../data/engine.js'
import { Job, WorkerRow, type JobRow, type JobStatus } from './models.js'

export interface Claim { worker: string; queues: string[] | '*'; n: number; leaseMs: number; now?: number }
export interface QueueStats {
  queued: number; scheduled: number; running: number; dead: number
  workers: { name: string; queues: string; running: number; processed: number; beatAgoMs: number; stale: boolean }[]
}

export interface Broker {
  // the claimed rows (status running, attempts already counted) and their lease token
  claim(c: Claim): Promise<{ token: string; jobs: JobRow[] }>
  // extend the lease; false = lost (re-claimed, released or finished elsewhere)
  heartbeat(id: string, token: string, leaseMs: number): Promise<boolean>
  // compare-and-set the running attempt into `patch` (a final status, or back to queued); false = lost
  settle(id: string, token: string, patch: Partial<JobRow>): Promise<boolean>
  // running rows whose lease passed: re-queue (late acks) or kill (early acks / out of retries)
  expired(now: number, limit: number): Promise<JobRow[]>
  cleanup(now: number): Promise<number>
  stats(leaseMs: number): Promise<QueueStats>
}

const QUEUE_RE = /^[a-z0-9_-]{1,64}$/i
const MAX_CLAIM = 100

export class DbBroker implements Broker {
  async claim({ worker, queues, n, leaseMs, now = Date.now() }: Claim) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_CLAIM) throw new Error(`claim: n must be 1-${MAX_CLAIM}`)
    if (queues !== '*' && (!queues.length || !queues.every((x) => QUEUE_RE.test(x)))) throw new Error('claim: bad queue names')
    const token = randomUUID()
    const set = { worker, token, leaseUntil: now + leaseMs, now }
    const conn = connections.get()
    let ids: string[]
    if (conn.dialect.name === 'sqlite') {
      // the engine's serial queue (+ BEGIN IMMEDIATE) makes the single UPDATE … RETURNING exclusive, across processes too
      ids = await atomic(async () => (await conn.driver.query(...claimUpdate(conn, set, queues, n, ''))).map((r) => String(r.id)))
    } else if (conn.dialect.name === 'postgres') {
      ids = (await conn.driver.query(...claimUpdate(conn, set, queues, n, ' FOR UPDATE SKIP LOCKED'))).map((r) => String(r.id))
    } else {
      // mysql 8 / mariadb 10.6: no UPDATE … RETURNING and no LIMIT in an IN subquery — lock, then update, one
      // transaction. A filesorted FOR UPDATE locks every row it READS (not only the LIMIT), so one claimer would lock
      // the whole queue: pick candidates without locks, then lock just those by primary key, skipping taken ones.
      ids = await conn.driver.transaction(async (tx) => {
        const cand = (await tx.query(...select(conn, queues, Math.min(3 * n, 3 * MAX_CLAIM), now, ''))).map((r) => String(r.id))
        if (!cand.length) return []
        const got = (await tx.query(...lockIds(conn, cand, n, now))).map((r) => String(r.id))
        if (got.length) await tx.exec(...update(conn, set, got))
        return got
      })
    }
    if (!ids.length) return { token, jobs: [] }
    const jobs = await Job.objects.filter([{ field: 'id', op: 'in', value: ids }]).all()
    return { token, jobs: jobs.filter((j) => j.token === token) }
  }

  async heartbeat(id: string, token: string, leaseMs: number) {
    const now = Date.now()
    return (await Job.objects.filter({ id, token, status: 'running' }).update({ leaseUntil: now + leaseMs, updatedAt: now })) === 1
  }

  async settle(id: string, token: string, patch: Partial<JobRow>) {
    return (await Job.objects.filter({ id, token, status: 'running' }).update({ ...patch, updatedAt: Date.now() })) === 1
  }

  async expired(now: number, limit: number) {
    return (await Job.objects.filter([{ field: 'status', op: 'eq', value: 'running' }, { field: 'leaseUntil', op: 'lt', value: now }]).page({ size: limit })).items
  }

  async cleanup(now: number) {
    return Job.objects.filter([{ field: 'purgeAt', op: 'lte', value: now }]).delete()
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
}

// ---- claim statements: constant identifiers through quoteIdent, every value a param ----------
type Stmt = [sql: string, params: unknown[]]
const cols = (c: Connection) => {
  const q = (n: string) => c.dialect.quoteIdent(n)
  return { q, T: q('tasks_job') }
}
function binder(c: Connection, params: unknown[]) {
  return (v: unknown) => { params.push(v); return c.dialect.param(params.length) }
}
function where(c: Connection, p: (v: unknown) => string, queues: string[] | '*', now: number): string {
  const { q } = cols(c)
  return `${q('status')} = ${p('queued')} AND ${q('runAt')} <= ${p(now)}` + (queues === '*' ? '' : ` AND ${q('queue')} IN (${queues.map(p).join(', ')})`)
}
function setClause(c: Connection, p: (v: unknown) => string, s: { worker: string; token: string; leaseUntil: number; now: number }): string {
  const { q } = cols(c)
  return `${q('status')} = ${p('running')}, ${q('worker')} = ${p(s.worker)}, ${q('token')} = ${p(s.token)}, ${q('leaseUntil')} = ${p(s.leaseUntil)}, ` +
    `${q('attempts')} = ${q('attempts')} + ${p(1)}, ${q('startedAt')} = ${p(s.now)}, ${q('updatedAt')} = ${p(s.now)}`
}
const ORDER = (c: Connection) => { const { q } = cols(c); return `ORDER BY ${q('priority')} DESC, ${q('runAt')} ASC, ${q('id')} ASC` }

function claimUpdate(c: Connection, s: Parameters<typeof setClause>[2], queues: string[] | '*', n: number, lock: string): Stmt {
  const params: unknown[] = [], p = binder(c, params), { q, T } = cols(c)
  const sql = `UPDATE ${T} SET ${setClause(c, p, s)} WHERE ${q('id')} IN (SELECT ${q('id')} FROM ${T} WHERE ${where(c, p, queues, s.now)} ${ORDER(c)} LIMIT ${p(n)}${lock}) RETURNING ${q('id')}`
  return [sql, params]
}
function select(c: Connection, queues: string[] | '*', n: number, now: number, lock: string): Stmt {
  const params: unknown[] = [], p = binder(c, params), { q, T } = cols(c)
  return [`SELECT ${q('id')} FROM ${T} WHERE ${where(c, p, queues, now)} ${ORDER(c)} LIMIT ${p(n)}${lock}`, params]
}
function lockIds(c: Connection, ids: string[], n: number, now: number): Stmt {
  const params: unknown[] = [], p = binder(c, params), { q, T } = cols(c)
  return [`SELECT ${q('id')} FROM ${T} WHERE ${q('id')} IN (${ids.map(p).join(', ')}) AND ${where(c, p, '*', now)} ${ORDER(c)} LIMIT ${p(n)} FOR UPDATE SKIP LOCKED`, params]
}
function update(c: Connection, s: Parameters<typeof setClause>[2], ids: string[]): Stmt {
  const params: unknown[] = [], p = binder(c, params), { q, T } = cols(c)
  return [`UPDATE ${T} SET ${setClause(c, p, s)} WHERE ${q('id')} IN (${ids.map(p).join(', ')}) AND ${q('status')} = ${p('queued')}`, params]
}
