// defineTask, discovery, enqueue (after commit, or durable outbox), canvas (chain / group / chord), results, revoke.
// docs/design/contrib/tasks.md §Defining tasks, §Enqueueing, §Results. Job storage is the broker's (broker.ts).
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APP_RE, appModule, importApp } from '../../core/actions.js'
import { installedApps } from '../../core/apps.js'
import { currentAction } from '../../core/dispatch.js'
import { DomainError } from '../../core/errors.js'
import { onCommit } from '../../data/engine.js'
import { DEFAULTS } from '../../settings.js'
import { broker, bus, configureBroker, notify, type ChordSpec, type NewJob, type SigJSON } from './broker.js'
import { nextFire, parseCron } from './cron.js'
import { Outbox, type JobRow, type JobStatus } from './models.js'

export { bus, type SigJSON, type NewJob }

// ---- types -----------------------------------------------------------------------------------
export interface TaskCtx {
  jobId: string
  task: string
  attempt: number                    // 1-based
  queue: string
  signal: AbortSignal                // aborts on soft timeout, revoke, lease loss, shutdown
  parent?: { jobId: string; result: unknown }   // chains: the previous link
  progress(pct: number, message?: string): Promise<void>
  retry(o?: { inMs?: number }): Retry  // `throw ctx.retry({ inMs: 5000 })`
  log(msg: string, data?: Record<string, unknown>): void
}
export type Backoff = false | number | { baseMs?: number; maxMs?: number; jitter?: boolean }
export type ErrMatch = (abstract new (...a: never[]) => unknown) | ((e: unknown) => boolean)
export type Misfire = 'once' | 'skip' | 'all'
export type ScheduleOpt = ({ cron: string } | { every: number }) & { args?: unknown; misfire?: Misfire; graceMs?: number }
export interface TaskOpts<S extends z.ZodTypeAny = z.ZodTypeAny> {
  args?: S
  queue?: string
  priority?: number
  maxRetries?: number
  retryBackoff?: Backoff
  retryOn?: ErrMatch[]
  dontRetryOn?: ErrMatch[]
  timeoutMs?: number | { soft?: number; hard?: number }
  rateLimit?: string | { limit: number; windowMs: number }
  unique?: { windowMs: number; key?: (args: z.infer<S>) => string }
  expires?: number
  acks?: 'late' | 'early'
  durable?: boolean                  // enqueued inside a transaction: an outbox row in it (never lost), relayed after commit
  schedule?: ScheduleOpt
  resultTtlMs?: number
  logArgs?: boolean
}
export interface ApplyOpts {
  countdown?: number                 // ms from now
  eta?: Date | number
  priority?: number
  queue?: string
  expires?: number | Date            // ms after enqueue, or a moment
  owner?: null                       // null: a system job (no session / user, no progress events)
}
export interface Pending { pending: true; jobId: string }
export interface GroupPending { pending: true; groupId: string; jobIds: string[] }

export class Retry extends Error {
  constructor(readonly inMs?: number) { super('retry requested'); this.name = 'Retry' }
}

// ---- config (settings.tasks, set by the app's ready() and by tvine worker) ---------------------
export const config: { tasks: typeof DEFAULTS.tasks } = { tasks: { ...DEFAULTS.tasks } }
// a partial settings.tasks is completed from the defaults; a changed store is reopened on its next use
export function configureTasks(tasks: Partial<typeof DEFAULTS.tasks>): void {
  config.tasks = { ...DEFAULTS.tasks, ...tasks }
  configureBroker(config.tasks)
}

// ---- defineTask + registry ---------------------------------------------------------------------
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const QUEUE_RE = /^[a-z0-9_-]{1,64}$/i
const REG = Symbol.for('tvine.tasks.registry')
const registry: Map<string, Task> = ((globalThis as { [REG]?: Map<string, Task> })[REG] ??= new Map())
export const tasks = (): Task[] => [...registry.values()]
export const taskById = (id: string): Task | undefined => registry.get(id)

export interface Task<S extends z.ZodTypeAny = z.ZodTypeAny, R = unknown> {
  readonly kind: 'tvine.task'
  readonly name: string
  readonly id: string                 // `<app>.<name>`, set by discovery
  readonly opts: TaskOpts<S>
  readonly schema: z.ZodTypeAny
  run(args: z.infer<S>, ctx: TaskCtx): Promise<R>
  delay(args: z.input<S>): Promise<Pending>
  apply(o: ApplyOpts & { args: z.input<S> }): Promise<Pending>
  s(args?: z.input<S>, opts?: SigJSON['opts']): Signature
  si(args: z.input<S>, opts?: SigJSON['opts']): Signature
}

const checkPriority = (p: number | undefined, where: string) => {
  if (p !== undefined && !(Number.isInteger(p) && Math.abs(p) <= 100)) throw new Error(`${where}: priority is an integer -100..100`)
}

export function defineTask<S extends z.ZodTypeAny = z.ZodUnknown, R = unknown>(
  name: string, fn: (args: z.infer<S>, ctx: TaskCtx) => R | Promise<R>, opts: TaskOpts<S> = {},
): Task<S, Awaited<R>> {
  const where = `defineTask("${name}")`
  if (!NAME_RE.test(name)) throw new Error(`${where}: the name must match ${NAME_RE}`)
  if (opts.queue !== undefined && !QUEUE_RE.test(opts.queue)) throw new Error(`${where}: queue must match ${QUEUE_RE}`)
  checkPriority(opts.priority, where)
  if (opts.maxRetries !== undefined && !(Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0)) throw new Error(`${where}: maxRetries is an integer >= 0`)
  if (opts.rateLimit !== undefined) parseRate(opts.rateLimit)
  const tm = opts.timeoutMs
  if (typeof tm === 'object' && tm.soft !== undefined && tm.hard !== undefined && !(tm.soft < tm.hard)) throw new Error(`${where}: timeoutMs.soft must be below timeoutMs.hard`)
  if (opts.unique && !(opts.unique.windowMs > 0)) throw new Error(`${where}: unique.windowMs must be > 0`)
  let own: string | undefined
  const any = () => t as unknown as Task
  const t: Task<S, Awaited<R>> = {
    kind: 'tvine.task', name, opts,
    get id() {
      if (!own) throw new Error(`task "${name}" was not discovered: export it from apps/<app>/tasks.ts and install tvine.tasks (settings.installedApps)`)
      return own
    },
    schema: opts.args ?? z.unknown(),
    run: (async (args: z.infer<S>, ctx: TaskCtx) => fn(args, ctx)) as unknown as Task<S, Awaited<R>>['run'],
    delay: (args) => t.apply({ args }),
    apply: async ({ args, ...o }) => {
      const r = buildRow(any(), args, o, ownerNow(o))
      await send({ jobs: [r], ...(opts.unique && { unique: { key: uniqueKey(any(), r.args), windowMs: opts.unique.windowMs } }) }, !!opts.durable)
      return { pending: true, jobId: r.id }
    },
    s: (args, so) => new Signature(any(), args, false, so),
    si: (args, so) => new Signature(any(), args, true, so),
  }
  Object.defineProperty(t, '_setId', { value: (id: string) => { own = id } })
  return t
}
export const isTask = (v: unknown): v is Task => !!v && typeof v === 'object' && (v as Task).kind === 'tvine.task'

// apps/<app>/tasks.ts of every installed app (project apps, then contrib) → `<app>.<name>`. Idempotent for the
// same task object; a second object under one id, or one object under two ids, is a boot error. Schedules are
// checked here too (a cron that never fires, args its task refuses).
export async function discoverTasks(appsDir: string, installed?: readonly string[]): Promise<Task[]> {
  const found: Task[] = []
  for (const { label: app, dir } of installedApps(appsDir, installed)) {
    const file = appModule(dir, 'tasks')
    if (!file) continue
    if (!APP_RE.test(app)) throw new Error(`${file}: folder name "${app}" must match ${APP_RE}`)
    for (const [exp, v] of Object.entries(await importApp(file))) {
      if (!isTask(v)) continue
      const id = `${app}.${v.name}`
      const had = registry.get(id)
      if (had && had !== v) throw new Error(`${file} export ${exp}: duplicate task id ${id}`)
      let cur: string | undefined
      try { cur = v.id } catch { /* not discovered yet */ }
      if (cur !== undefined && cur !== id) throw new Error(`${file} export ${exp}: task already registered as ${cur}`)
      ;(v as unknown as { _setId(id: string): void })._setId(id)
      try { checkSchedule(v) } catch (e) { throw new Error(`${file} export ${exp}: ${(e as Error).message}`) }
      registry.set(id, v)
      found.push(v)
    }
  }
  return found
}

export function checkSchedule(t: Task): void {
  const s = t.opts.schedule
  if (!s) return
  if ('cron' in s) nextFire(parseCron(s.cron), Date.now())   // throws for a cron with no fire time
  else if (!(Number.isInteger(s.every) && s.every >= 1000)) throw new Error(`task ${t.id}: schedule.every must be an integer >= 1000 ms`)
  if (!t.schema.safeParse(s.args).success) throw new Error(`task ${t.id}: schedule.args are refused by its args schema`)
}

// ---- signatures + canvas -----------------------------------------------------------------------
export class Signature {
  constructor(readonly task: Task, readonly args: unknown, readonly immutable: boolean, readonly opts: SigJSON['opts'] = {}) {}
  toJSON(): SigJSON {
    return { task: this.task.id, ...(this.args !== undefined && { args: this.args }), ...(this.immutable && { immutable: true }), ...(Object.keys(this.opts ?? {}).length && { opts: this.opts }) }
  }
  delay(): Promise<Pending> { return chain(this).apply() }
}

export function chain(...sigs: Signature[]) {
  if (!sigs.length) throw new Error('chain() needs at least one signature')
  return {
    async apply(o: ApplyOpts = {}): Promise<Pending> {
      const [head, ...rest] = sigs
      const r = buildRow(head!.task, head!.args, { ...head!.opts, ...o }, ownerNow(o), { chain: rest.length ? rest.map((s) => s.toJSON()) : null })
      await send({ jobs: [r] }, sigs.some((s) => s.task.opts.durable))
      return { pending: true, jobId: r.id }
    },
    delay(): Promise<Pending> { return this.apply() },
  }
}

export function group(sigs: Signature[]) {
  return { sigs, apply: (o: ApplyOpts = {}) => applyGroup(sigs, undefined, o), delay: () => applyGroup(sigs, undefined, {}) }
}

// cb runs once with the members' results (in order) after ALL members succeeded
export function chord(g: ReturnType<typeof group> | Signature[], cb: Signature) {
  const sigs = Array.isArray(g) ? g : g.sigs
  return { apply: (o: ApplyOpts = {}) => applyGroup(sigs, cb, o), delay: () => applyGroup(sigs, cb, {}) }
}

async function applyGroup(sigs: Signature[], cb: Signature | undefined, o: ApplyOpts): Promise<GroupPending> {
  const owner = ownerNow(o), groupId = randomUUID()
  const durable = [...sigs, ...(cb ? [cb] : [])].some((s) => s.task.opts.durable)
  if (!sigs.length && cb) {   // an empty chord: the callback runs at once on []
    await send({ jobs: [buildRow(cb.task, cb.immutable || cb.args !== undefined ? cb.args : [], cb.opts ?? {}, owner)] }, durable)
    return { pending: true, groupId, jobIds: [] }
  }
  const rows = sigs.map((s, i) => buildRow(s.task, s.args, { ...s.opts, ...o }, owner, { groupId, groupIndex: i }))
  await send({ jobs: rows, ...(cb && { chord: { id: groupId, remaining: rows.length, callback: cb.toJSON() } }) }, durable)
  return { pending: true, groupId, jobIds: rows.map((r) => r.id) }
}

// ---- rows ----------------------------------------------------------------------------------------
interface Owner { sid: string | null; userId: string | null }

function ownerNow(o: ApplyOpts): Owner {
  if (o.owner === null) return { sid: null, userId: null }
  const a = currentAction()
  if (!a) return { sid: null, userId: null }
  const u = a.request.user
  return { sid: a.sid.startsWith('ephemeral:') ? null : a.sid, userId: u.isAuthenticated && u.id !== undefined ? String(u.id) : null }
}

function parseArgs(t: Task, args: unknown): unknown {
  const r = t.schema.safeParse(args)
  if (!r.success) {
    const i = r.error.issues[0]!
    throw new DomainError('invalid_param', `task ${t.id} args${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`, i.path[0] === undefined ? undefined : String(i.path[0]))
  }
  return r.data ?? null
}

// a job row for `t` (args validated now); also what beat fires and what a chain link / chord callback becomes
export function buildRow(t: Task, args: unknown, o: ApplyOpts & SigJSON['opts'], owner: Owner, extra: Partial<JobRow> = {}): NewJob {
  const now = Date.now()
  const queue = o.queue ?? t.opts.queue ?? 'default'
  if (!QUEUE_RE.test(queue)) throw new Error(`queue "${queue}" must match ${QUEUE_RE}`)
  checkPriority(o.priority, `task ${t.id}`)
  const runAt = o.eta !== undefined ? +new Date(o.eta) : now + Math.max(0, o.countdown ?? 0)
  if (!Number.isFinite(runAt)) throw new Error('apply(): eta is not a valid date')
  const exp = o.expires ?? t.opts.expires
  return {
    id: randomUUID(), task: t.id, queue, priority: o.priority ?? t.opts.priority ?? 0, status: 'queued',
    args: parseArgs(t, args), maxRetries: t.opts.maxRetries ?? 3, acksLate: (t.opts.acks ?? 'late') === 'late',
    runAt, expiresAt: exp === undefined ? null : exp instanceof Date ? exp.getTime() : now + exp,
    createdAt: now, updatedAt: now, sid: owner.sid, userId: owner.userId,
    groupId: null, groupIndex: null, chain: null, parentId: null, dupOf: null, uniqueKey: null,
    ...extra,
  }
}

// a chain link / chord callback, built by the worker for the broker's success transaction
export function followUp(sig: SigJSON, prev: unknown, parent: JobRow, extra: Partial<JobRow> = {}): NewJob {
  const t = registry.get(sig.task)
  if (!t) throw new Error(`unregistered task ${sig.task}`)
  const args = sig.immutable || sig.args !== undefined ? sig.args : prev
  return buildRow(t, args, sig.opts ?? {}, { sid: parent.sid ?? null, userId: parent.userId ?? null }, { parentId: parent.id, ...extra })
}

// ---- enqueue: after commit (default) or through the outbox (durable) -----------------------------
export interface Payload { jobs: NewJob[]; chord?: ChordSpec; unique?: { key: string; windowMs: number } }

export function push(p: Payload): Promise<void> {
  return p.unique ? broker().enqueueUnique(p.jobs[0]!, p.unique.key, p.unique.windowMs, config.tasks.resultTtlMs) : broker().enqueue(p.jobs, p.chord)
}

// Outside a transaction: pushed now. Inside one (atomic() / an atomic request): pushed right AFTER COMMIT (Celery
// semantics — a rollback never enqueues; a crash between commit and push loses the job), or, for a durable task, an
// outbox row is written IN the transaction and relayed after commit (never lost).
async function send(p: Payload, durable: boolean): Promise<void> {
  if (!inTransaction()) return push(p)
  if (durable) {
    await Outbox.create({ id: randomUUID(), payload: p, createdAt: Date.now() })
    onCommit(() => notify('outbox'))
  } else onCommit(() => push(p))
}
const inTransaction = () => onCommit(() => undefined) === undefined

// ---- unique ---------------------------------------------------------------------------------------
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
export function uniqueKey(t: Task, args: unknown): string {
  const k = t.opts.unique?.key ? t.opts.unique.key(args as never) : canonical(args)
  return `unique:${createHash('sha256').update(`${t.id}\0${k}`).digest('hex')}`
}

// ---- results ------------------------------------------------------------------------------------
export class JobFailed extends Error {
  constructor(readonly jobId: string, readonly status: JobStatus, readonly reason?: string) {
    super(`job ${jobId} ${status}${reason ? `: ${reason}` : ''}`); this.name = 'JobFailed'
  }
}

// the row a jobId stands for (a deduped id follows its original)
export async function resolveJob(jobId: string): Promise<JobRow | undefined> {
  let j = await broker().get(jobId)
  for (let i = 0; j?.status === 'deduped' && j.dupOf && i < 3; i++) j = (await broker().get(j.dupOf)) ?? j
  return j
}

export function jobResult(jobId: string) {
  return {
    jobId,
    status: async () => (await resolveJob(jobId))?.status,
    row: () => resolveJob(jobId),
    async get({ timeoutMs = 30_000, pollMs = 200 }: { timeoutMs?: number; pollMs?: number } = {}): Promise<unknown> {
      const end = Date.now() + timeoutMs
      for (;;) {
        const j = await resolveJob(jobId)
        if (!j) throw new JobFailed(jobId, 'dead', 'not found')
        if (j.status === 'success') return j.result
        if (j.status !== 'queued' && j.status !== 'running' && j.status !== 'deduped') throw new JobFailed(j.id, j.status, j.error ?? undefined)
        if (Date.now() >= end) throw new Error(`job ${jobId}: no result within ${timeoutMs} ms (status ${j.status})`)
        await new Promise((r) => setTimeout(r, pollMs))
      }
    },
  }
}

// queued → cancelled now; running → its signal aborts at the worker's next heartbeat. The resulting status.
export async function revoke(jobId: string): Promise<JobStatus | undefined> {
  const j = await resolveJob(jobId)
  return j && broker().cancel(j.id, config.tasks.resultTtlMs)
}

export function parseRate(r: NonNullable<TaskOpts['rateLimit']>): { limit: number; windowMs: number } {
  if (typeof r === 'object') {
    if (!(r.limit > 0 && r.windowMs > 0)) throw new Error('rateLimit: limit and windowMs must be > 0')
    return r
  }
  const m = /^(\d+)\/(s|m|h)$/.exec(r)
  if (!m || Number(m[1]) <= 0) throw new Error(`rateLimit "${r}": use "<n>/s", "<n>/m" or "<n>/h"`)
  return { limit: Number(m[1]), windowMs: { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'] }
}
