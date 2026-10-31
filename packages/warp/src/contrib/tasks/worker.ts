// The worker (docs/design/contrib/tasks.md §Worker): claims with leases, runs attempts with an AbortSignal and
// timeouts, heartbeats, reaps expired leases, retries with backoff, dead-letters, cleans results, and shuts
// down gracefully (finish or release within the grace period). Every job access goes through the Broker.
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { broker as current, brokerKind, bus, type Broker, type Final } from './broker.js'
import { metrics } from '../../core/metrics.js'
import type { JobRow } from './models.js'
import { config, followUp, parseRate, Retry, taskById, type SigJSON, type Task, type TaskCtx } from './task.js'
import { auditSinkSet, sidHash, writeAudit, type AuditRow } from '../../core/audit.js'
import { redactSecrets } from '../../core/redact.js'

export type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
export interface WorkerOpts {
  name?: string
  queues?: string[] | '*'            // default every queue
  concurrency?: number               // default 10
  leaseMs?: number; pollMs?: number; graceMs?: number   // default settings.tasks
  claimBatch?: number                // jobs per claim (default settings.tasks.claimBatch)
  broker?: Broker
  log?: Log
}

export class SoftTimeLimit extends Error { constructor() { super('soft time limit exceeded'); this.name = 'SoftTimeLimit' } }
export class HardTimeLimit extends Error { constructor() { super('hard time limit exceeded'); this.name = 'HardTimeLimit' } }
class Stop extends Error { constructor(why: string) { super(why); this.name = 'Stop' } }

interface Running {
  job: JobRow; token: string; ac: AbortController; done: Promise<void>
  lost?: boolean; cancelled?: boolean; released?: boolean; zombie?: boolean
  progress?: { at: number; timer?: NodeJS.Timeout; pending?: { p: number; m?: string } }
}

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 2000)
const CLEAN_MS = 60_000

export class Worker {
  readonly name: string
  readonly queues: string[] | '*'
  readonly concurrency: number
  private broker: Broker
  private log: Log
  private leaseMs: number; private pollMs: number; private graceMs: number; private claimBatch: number
  private running = new Map<string, Running>()
  private timers: NodeJS.Timeout[] = []
  private beatTimer?: NodeJS.Timeout
  private dueTimer?: NodeJS.Timeout   // the next delayed job / rate-limit slot
  private dueAt = Infinity
  private offWake?: () => void
  private stopping = false
  private ticking = false
  private again = false
  private processed = 0
  private zombieCount = 0
  private rates = new Map<string, number[]>()
  private onEnqueued = () => { void this.tick() }

  constructor(o: WorkerOpts = {}) {
    this.name = o.name ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
    this.queues = o.queues ?? '*'
    this.concurrency = o.concurrency ?? 10
    if (!Number.isInteger(this.concurrency) || this.concurrency < 0) throw new Error('worker concurrency must be an integer >= 0')
    this.broker = o.broker ?? current()
    this.log = o.log ?? (() => {})
    this.leaseMs = o.leaseMs ?? config.tasks.leaseMs
    this.pollMs = o.pollMs ?? config.tasks.pollMs
    this.graceMs = o.graceMs ?? config.tasks.graceMs
    this.claimBatch = Math.min(100, Math.max(1, o.claimBatch ?? config.tasks.claimBatch ?? 100))
  }

  get busy(): number { return this.running.size }
  // hard-timed-out / abandoned handlers still running: they hold their slot until they actually settle
  get zombies(): number { return this.zombieCount }

  async start(): Promise<void> {
    await this.broker.register({ name: this.name, queues: this.queues === '*' ? '*' : this.queues.join(','), concurrency: this.concurrency, pid: process.pid, host: hostname() })
    this.log('info', 'worker.start', { worker: this.name, queues: this.queues, concurrency: this.concurrency })
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => { fn().catch((e) => this.log('error', 'worker.loop', { worker: this.name, error: errText(e) })) }, ms)
      this.timers.push(t)
    }
    if (this.concurrency > 0) {
      // a broker that pushes wake-ups (file: fs.watch, redis: pub/sub, memory: events) also runs the safety poll;
      // the db broker is polled every pollMs
      if (this.broker.onWake) this.offWake = this.broker.onWake(this.onEnqueued)
      else every(this.pollMs, () => this.tick())
      bus.on('enqueued', this.onEnqueued)
    }
    this.beatTimer = setInterval(() => { this.heartbeat().catch((e) => this.log('error', 'worker.heartbeat', { worker: this.name, error: errText(e) })) }, Math.max(100, Math.floor(this.leaseMs / 3)))
    every(this.leaseMs, () => this.reap())
    every(CLEAN_MS, () => this.cleanup())
    await this.reap()
    void this.tick()
  }

  // stop claiming; wait for running jobs up to graceMs; abort + release the rest (attempt not spent)
  async stop(graceMs = this.graceMs): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    bus.off('enqueued', this.onEnqueued)
    this.offWake?.()
    clearTimeout(this.dueTimer)
    for (const t of this.timers.splice(0)) clearInterval(t)
    const deadline = Date.now() + graceMs
    while (this.running.size && Date.now() < deadline) {
      await Promise.race([Promise.all([...this.running.values()].map((r) => r.done)), new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))))])
    }
    for (const r of [...this.running.values()]) {
      r.released = true
      r.ac.abort(new Stop('worker shutting down'))
      const ok = r.zombie ? false : await this.broker.requeue(r.job.id, r.token, { runAt: Date.now(), refund: true })
      this.log('warn', 'job.released', { worker: this.name, jobId: r.job.id, task: r.job.task, released: ok })
      this.running.delete(r.job.id)
    }
    clearInterval(this.beatTimer)
    await this.broker.unregister(this.name).catch(() => undefined)
    this.log('info', 'worker.stop', { worker: this.name, processed: this.processed })
  }

  // claim up to the free slots; again at once while claims come back full or a slot frees mid-tick
  async tick(): Promise<void> {
    if (this.stopping || this.concurrency === 0) return
    if (this.ticking) { this.again = true; return }
    this.ticking = true
    try {
      do {
        this.again = false
        const free = this.concurrency - this.running.size
        if (free <= 0) break
        const n = Math.min(free, this.claimBatch), skipTasks = this.overLimit()
        const { token, jobs, nextAt } = await this.broker.claim({ worker: this.name, queues: this.queues, n, leaseMs: this.leaseMs, skipTasks })
        if (jobs.length) metrics.inc('tvine_tasks_claims_total', { broker: brokerKind() ?? 'file' }, jobs.length)
        if (nextAt !== undefined) this.due(nextAt)
        if (skipTasks.length) this.due(this.limitFrees())
        if (this.stopping) {   // stop() began during the claim: hand these straight back
          for (const j of jobs) await this.broker.requeue(j.id, token, { runAt: Date.now(), refund: true })
          return
        }
        for (const j of jobs) this.launch(j, token)
        if (jobs.length === n) this.again = true
      } while (this.again && !this.stopping)
    } finally { this.ticking = false }
  }

  // wake for the earliest known future moment (a delayed job's runAt, a rate-limit slot freeing)
  private due(at: number): void {
    if (this.stopping || !(at < this.dueAt)) return
    clearTimeout(this.dueTimer)
    this.dueAt = at
    this.dueTimer = setTimeout(() => { this.dueAt = Infinity; void this.tick() }, Math.max(0, Math.min(at - Date.now() + 1, 2 ** 31 - 1)))
    this.dueTimer.unref()
  }

  private launch(job: JobRow, token: string): void {
    let done!: () => void
    const r: Running = { job, token, ac: new AbortController(), done: new Promise<void>((ok) => { done = ok }) }
    this.running.set(job.id, r)
    void this.execute(r)
      .catch((e) => this.log('error', 'job.internal', { worker: this.name, jobId: job.id, task: job.task, error: errText(e) }))
      .finally(() => {
        clearTimeout(r.progress?.timer)
        this.running.delete(job.id)
        this.processed++
        done()
        void this.tick()
      })
  }

  private async execute(r: Running): Promise<void> {
    const { job } = r, t0 = Date.now()
    const task = taskById(job.task)
    const base = { worker: this.name, jobId: job.id, task: job.task, attempt: job.attempts, queue: job.queue }
    if (!task) return this.fail(r, new Error(`unregistered task ${job.task}`), undefined, 30_000)
    if (job.cancel) return this.final(r, 'cancelled', {})
    if (job.expiresAt != null && t0 > job.expiresAt) {
      this.log('info', 'job.expired', base)
      return this.final(r, 'expired', { error: 'expired before it started' })
    }
    const wait = this.take(task)
    if (wait > 0) {   // claimed in a race with the limit: back to the queue when allowed, no attempt spent
      await this.broker.requeue(job.id, r.token, { runAt: Date.now() + wait, refund: true })
      return
    }
    const parsed = task.schema.safeParse(job.args)
    if (!parsed.success) return this.final(r, 'dead', { error: `invalid args: ${parsed.error.issues[0]?.message ?? 'rejected'}` })

    this.log('info', 'job.start', { ...base, ...(task.opts.logArgs && { args: job.args }) })
    const parent = job.parentId ? await this.broker.get(job.parentId) : undefined
    const ctx: TaskCtx = {
      jobId: job.id, task: job.task, attempt: job.attempts, queue: job.queue, signal: r.ac.signal,
      ...(parent && { parent: { jobId: parent.id, result: parent.result } }),
      progress: (pct, message) => this.progress(r, pct, message),
      retry: (o = {}) => new Retry(o.inMs),
      log: (msg, data) => this.log('info', 'job.log', { msg, ...data, ...base }),   // base last: a handler cannot forge ids
    }
    const tm = typeof task.opts.timeoutMs === 'number' ? { hard: task.opts.timeoutMs } : { hard: 300_000, ...task.opts.timeoutMs }
    const timers: NodeJS.Timeout[] = []
    const work = Promise.resolve().then(() => task.run(parsed.data, ctx))
    work.catch(() => undefined)
    try {
      if (tm.soft !== undefined) timers.push(setTimeout(() => r.ac.abort(new SoftTimeLimit()), tm.soft))
      const hard = new Promise<never>((_, rej) => {
        timers.push(setTimeout(() => { const e = new HardTimeLimit(); r.ac.abort(e); rej(e) }, tm.hard ?? 300_000))
      })
      const stop = new Promise<never>((_, rej) => r.ac.signal.addEventListener('abort', () => {
        const why = r.ac.signal.reason
        if (why instanceof Stop) rej(why)   // lease lost / revoked / shutdown: settle at once (the handler may still run)
      }, { once: true }))
      const result = await Promise.race([work, hard, stop])
      if (r.lost || r.released) return
      if (r.cancelled) return this.final(r, 'cancelled', {})
      let stored: unknown
      try { stored = result === undefined ? null : JSON.parse(JSON.stringify(result)) }
      catch (e) { return this.final(r, 'dead', { error: `result is not JSON: ${errText(e)}` }) }
      await this.succeed(r, task, stored, Date.now() - t0)
    } catch (e) {
      if (r.released) return
      if (r.lost) this.log('warn', 'job.lost', { ...base, ms: Date.now() - t0 })
      else if (r.cancelled) await this.final(r, 'cancelled', { error: 'revoked' })
      else await this.fail(r, e, task)
      await this.zombie(r, work)
    } finally { for (const t of timers) clearTimeout(t) }
  }

  // ponytail: JS cannot kill a promise; a handler that ignores ctx.signal keeps its slot until it settles (counted
  // against concurrency, so a pile of them stops this worker claiming instead of overloading it). Worker threads
  // (killable) if real handlers hang.
  private async zombie(r: Running, work: Promise<unknown>): Promise<void> {
    let settled = false
    work.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    if (settled) return
    r.zombie = true
    this.zombieCount++
    this.log('warn', 'job.zombie', { worker: this.name, jobId: r.job.id, task: r.job.task, zombies: this.zombieCount })
    try { await work.catch(() => undefined) } finally {
      this.zombieCount--
      this.log('info', 'job.zombie.done', { worker: this.name, jobId: r.job.id, task: r.job.task })
    }
  }

  private async succeed(r: Running, task: Task, result: unknown, ms: number): Promise<void> {
    const { job } = r
    const rest = (job.chain as SigJSON[] | null) ?? []
    const next = rest.length ? this.link(job, () => followUp(rest[0]!, result, job, { chain: rest.length > 1 ? rest.slice(1) : null })) : undefined
    const ok = await this.broker.succeed(job, r.token, {
      result, purgeAt: Date.now() + (task.opts.resultTtlMs ?? config.tasks.resultTtlMs), next,
      callback: (sig, results) => this.link(job, () => followUp(sig, results, job, { groupId: null })),
    })
    if (ok) this.log('info', 'job.ok', { worker: this.name, jobId: job.id, task: job.task, attempt: job.attempts, ms })
    if (ok) await auditJob(job, ms)
    else this.log('warn', 'job.lost', { worker: this.name, jobId: job.id, task: job.task, ms })
  }

  // the next chain link / chord callback row; args it refuses (or an unregistered task) break the canvas there,
  // never the parent's success (validation runs before any write, so the transaction stays clean)
  private link(job: JobRow, make: () => ReturnType<typeof followUp>): ReturnType<typeof followUp> | undefined {
    try { return make() } catch (e) {
      this.log('error', 'canvas.broken', { worker: this.name, jobId: job.id, task: job.task, error: errText(e) })
      return undefined
    }
  }

  private async fail(r: Running, e: unknown, task?: Task, fixedMs?: number): Promise<void> {
    const { job } = r
    const retry = e instanceof Retry || (task ? retryable(task, e) : true)
    const base = { worker: this.name, jobId: job.id, task: job.task, attempt: job.attempts, error: errText(e) }
    metrics.inc('tvine_tasks_failures_total', { broker: brokerKind() ?? 'file' })
    if (retry && job.attempts <= job.maxRetries) {
      const inMs = e instanceof Retry && e.inMs !== undefined ? e.inMs : fixedMs ?? backoff(task?.opts.retryBackoff, job.attempts)
      if (await this.broker.requeue(job.id, r.token, { runAt: Date.now() + inMs, error: errText(e) })) this.log('warn', 'job.retry', { ...base, inMs })
      return
    }
    this.log('error', 'job.dead', base)
    await this.final(r, 'dead', { error: errText(e) })
    await auditJob(job, Date.now() - (job.startedAt ?? Date.now()), 'dead')
  }

  private async final(r: Running, status: Final, o: { error?: string }): Promise<void> {
    const ttl = taskById(r.job.task)?.opts.resultTtlMs ?? config.tasks.resultTtlMs
    await this.broker.finish(r.job, r.token, status, { ...o, purgeAt: Date.now() + ttl })
  }

  // ctx.progress: written at most every 250 ms per job; the last value always lands (trailing write)
  private async progress(r: Running, pct: number, message?: string): Promise<void> {
    if (typeof pct !== 'number' || Number.isNaN(pct)) throw new TypeError('progress(pct): pct must be a number 0-100')
    const st = (r.progress ??= { at: 0 })
    st.pending = { p: Math.max(0, Math.min(100, pct)), m: message?.slice(0, 500) }
    const flush = async () => {
      st.timer = undefined
      const v = st.pending
      if (!v || r.lost || r.released || r.zombie) return
      st.pending = undefined
      st.at = Date.now()
      await this.broker.progress(r.job.id, r.token, v.p, v.m ?? null)
    }
    const wait = 250 - (Date.now() - st.at)
    if (wait <= 0) return flush()
    st.timer ??= setTimeout(() => { flush().catch((e) => this.log('error', 'job.progress', { jobId: r.job.id, error: errText(e) })) }, wait)
  }

  // per-worker rate limits: the tasks at their limit right now (never claimed while there), and taking a slot
  private hits(task: Task): { hits: number[]; limit: number; windowMs: number } {
    const { limit, windowMs } = parseRate(task.opts.rateLimit!)
    const now = Date.now()
    const hits = (this.rates.get(task.id) ?? []).filter((t) => t > now - windowMs)
    this.rates.set(task.id, hits)
    return { hits, limit, windowMs }
  }
  private overLimit(): string[] {
    const out: string[] = []
    for (const id of this.rates.keys()) {
      const t = taskById(id)
      if (t?.opts.rateLimit && this.hits(t).hits.length >= this.hits(t).limit) out.push(id)
    }
    return out
  }
  private limitFrees(): number {
    let at = Infinity
    for (const id of this.rates.keys()) {
      const t = taskById(id)
      if (!t?.opts.rateLimit) continue
      const { hits, limit, windowMs } = this.hits(t)
      if (hits.length >= limit) at = Math.min(at, hits[0]! + windowMs)
    }
    return at
  }
  private take(task: Task): number {
    if (!task.opts.rateLimit) return 0
    const { hits, limit, windowMs } = this.hits(task)
    if (hits.length >= limit) return hits[0]! + windowMs - Date.now()
    hits.push(Date.now())
    return 0
  }

  // extend every lease; a lost one stops its handler; revoked jobs (cancel flag) are aborted
  private async heartbeat(): Promise<void> {
    const runs = [...this.running.values()].filter((r) => !r.released && !r.zombie && !r.lost)
    if (runs.length) {
      const { lost, cancelled } = await this.broker.heartbeat(runs.map((r) => ({ id: r.job.id, token: r.token })), this.leaseMs)
      for (const id of lost) {
        const r = this.running.get(id)
        if (r && !r.zombie) { r.lost = true; r.ac.abort(new Stop('lease lost')) }
      }
      for (const id of cancelled) {
        const r = this.running.get(id)
        if (r && !r.cancelled) { r.cancelled = true; r.ac.abort(new Stop('revoked')) }
      }
    }
    await this.broker.beat(this.name, this.running.size, this.processed)
  }

  // running rows whose lease passed (their worker died): re-queue (late acks) or kill (early acks / out of retries)
  async reap(now = Date.now()): Promise<number> {
    let n = 0
    for (const j of await this.broker.expired(now, 100)) {
      if (this.running.get(j.id)?.token === j.token) continue   // ours: the heartbeat is late, not dead
      const status: Final | 'queued' = j.cancel ? 'cancelled' : !j.acksLate || j.attempts > j.maxRetries ? 'dead' : 'queued'
      const error = j.cancel ? 'revoked' : !j.acksLate ? 'worker lost (acks early: not re-delivered)' : 'worker lost'
      const ttl = taskById(j.task)?.opts.resultTtlMs ?? config.tasks.resultTtlMs
      const ok = status === 'queued'
        ? await this.broker.requeue(j.id, j.token!, { runAt: now, error, expiredBefore: now })   // still expired: a late heartbeat wins
        : await this.broker.finish(j, j.token!, status, { error, purgeAt: now + ttl, expiredBefore: now })
      if (ok) { n++; this.log('warn', status === 'queued' ? 'job.redelivered' : `job.${status}`, { worker: this.name, jobId: j.id, task: j.task, attempt: j.attempts, from: j.worker, error }) }
    }
    return n
  }

  // result TTL + housekeeping; a chord a crashed member left half-fired (redis) gets its callback rebuilt here
  cleanup(now = Date.now()): Promise<void> {
    return this.broker.cleanup(now, { callback: (sig, results, parent) => this.link(parent, () => followUp(sig, results, parent, { groupId: null })) })
  }
}

// an Error class (any function with a prototype) matches by instanceof; an arrow function is a predicate. dontRetryOn wins.
export function retryable(task: Task, e: unknown): boolean {
  const is = (list: Task['opts']['retryOn']) => (list ?? []).some((m) =>
    typeof m === 'function' && (m as { prototype?: unknown }).prototype ? e instanceof (m as abstract new (...a: never[]) => unknown) : (m as (e: unknown) => boolean)(e) === true)
  if (is(task.opts.dontRetryOn)) return false
  return task.opts.retryOn ? is(task.opts.retryOn) : true
}

// min(max, base·2^(n-1)); jitter draws from [d/2, d] (never a thundering herd at ~0 ms)
export function backoff(b: Task['opts']['retryBackoff'], attempt: number, rnd: () => number = Math.random): number {
  if (b === false) return 0
  if (typeof b === 'number') return b
  const { baseMs = 1000, maxMs = 600_000, jitter = true } = b ?? {}
  const d = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return jitter ? Math.round(d / 2 + rnd() * (d / 2)) : d
}

// tvine.audit (core/audit.ts): a finished job is one row, via 'job', as the user who enqueued it. Never fails the job.
async function auditJob(job: JobRow, ms: number, code?: string): Promise<void> {
  if (!auditSinkSet()) return
  const row: AuditRow = { userId: job.userId ?? null, via: 'job', agent: null, agentVerified: false, action: `task:${job.task}`, outcome: code ? 'error' : 'ok',
    code: code ?? null, params: redactSecrets(job.args ?? null), ip: '', sidHash: sidHash(job.sid ?? undefined), ms: Math.round(ms), requestId: job.id, cmdId: null }
  await writeAudit(row).catch(() => undefined)
}
