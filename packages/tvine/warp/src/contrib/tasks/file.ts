// fileBroker: the default job store — its own SQLite file (`settings.tasks.file`, default ./tasks.db) in WAL mode,
// through its own better-sqlite3 connection: job traffic never touches the app's database
// (docs/design/contrib/tasks.md §Brokers; measurements: .superpowers/sdd/…/jobstore-research.md).
//
// - Every write is ONE `BEGIN IMMEDIATE` transaction (a deferred one that reads first would fail at once with
//   SQLITE_BUSY_SNAPSHOT), so success + next chain link + chord count-down + unique release commit together.
// - SQLITE_BUSY is retried with jittered backoff. busy_timeout is kept short on purpose: SQLite's own wait SLEEPS
//   (blocks this event loop), so long waits happen in async backoff instead.
// - Delayed jobs are status 'scheduled' with their own index, promoted inside the claim transaction: 100k delayed
//   jobs cost a claim nothing (one shared index made it 86× slower).
// - Wake-ups: after a commit the writer touches `<file>.wake` (jobs claimable) / `<file>.moved` (a row with an owner
//   session moved); other processes `fs.watch` them, with a 5 s safety poll (network filesystems, odd bind mounts).
// - Every job-changing transaction takes the next `seq` (one counter row); the progress relay reads `seq > cursor`:
//   exact, commit-ordered, no clock skew, never the main database.
// - Schema versions live in `PRAGMA user_version`, migrated here (not in the app's migration graph).
// - Not for NFS/SMB or a volume shared across a VM boundary (WAL needs shared memory on one host).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { Broker, Claim, ChordSpec, Final, NewJob, QueueStats, SigJSON, WorkerInfo } from './broker.js'
import type { JobRow, JobStatus } from './models.js'
import { bus, checkClaim, shown, sleep, type Moved, type StoreStatus } from './shared.js'

type DB = BetterSqlite3.Database
type Stmt = BetterSqlite3.Statement
export interface FileBrokerOpts {
  path: string
  durable?: boolean          // synchronous=FULL (+ fullfsync on macOS): every commit survives a power cut (~4.5 ms each)
  busyMs?: number            // SQLite's own (blocking) wait before our async retry; default 50
  retryMs?: number           // give up on SQLITE_BUSY after this long; default 30 s
  safetyMs?: number          // wake / relay safety poll; default 5 s
}

// ---- schema (PRAGMA user_version) -----------------------------------------------------------------------
const MIGRATIONS: string[] = [
  `CREATE TABLE job (
     id TEXT PRIMARY KEY, task TEXT NOT NULL, queue TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
     args TEXT, result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3,
     run_at INTEGER NOT NULL, lease_until INTEGER, worker TEXT, token TEXT, acks_late INTEGER NOT NULL DEFAULT 1,
     expires_at INTEGER, progress REAL, message TEXT, sid TEXT, user_id TEXT, group_id TEXT, group_index INTEGER,
     chain TEXT, parent_id TEXT, dup_of TEXT, unique_key TEXT, cancel INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
     started_at INTEGER, finished_at INTEGER, purge_at INTEGER, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX job_ready ON job (priority DESC, run_at, id) WHERE status = 'queued';
   CREATE INDEX job_ready_q ON job (queue, priority DESC, run_at, id) WHERE status = 'queued';
   CREATE INDEX job_sched ON job (run_at) WHERE status = 'scheduled';
   CREATE INDEX job_lease ON job (lease_until) WHERE status = 'running';
   CREATE INDEX job_purge ON job (purge_at) WHERE purge_at IS NOT NULL;
   CREATE INDEX job_seq ON job (seq, id) WHERE sid IS NOT NULL;
   CREATE INDEX job_group ON job (group_id, group_index) WHERE group_id IS NOT NULL;
   CREATE INDEX job_status ON job (status, created_at);
   CREATE INDEX job_created ON job (created_at);
   CREATE TABLE grp (id TEXT PRIMARY KEY, remaining INTEGER NOT NULL, callback TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, purge_at INTEGER);
   CREATE TABLE lock (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE schedule (name TEXT PRIMARY KEY, spec TEXT NOT NULL, next_run_at INTEGER NOT NULL, last_run_at INTEGER);
   CREATE TABLE worker (name TEXT PRIMARY KEY, queues TEXT NOT NULL, concurrency INTEGER NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL,
     started_at INTEGER NOT NULL, beat_at INTEGER NOT NULL, running INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
   INSERT INTO meta (k, v) VALUES ('seq', 0);`,
]
export const SCHEMA_VERSION = MIGRATIONS.length

// ---- row <-> columns ----------------------------------------------------------------------------------
const COLS = ['id', 'task', 'queue', 'priority', 'status', 'args', 'result', 'error', 'attempts', 'maxRetries', 'runAt', 'leaseUntil', 'worker', 'token', 'acksLate',
  'expiresAt', 'progress', 'message', 'sid', 'userId', 'groupId', 'groupIndex', 'chain', 'parentId', 'dupOf', 'uniqueKey', 'cancel', 'createdAt',
  'startedAt', 'finishedAt', 'purgeAt', 'updatedAt'] as const
type Col = (typeof COLS)[number]
const JSONC = new Set<Col>(['args', 'result', 'chain'])
const BOOL = new Set<Col>(['acksLate', 'cancel'])
const snake = (c: string) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
const SNAKE = Object.fromEntries(COLS.map((c) => [c, snake(c)])) as Record<Col, string>
const DEFAULTS: Partial<Record<Col, unknown>> = { attempts: 0, maxRetries: 3, acksLate: true, cancel: false, priority: 0 }

const enc = (c: Col, v: unknown): unknown => (v === undefined || v === null ? null : JSONC.has(c) ? JSON.stringify(v) : BOOL.has(c) ? (v ? 1 : 0) : v)
function dec(r: Record<string, unknown>): JobRow {
  const o: Record<string, unknown> = {}
  for (const c of COLS) {
    const v = r[SNAKE[c]]
    o[c] = v === null || v === undefined ? (BOOL.has(c) ? false : null) : JSONC.has(c) ? JSON.parse(v as string) : BOOL.has(c) ? v === 1 : v
  }
  o.status = shown(o.status as StoreStatus)
  return o as JobRow
}
const moved = (r: Record<string, unknown>): Moved => ({ id: r.id as string, task: r.task as string, status: shown(r.status as StoreStatus), progress: r.progress as number | null, message: r.message as string | null, sid: r.sid as string | null, userId: r.user_id as string | null, attempts: r.attempts as number })
const busy = (e: unknown) => { const c = (e as { code?: string })?.code ?? ''; return c.startsWith('SQLITE_BUSY') || c === 'SQLITE_LOCKED' }

// ---- wake sentinels ------------------------------------------------------------------------------------
// touch = pwrite 1 byte at offset 0 (the file never grows); watchers get the fs event in ~1 ms. One fs.watch per
// file per process; listeners also get a safety call every safetyMs (a missed event, a watcher that died).
class Sentinel {
  private fd: number
  private listeners = new Set<() => void>()
  private watcher?: fs.FSWatcher
  private timer?: NodeJS.Timeout
  private touching = false
  private firing = false
  private static BYTE = Buffer.from([0x2a])
  constructor(private file: string, private safetyMs: number) {
    this.fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644)
    if (fs.fstatSync(this.fd).size === 0) fs.writeSync(this.fd, Sentinel.BYTE, 0, 1, 0)
  }
  touch(): void {
    if (this.touching) return
    this.touching = true
    setImmediate(() => {
      this.touching = false
      try { fs.writeSync(this.fd, Sentinel.BYTE, 0, 1, 0) } catch { /* closed: the safety poll covers */ }
    })
  }
  on(fn: () => void): () => void {
    this.listeners.add(fn)
    this.arm()
    this.timer ??= setInterval(() => { this.arm(); this.fire() }, this.safetyMs).unref()
    return () => {
      this.listeners.delete(fn)
      if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; clearInterval(this.timer); this.timer = undefined }
    }
  }
  private arm(): void {
    if (this.watcher || !this.listeners.size) return
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, () => this.fire())
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch { this.watcher = undefined }   // e.g. the file was removed: re-armed by the safety poll
  }
  private fire(): void {
    if (this.firing) return
    this.firing = true
    setImmediate(() => { this.firing = false; for (const f of [...this.listeners]) { try { f() } catch { /* a listener's own failure */ } } })
  }
  close(): void {
    this.watcher?.close(); clearInterval(this.timer); this.listeners.clear()
    try { fs.closeSync(this.fd) } catch { /* already */ }
  }
}

export function fileBroker(o: FileBrokerOpts): FileBroker { return new FileBroker(o) }

export class FileBroker implements Broker {
  readonly path: string
  private db: DB
  private stmts = new Map<string, Stmt>()
  private run: BetterSqlite3.Transaction<(f: () => unknown) => unknown>
  private wakeFile: Sentinel
  private movedFile: Sentinel
  private flags = { wake: false, moved: false, seq: 0 }
  private retryMs: number
  private safetyMs: number
  private lastCheckpoint = 0
  busyRetries = 0

  constructor(o: FileBrokerOpts) {
    this.path = path.resolve(o.path)
    this.retryMs = o.retryMs ?? 30_000
    this.safetyMs = o.safetyMs ?? 5_000
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
    const db = (this.db = new Database(this.path))
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(o.busyMs ?? 50))}`)
    db.pragma('auto_vacuum = INCREMENTAL')   // only takes on a new file (before any table): freed pages go back in cleanup
    this.retrySync(() => db.pragma('journal_mode = WAL'))
    db.pragma(`synchronous = ${o.durable ? 'FULL' : 'NORMAL'}`)
    if (o.durable && process.platform === 'darwin') { db.pragma('fullfsync = 1'); db.pragma('checkpoint_fullfsync = 1') }
    db.pragma('mmap_size = 268435456')
    db.pragma('cache_size = -16000')
    db.pragma('temp_store = MEMORY')
    this.run = db.transaction((f: () => unknown) => f())
    this.migrate()
    this.wakeFile = new Sentinel(`${this.path}.wake`, this.safetyMs)
    this.movedFile = new Sentinel(`${this.path}.moved`, this.safetyMs)
  }

  private migrate(): void {
    const have = () => this.db.pragma('user_version', { simple: true }) as number
    if (have() === SCHEMA_VERSION) return
    this.retrySync(() => this.run.immediate(() => {
      const v = have()   // re-read under the write lock: another process may have migrated meanwhile
      if (v > SCHEMA_VERSION) throw new Error(`${this.path}: tasks.db schema v${v} is newer than this Tvine (v${SCHEMA_VERSION}); upgrade, or point settings.tasks.file elsewhere`)
      for (let i = v; i < SCHEMA_VERSION; i++) this.db.exec(MIGRATIONS[i]!)
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }))
  }

  // the constructor's few writes (WAL switch, migration) wait synchronously; everything else retries async
  private retrySync<T>(f: () => T): T {
    const end = Date.now() + this.retryMs
    for (;;) {
      try { return f() } catch (e) {
        if (!busy(e) || Date.now() > end) throw e
        this.busyRetries++
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.random() * 20)
      }
    }
  }

  private st(sql: string): Stmt {
    let s = this.stmts.get(sql)
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)))
    return s
  }

  // ONE immediate transaction, SQLITE_BUSY retried with jittered exponential backoff; after COMMIT the wake /
  // moved sentinels are touched (and the in-process bus fired) when the transaction asked for it
  private async tx<T>(f: () => T): Promise<T> {
    const end = Date.now() + this.retryMs
    for (let i = 0; ; i++) {
      this.flags = { wake: false, moved: false, seq: 0 }
      try {
        const out = this.run.immediate(f) as T
        if (this.flags.wake) { this.wakeFile.touch(); setImmediate(() => bus.emit('enqueued')) }
        if (this.flags.moved) this.movedFile.touch()
        return out
      } catch (e) {
        if (!busy(e) || Date.now() > end) throw e
        this.busyRetries++
        await sleep(Math.min(250, 2 ** i) * (0.5 + Math.random()))
      }
    }
  }
  private async read<T>(f: () => T): Promise<T> {
    const end = Date.now() + this.retryMs
    for (let i = 0; ; i++) {
      try { return f() } catch (e) {
        if (!busy(e) || Date.now() > end) throw e
        await sleep(Math.min(250, 2 ** i))
      }
    }
  }
  // the transaction's seq (taken once, on its first job change)
  private seq(): number {
    return (this.flags.seq ||= (this.st(`UPDATE meta SET v = v + 1 WHERE k = 'seq' RETURNING v`).get() as { v: number }).v)
  }
  private touched(sid: unknown): void { if (sid) this.flags.moved = true }

  // ---- writes inside a transaction -------------------------------------------------------------------
  private insert(j: NewJob, now: number): void {
    const row: Record<string, unknown> = { ...DEFAULTS, ...j }
    if (row.status === 'queued' && (row.runAt as number) > now) row.status = 'scheduled'
    const cols = COLS.filter((c) => row[c] !== undefined)
    this.st(`INSERT INTO job (${cols.map((c) => SNAKE[c]).join(', ')}, seq) VALUES (${cols.map(() => '?').join(', ')}, ?)`)
      .run(...cols.map((c) => enc(c, row[c])), this.seq())
    if (row.status === 'queued' || row.status === 'scheduled') this.flags.wake = true
    this.touched(row.sid)
  }
  // a CAS on id + token + status='running' (the fence); the row after, or undefined when the token lost
  private settle(id: string, token: string, patch: Partial<Record<Col | 'status', unknown>>, expiredBefore?: number): Record<string, unknown> | undefined {
    const keys = Object.keys(patch) as Col[], exp = expiredBefore !== undefined
    const r = this.st(`UPDATE job SET ${keys.map((k) => `${SNAKE[k]} = ?`).join(', ')}, updated_at = ?, seq = ? WHERE id = ? AND token = ? AND status = 'running'${exp ? ' AND lease_until < ?' : ''} RETURNING *`)
      .get(...keys.map((k) => enc(k, patch[k])), Date.now(), this.seq(), id, token, ...(exp ? [expiredBefore] : [])) as Record<string, unknown> | undefined
    if (r) this.touched(r.sid)
    return r
  }
  private unlockTx(key: string, owner: string): void { this.st('DELETE FROM lock WHERE key = ? AND owner = ?').run(key, owner) }
  private afterFinal(j: Pick<JobRow, 'id' | 'uniqueKey' | 'groupId'>, status: JobStatus, purgeAt: number): void {
    if (j.uniqueKey) this.unlockTx(j.uniqueKey, j.id)
    if (j.groupId && status !== 'success') this.st(`UPDATE grp SET status = 'failed', purge_at = ? WHERE id = ? AND status = 'pending'`).run(purgeAt, j.groupId)
  }
  private lockTx(key: string, owner: string, ttlMs: number, now: number): boolean {
    // insert, renew (same owner) or take over (expired) — one statement, never a unique violation
    return this.st(`INSERT INTO lock (key, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE lock.owner = excluded.owner OR lock.expires_at <= ?`).run(key, owner, now + ttlMs, now).changes === 1
  }
  private exists(id: string): boolean { return !!this.st('SELECT 1 FROM job WHERE id = ?').get(id) }

  // ---- Broker --------------------------------------------------------------------------------------------
  async enqueue(jobs: NewJob[], chord?: ChordSpec) {
    if (!jobs.length) return
    await this.tx(() => {
      if (this.exists(jobs[0]!.id)) return   // already enqueued (an outbox row relayed twice)
      const now = Date.now()
      if (chord) this.st('INSERT INTO grp (id, remaining, callback, created_at) VALUES (?, ?, ?, ?)').run(chord.id, chord.remaining, JSON.stringify(chord.callback), now)
      for (const j of jobs) this.insert(j, now)
    })
  }

  async enqueueUnique(job: NewJob, key: string, windowMs: number, ttlMs: number) {
    await this.tx(() => {
      if (this.exists(job.id)) return
      const now = Date.now()
      if (this.lockTx(key, job.id, windowMs, now)) return this.insert({ ...job, uniqueKey: key }, now)
      const held = this.st('SELECT owner FROM lock WHERE key = ?').get(key) as { owner: string } | undefined
      this.insert({ ...job, status: 'deduped', dupOf: held?.owner ?? null, finishedAt: now, purgeAt: now + ttlMs }, now)
    })
  }

  async get(id: string) {
    const r = await this.read(() => this.st('SELECT * FROM job WHERE id = ?').get(id) as Record<string, unknown> | undefined)
    return r && dec(r)
  }

  async list({ status, queue, limit }: { status?: string; queue?: string; limit: number }) {
    const w: string[] = [], p: unknown[] = []
    if (status) { w.push(status === 'queued' ? `status IN ('queued', 'scheduled')` : 'status = ?'); if (status !== 'queued') p.push(status) }
    if (queue) { w.push('queue = ?'); p.push(queue) }
    const rows = await this.read(() => this.st(`SELECT * FROM job ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...p, limit) as Record<string, unknown>[])
    return rows.map(dec)
  }

  async claim({ worker, queues, n, leaseMs, now = Date.now(), skipTasks = [] }: Claim) {
    checkClaim(n, queues)
    const token = randomUUID(), skip = skipTasks.slice(0, 100)
    const where = `status = 'queued' AND run_at <= ?${queues === '*' ? '' : ` AND queue IN (${queues.map(() => '?').join(', ')})`}${skip.length ? ` AND task NOT IN (${skip.map(() => '?').join(', ')})` : ''}`
    const rows = await this.tx(() => {
      // due delayed jobs become claimable in the same transaction (≤1000 a claim; the rest on the next)
      this.st(`UPDATE job SET status = 'queued' WHERE id IN (SELECT id FROM job WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at LIMIT 1000)`).run(now)
      const got = this.st(`UPDATE job SET status = 'running', worker = ?, token = ?, lease_until = ?, attempts = attempts + 1, started_at = ?, updated_at = ?, seq = ?
        WHERE id IN (SELECT id FROM job WHERE ${where} ORDER BY priority DESC, run_at, id LIMIT ?) RETURNING *`)
        .all(worker, token, now + leaseMs, now, now, this.seq(), now, ...(queues === '*' ? [] : queues), ...skip, n) as Record<string, unknown>[]
      for (const r of got) this.touched(r.sid)
      return got
    })
    const jobs = rows.map(dec).sort((a, b) => b.priority - a.priority || a.runAt - b.runAt || (a.id < b.id ? -1 : 1))
    let nextAt: number | undefined
    if (jobs.length < n) nextAt = (await this.read(() => this.st(`SELECT min(run_at) AS t FROM job WHERE status = 'scheduled'`).get() as { t: number | null })).t ?? undefined
    return { token, jobs, ...(nextAt !== undefined && { nextAt }) }
  }

  async heartbeat(runs: { id: string; token: string }[], leaseMs: number) {
    if (!runs.length) return { lost: [], cancelled: [] }
    return this.tx(() => {
      const now = Date.now(), lost: string[] = [], cancelled: string[] = []
      const s = this.st(`UPDATE job SET lease_until = ? WHERE id = ? AND token = ? AND status = 'running' RETURNING cancel`)
      for (const r of runs) {
        const got = s.get(now + leaseMs, r.id, r.token) as { cancel: number } | undefined
        if (!got) lost.push(r.id)
        else if (got.cancel) cancelled.push(r.id)
      }
      return { lost, cancelled }
    })
  }

  async progress(id: string, token: string, pct: number, message: string | null) {
    return this.tx(() => !!this.settle(id, token, { progress: pct, message }))
  }

  async succeed(job: JobRow, token: string, o: Parameters<Broker['succeed']>[2]) {
    return this.tx(() => {
      const now = Date.now()
      if (!this.settle(job.id, token, { status: 'success', result: o.result, error: null, progress: 100, finishedAt: now, purgeAt: o.purgeAt, leaseUntil: null })) return false
      if (o.next) this.insert(o.next, now)
      if (job.groupId) this.chordStep(job, o.callback)
      if (job.uniqueKey) this.unlockTx(job.uniqueKey, job.id)
      return true
    })
  }

  // inside the member's success transaction (the write lock is held: members serialize); the one reaching 0 fires
  private chordStep(job: JobRow, build?: (sig: SigJSON, results: unknown[]) => NewJob | undefined): void {
    const g = this.st(`UPDATE grp SET remaining = remaining - 1 WHERE id = ? AND status = 'pending' RETURNING remaining, callback`).get(job.groupId) as { remaining: number; callback: string } | undefined
    if (!g || g.remaining > 0) return
    this.st(`UPDATE grp SET status = 'fired', purge_at = ? WHERE id = ?`).run(job.purgeAt ?? Date.now() + 86_400_000, job.groupId)
    const results = (this.st('SELECT result FROM job WHERE group_id = ? ORDER BY group_index').all(job.groupId) as { result: string | null }[]).map((r) => (r.result == null ? null : JSON.parse(r.result)))
    const cb = build?.(JSON.parse(g.callback) as SigJSON, results)
    if (cb) this.insert(cb, Date.now())
  }

  async finish(job: JobRow, token: string, status: Final, o: { error?: string | null; purgeAt: number; expiredBefore?: number }) {
    return this.tx(() => {
      if (!this.settle(job.id, token, { status, finishedAt: Date.now(), purgeAt: o.purgeAt, leaseUntil: null, ...(o.error !== undefined && { error: o.error }) }, o.expiredBefore)) return false
      this.afterFinal(job, status, o.purgeAt)
      return true
    })
  }

  async requeue(id: string, token: string, o: { runAt: number; error?: string | null; refund?: boolean; expiredBefore?: number }) {
    return this.tx(() => {
      const r = this.settle(id, token, {
        status: o.runAt > Date.now() ? 'scheduled' : 'queued', runAt: o.runAt, worker: null, token: null, leaseUntil: null,
        ...(o.error !== undefined && { error: o.error }),
      }, o.expiredBefore)
      if (!r) return false
      if (o.refund) this.st('UPDATE job SET attempts = attempts - 1 WHERE id = ?').run(id)
      this.flags.wake = true
      return true
    })
  }

  async expired(now: number, limit: number) {
    return (await this.read(() => this.st(`SELECT * FROM job WHERE status = 'running' AND lease_until < ? ORDER BY lease_until LIMIT ?`).all(now, limit) as Record<string, unknown>[])).map(dec)
  }

  async cancel(id: string, ttlMs: number) {
    return this.tx((): JobStatus | undefined => {
      const r = this.st('SELECT * FROM job WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!r) return undefined
      const j = dec(r), now = Date.now()
      if (r.status === 'queued' || r.status === 'scheduled') {
        this.st(`UPDATE job SET status = 'cancelled', finished_at = ?, purge_at = ?, updated_at = ?, seq = ? WHERE id = ?`).run(now, now + ttlMs, now, this.seq(), id)
        this.touched(r.sid)
        this.afterFinal(j, 'cancelled', now + ttlMs)
        return 'cancelled'
      }
      if (r.status === 'running') this.st('UPDATE job SET cancel = 1, updated_at = ? WHERE id = ?').run(now, id)
      return j.status
    })
  }

  async retry(id: string) {
    return this.tx((): JobStatus | 'requeued' | undefined => {
      const r = this.st('SELECT status, sid FROM job WHERE id = ?').get(id) as { status: StoreStatus; sid: string | null } | undefined
      if (!r) return undefined
      if (!['dead', 'expired', 'cancelled'].includes(r.status)) return shown(r.status)
      const now = Date.now()
      this.st(`UPDATE job SET status = 'queued', attempts = 0, run_at = ?, error = NULL, finished_at = NULL, purge_at = NULL, cancel = 0, expires_at = NULL,
        worker = NULL, token = NULL, lease_until = NULL, updated_at = ?, seq = ? WHERE id = ?`).run(now, now, this.seq(), id)
      this.touched(r.sid)
      this.flags.wake = true
      return 'requeued'
    })
  }

  async purge(status: JobStatus) {
    return this.tx(() => this.st(status === 'queued' ? `DELETE FROM job WHERE status IN ('queued', 'scheduled')` : 'DELETE FROM job WHERE status = ?').run(...(status === 'queued' ? [] : [status])).changes)
  }

  async lock(key: string, owner: string, ttlMs: number, now = Date.now()) { return this.tx(() => this.lockTx(key, owner, ttlMs, now)) }
  async unlock(key: string, owner: string) { await this.tx(() => this.unlockTx(key, owner)) }

  async schedule(name: string, spec: string, first: () => number) {
    return this.tx(() => {
      const row = this.st('SELECT spec, next_run_at FROM schedule WHERE name = ?').get(name) as { spec: string; next_run_at: number } | undefined
      if (row && row.spec === spec) return { nextRunAt: row.next_run_at, fresh: false }
      const nextRunAt = first()
      this.st(`INSERT INTO schedule (name, spec, next_run_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET spec = excluded.spec, next_run_at = excluded.next_run_at`).run(name, spec, nextRunAt)
      return { nextRunAt, fresh: true }
    })
  }

  async fire(name: string, due: number, next: number, jobs: NewJob[]) {
    return this.tx(() => {
      const now = Date.now()
      if (!this.st('UPDATE schedule SET next_run_at = ?, last_run_at = ? WHERE name = ? AND next_run_at = ?').run(next, now, name, due).changes) return false
      for (const j of jobs) this.insert(j, now)
      return true
    })
  }

  async register(w: WorkerInfo) {
    const now = Date.now()
    await this.tx(() => this.st(`INSERT OR REPLACE INTO worker (name, queues, concurrency, pid, host, started_at, beat_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(w.name, w.queues, w.concurrency, w.pid, w.host, now, now))
  }
  async beat(name: string, running: number, processed: number) { await this.tx(() => this.st('UPDATE worker SET beat_at = ?, running = ?, processed = ? WHERE name = ?').run(Date.now(), running, processed, name)) }
  async unregister(name: string) { await this.tx(() => this.st('DELETE FROM worker WHERE name = ?').run(name)) }

  // result TTL + housekeeping, in short transactions (≤1000 rows each: a big purge never holds the write lock long);
  // then give freed pages back (incremental vacuum) and, when the queue is idle, truncate the WAL
  async cleanup(now: number) {
    for (;;) {
      const n = await this.tx(() => this.st(`DELETE FROM job WHERE id IN (SELECT j.id FROM job j WHERE j.purge_at <= ?
        AND (j.group_id IS NULL OR NOT EXISTS (SELECT 1 FROM grp g WHERE g.id = j.group_id AND g.status = 'pending')) LIMIT 1000)`).run(now).changes)
      if (n < 1000) break
    }
    await this.tx(() => {
      this.st('DELETE FROM grp WHERE purge_at <= ?').run(now)
      this.st('DELETE FROM lock WHERE expires_at <= ?').run(now - 60_000)
      this.st('DELETE FROM worker WHERE beat_at < ?').run(now - 86_400_000)
    })
    await this.read(() => this.db.pragma('incremental_vacuum(2000)'))
    if (now - this.lastCheckpoint > 300_000) {
      const idle = !(this.db.prepare(`SELECT 1 FROM job WHERE status IN ('queued', 'running') LIMIT 1`).get())
      if (idle) { this.lastCheckpoint = now; await this.read(() => this.db.pragma('wal_checkpoint(TRUNCATE)')) }
    }
  }

  // `tvine tasks compact`: VACUUM (locks the file for its duration) + WAL truncate; the file's bytes before / after
  async compact(): Promise<{ before: number; after: number }> {
    const size = () => [this.path, `${this.path}-wal`].reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0)
    const before = size()
    await this.read(() => this.db.exec('VACUUM'))
    await this.read(() => this.db.pragma('wal_checkpoint(TRUNCATE)'))
    return { before, after: size() }
  }

  async stats(leaseMs: number): Promise<QueueStats> {
    return this.read(() => {
      const now = Date.now()
      const count = (s: string) => (this.st(`SELECT count(*) AS n FROM job WHERE status = ?`).get(s) as { n: number }).n
      const workers = this.st('SELECT * FROM worker ORDER BY name LIMIT 200').all() as { name: string; queues: string; running: number; processed: number; beat_at: number }[]
      const beat = (this.st('SELECT owner FROM lock WHERE key = ? AND expires_at > ?').get('beat', now) as { owner: string } | undefined)?.owner
      return {
        queued: count('queued'), scheduled: count('scheduled'), running: count('running'), dead: count('dead'), ...(beat && { beat }),
        workers: workers.map((w) => ({ name: w.name, queues: w.queues, running: w.running, processed: w.processed, beatAgoMs: now - w.beat_at, stale: now - w.beat_at > leaseMs })),
      }
    })
  }

  // the progress feed: rows with an owner session whose seq passed the cursor, read when `<file>.moved` is touched
  // (any process) and on the safety poll — from tasks.db, never the main database
  watch(fn: (j: Moved) => void) {
    let cur = { seq: (this.st(`SELECT v FROM meta WHERE k = 'seq'`).get() as { v: number }).v, id: '' }
    let busyNow = false, again = false, stopped = false
    const page = this.st(`SELECT id, task, status, progress, message, sid, user_id, attempts, seq FROM job WHERE sid IS NOT NULL AND (seq, id) > (?, ?) ORDER BY seq, id LIMIT 500`)
    const pull = () => {
      if (stopped) return
      if (busyNow) { again = true; return }
      busyNow = true
      try {
        do {
          again = false
          for (;;) {
            const rows = page.all(cur.seq, cur.id) as (Record<string, unknown> & { seq: number; id: string })[]
            for (const r of rows) { cur = { seq: r.seq, id: r.id }; try { fn(moved(r)) } catch { /* a watcher's own failure */ } }
            if (rows.length < 500 || stopped) break
          }
        } while (again && !stopped)
      } catch { /* closing / busy: the next touch or safety poll retries */ } finally { busyNow = false }
    }
    const off = this.movedFile.on(pull)
    return () => { stopped = true; off() }
  }

  onWake(fn: () => void) { return this.wakeFile.on(fn) }

  async close() {
    this.wakeFile.close(); this.movedFile.close()
    if (this.db.open) this.db.close()
  }
}
