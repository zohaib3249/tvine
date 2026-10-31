// The worker (docs/design/contrib/tasks.md §Worker): claims with leases, runs attempts with an AbortSignal and
// timeouts, heartbeats, reaps expired leases, retries with backoff, dead-letters, cleans results, and shuts
// down gracefully (finish or release within the grace period).
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { atomic, onCommit } from '../../data/engine.js'
import { dec } from '../../index.js'
import { DbBroker, type Broker } from './broker.js'
import { Group, Job, Lock, WorkerRow, type JobRow, type JobStatus } from './models.js'
import { afterFinal, bus, config, followUp, parseRate, Retry, taskById, type SigJSON, type Task, type TaskCtx } from './task.js'

export type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
export interface WorkerOpts {
  name?: string
  queues?: string[] | '*'            // default every queue
  concurrency?: number               // default 10
  leaseMs?: number; pollMs?: number; graceMs?: number   // default settings.tasks
  broker?: Broker
  log?: Log
}

export class SoftTimeLimit extends Error { constructor() { super('soft time limit exceeded'); this.name = 'SoftTimeLimit' } }
export class HardTimeLimit extends Error { constructor() { super('hard time limit exceeded'); this.name = 'HardTimeLimit' } }
class Stop extends Error { constructor(why: string) { super(why); this.name = 'Stop' } }

interface Running {
  job: JobRow; token: string; ac: AbortController; done: Promise<void>
  lost?: boolean; cancelled?: boolean; released?: boolean
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
  private leaseMs: number; private pollMs: number; private graceMs: number
  private running = new Map<string, Running>()
  private timers: NodeJS.Timeout[] = []
  private beatTimer?: NodeJS.Timeout
  private stopping = false
  private ticking = false
  private again = false
  private processed = 0
  private rates = new Map<string, number[]>()
  private startedAt = 0
  private onEnqueued = () => { void this.tick() }

  constructor(o: WorkerOpts = {}) {
    this.name = o.name ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
    this.queues = o.queues ?? '*'
    this.concurrency = o.concurrency ?? 10
    if (!Number.isInteger(this.concurrency) || this.concurrency < 0) throw new Error('worker concurrency must be an integer >= 0')
    this.broker = o.broker ?? new DbBroker()
    this.log = o.log ?? (() => {})
    this.leaseMs = o.leaseMs ?? config.tasks.leaseMs
    this.pollMs = o.pollMs ?? config.tasks.pollMs
    this.graceMs = o.graceMs ?? config.tasks.graceMs
  }

  get busy(): number { return this.running.size }

  async start(): Promise<void> {
    this.startedAt = Date.now()
    await WorkerRow.objects.filter({ name: this.name }).delete()
    await WorkerRow.create({ name: this.name, queues: this.queues === '*' ? '*' : this.queues.join(','), concurrency: this.concurrency, pid: process.pid, host: hostname(), startedAt: this.startedAt, beatAt: this.startedAt })
    this.log('info', 'worker.start', { worker: this.name, queues: this.queues, concurrency: this.concurrency })
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => { fn().catch((e) => this.log('error', 'worker.loop', { worker: this.name, error: errText(e) })) }, ms)
      this.timers.push(t)
    }
    if (this.concurrency > 0) {
      every(this.pollMs, () => this.tick())
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
    for (const t of this.timers.splice(0)) clearInterval(t)
    const deadline = Date.now() + graceMs
    while (this.running.size && Date.now() < deadline) {
      await Promise.race([Promise.all([...this.running.values()].map((r) => r.done)), new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))))])
    }
    for (const r of [...this.running.values()]) {
      r.released = true
      r.ac.abort(new Stop('worker shutting down'))
      const ok = await this.broker.settle(r.job.id, r.token, { status: 'queued', attempts: dec(1) as never, runAt: Date.now(), worker: null, token: null, leaseUntil: null })
      this.log('warn', 'job.released', { worker: this.name, jobId: r.job.id, task: r.job.task, released: ok })
      this.running.delete(r.job.id)
    }
    clearInterval(this.beatTimer)
    await WorkerRow.objects.filter({ name: this.name }).delete().catch(() => undefined)
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
        const { token, jobs } = await this.broker.claim({ worker: this.name, queues: this.queues, n: Math.min(free, 100), leaseMs: this.leaseMs })
        if (this.stopping) {   // stop() began during the claim: hand these straight back
          for (const j of jobs) await this.broker.settle(j.id, token, { status: 'queued', attempts: dec(1) as never, worker: null, token: null, leaseUntil: null })
          return
        }
        for (const j of jobs) this.launch(j, token)
        if (jobs.length === free) this.again = true
      } while (this.again && !this.stopping)
    } finally { this.ticking = false }
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
    const wait = this.overRate(task)
    if (wait > 0) {   // per-worker rate limit: back to the queue, no attempt spent
      await this.broker.settle(job.id, r.token, { status: 'queued', attempts: dec(1) as never, runAt: Date.now() + wait, worker: null, token: null, leaseUntil: null })
      return
    }
    const parsed = task.schema.safeParse(job.args)
    if (!parsed.success) return this.final(r, 'dead', { error: `invalid args: ${parsed.error.issues[0]?.message ?? 'rejected'}` })

    this.log('info', 'job.start', { ...base, ...(task.opts.logArgs && { args: job.args }) })
    const parent = job.parentId ? await Job.get(job.parentId).catch(() => undefined) : undefined
    const ctx: TaskCtx = {
      jobId: job.id, task: job.task, attempt: job.attempts, queue: job.queue, signal: r.ac.signal,
      ...(parent && { parent: { jobId: parent.id, result: parent.result } }),
      progress: (pct, message) => this.progress(r, pct, message),
      retry: (o = {}) => new Retry(o.inMs),
      log: (msg, data) => this.log('info', 'job.log', { ...base, msg, ...data }),
    }
    const tm = typeof task.opts.timeoutMs === 'number' ? { hard: task.opts.timeoutMs } : { hard: 300_000, ...task.opts.timeoutMs }
    const timers: NodeJS.Timeout[] = []
    try {
      if (tm.soft !== undefined) timers.push(setTimeout(() => r.ac.abort(new SoftTimeLimit()), tm.soft))
      const hard = new Promise<never>((_, rej) => {
        timers.push(setTimeout(() => { const e = new HardTimeLimit(); r.ac.abort(e); rej(e) }, tm.hard ?? 300_000))
      })
      const stop = new Promise<never>((_, rej) => r.ac.signal.addEventListener('abort', () => {
        const why = r.ac.signal.reason
        if (why instanceof Stop) rej(why)   // lease lost / revoked / shutdown: stop waiting at once (the handler may still run)
      }, { once: true }))
      const result = await Promise.race([task.run(parsed.data, ctx), hard, stop])
      if (r.lost || r.released) return
      if (r.cancelled) return this.final(r, 'cancelled', {})
      let stored: unknown
      try { stored = result === undefined ? null : JSON.parse(JSON.stringify(result)) }
      catch (e) { return this.final(r, 'dead', { error: `result is not JSON: ${errText(e)}` }) }
      await this.succeed(r, task, stored, Date.now() - t0)
    } catch (e) {
      if (r.released) return
      if (r.lost) { this.log('warn', 'job.lost', { ...base, ms: Date.now() - t0 }); return }
      if (r.cancelled) return this.final(r, 'cancelled', { error: 'revoked' })
      await this.fail(r, e, task)
    } finally { for (const t of timers) clearTimeout(t) }
  }

  private async succeed(r: Running, task: Task, result: unknown, ms: number): Promise<void> {
    const { job } = r, now = Date.now()
    const ttl = task.opts.resultTtlMs ?? config.tasks.resultTtlMs
    let ok = false
    await atomic(async () => {
      ok = await this.broker.settle(job.id, r.token, { status: 'success', result, error: null, progress: 100, finishedAt: now, purgeAt: now + ttl, leaseUntil: null })
      if (!ok) return
      const rest = (job.chain as SigJSON[] | null) ?? []
      const next = rest.length ? this.link(job, () => followUp(rest[0]!, result, job, { chain: rest.length > 1 ? rest.slice(1) : null })) : undefined
      if (next) await Job.create(next as never)
      if (job.groupId) await this.chordStep(job)
      await afterFinal(job, 'success')
      onCommit(() => { bus.emit('enqueued'); bus.emit('moved') })
    })
    if (ok) this.log('info', 'job.ok', { worker: this.name, jobId: job.id, task: job.task, attempt: job.attempts, ms })
    else this.log('warn', 'job.lost', { worker: this.name, jobId: job.id, task: job.task, ms })
  }

  // a chord member succeeded (inside its success transaction): count down; the one reaching 0 fires the callback once
  private async chordStep(job: JobRow): Promise<void> {
    const id = job.groupId!
    if (!(await Group.objects.filter({ id, status: 'pending' }).update({ remaining: dec(1) }))) return   // plain group, or a failed chord
    const g = await Group.get(id)
    if (!g || g.remaining > 0) return
    if (!(await Group.objects.filter({ id, status: 'pending' }).update({ status: 'fired', purgeAt: Date.now() + config.tasks.resultTtlMs }))) return
    const members = await Job.objects.filter({ groupId: id }).order('groupIndex').all()
    const cb = this.link(job, () => followUp(g.callback as SigJSON, members.map((m) => m.result), job, { groupId: null }))
    if (cb) await Job.create(cb as never)
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
    if (retry && job.attempts <= job.maxRetries) {
      const inMs = e instanceof Retry && e.inMs !== undefined ? e.inMs : fixedMs ?? backoff(task?.opts.retryBackoff, job.attempts)
      const ok = await this.broker.settle(job.id, r.token, { status: 'queued', runAt: Date.now() + inMs, error: errText(e), worker: null, token: null, leaseUntil: null })
      if (ok) { bus.emit('moved'); this.log('warn', 'job.retry', { ...base, inMs }) }
      return
    }
    this.log('error', 'job.dead', base)
    await this.final(r, 'dead', { error: errText(e) })
  }

  private async final(r: Running, status: JobStatus, patch: Partial<JobRow>): Promise<void> {
    const now = Date.now()
    const ttl = taskById(r.job.task)?.opts.resultTtlMs ?? config.tasks.resultTtlMs
    const ok = await atomic(async () => {
      if (!(await this.broker.settle(r.job.id, r.token, { status, finishedAt: now, purgeAt: now + ttl, leaseUntil: null, ...patch }))) return false
      await afterFinal(r.job, status)
      return true
    })
    if (ok) bus.emit('moved')
  }

  // ctx.progress: written at most every 250 ms per job; the last value always lands (trailing write)
  private async progress(r: Running, pct: number, message?: string): Promise<void> {
    if (typeof pct !== 'number' || Number.isNaN(pct)) throw new TypeError('progress(pct): pct must be a number 0-100')
    const p = Math.max(0, Math.min(100, pct))
    const st = (r.progress ??= { at: 0 })
    st.pending = { p, m: message?.slice(0, 500) }
    const flush = async () => {
      st.timer = undefined
      const v = st.pending
      if (!v || r.lost || r.released) return
      st.pending = undefined
      st.at = Date.now()
      await Job.objects.filter({ id: r.job.id, token: r.token, status: 'running' }).update({ progress: v.p, message: v.m ?? null, updatedAt: st.at })
      bus.emit('moved')
    }
    const wait = 250 - (Date.now() - st.at)
    if (wait <= 0) return flush()
    st.timer ??= setTimeout(() => { flush().catch((e) => this.log('error', 'job.progress', { jobId: r.job.id, error: errText(e) })) }, wait)
  }

  private overRate(task: Task): number {
    if (!task.opts.rateLimit) return 0
    const { limit, windowMs } = parseRate(task.opts.rateLimit)
    const now = Date.now()
    const hits = (this.rates.get(task.id) ?? []).filter((t) => t > now - windowMs)
    this.rates.set(task.id, hits)
    if (hits.length >= limit) return hits[0]! + windowMs - now
    hits.push(now)
    return 0
  }

  // extend every lease; a lost one stops its handler; revoked jobs (cancel flag) are aborted
  private async heartbeat(): Promise<void> {
    const runs = [...this.running.values()].filter((r) => !r.released)
    for (const r of runs) {
      if (!(await this.broker.heartbeat(r.job.id, r.token, this.leaseMs)) && this.running.has(r.job.id)) {
        r.lost = true
        r.ac.abort(new Stop('lease lost'))
      }
    }
    if (runs.length) {
      for (const j of await Job.objects.filter([{ field: 'id', op: 'in', value: runs.map((r) => r.job.id) }, { field: 'cancel', op: 'eq', value: true }]).all()) {
        const r = this.running.get(j.id)
        if (r && !r.cancelled) { r.cancelled = true; r.ac.abort(new Stop('revoked')) }
      }
    }
    await WorkerRow.objects.filter({ name: this.name }).update({ beatAt: Date.now(), running: this.running.size, processed: this.processed })
  }

  // running rows whose lease passed (their worker died): re-queue (late acks) or kill (early acks / out of retries)
  async reap(now = Date.now()): Promise<number> {
    let n = 0
    for (const j of await this.broker.expired(now, 100)) {
      if (this.running.get(j.id)?.token === j.token) continue   // ours: the heartbeat is late, not dead
      const status: JobStatus | 'queued' = j.cancel ? 'cancelled' : !j.acksLate || j.attempts > j.maxRetries ? 'dead' : 'queued'
      const error = j.cancel ? 'revoked' : !j.acksLate ? 'worker lost (acks early: not re-delivered)' : 'worker lost'
      const ttl = taskById(j.task)?.opts.resultTtlMs ?? config.tasks.resultTtlMs
      const ok = await atomic(async () => {
        if (status === 'queued') return this.broker.settle(j.id, j.token!, { status, runAt: now, error, worker: null, token: null, leaseUntil: null })
        if (!(await this.broker.settle(j.id, j.token!, { status, error, finishedAt: now, purgeAt: now + ttl, leaseUntil: null }))) return false
        await afterFinal(j, status)
        return true
      })
      if (ok) { n++; this.log('warn', status === 'queued' ? 'job.redelivered' : `job.${status}`, { worker: this.name, jobId: j.id, task: j.task, attempt: j.attempts, from: j.worker, error }) }
    }
    if (n) bus.emit('moved')
    return n
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.broker.cleanup(now)
    await Group.objects.filter([{ field: 'purgeAt', op: 'lte', value: now }]).delete()
    await Lock.objects.filter([{ field: 'expiresAt', op: 'lte', value: now - CLEAN_MS }]).delete()
    await WorkerRow.objects.filter([{ field: 'beatAt', op: 'lt', value: now - 86_400_000 }]).delete()
  }
}

// an Error class matches by instanceof, any other function is a predicate; dontRetryOn wins
export function retryable(task: Task, e: unknown): boolean {
  const is = (list: Task['opts']['retryOn']) => (list ?? []).some((m) =>
    m === Error || (m as { prototype?: unknown }).prototype instanceof Error ? e instanceof (m as typeof Error) : (m as (e: unknown) => boolean)(e) === true)
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
