// Web-server / worker side of tvine.tasks: the progress relay (broker.watch → `update` events with source 'job' on
// the owner's session group), the outbox relay (durable enqueues → broker), and the /tvine/health section.
// docs/design/contrib/tasks.md §Results, §Enqueueing, §Ops.
import { createHash } from 'node:crypto'
import type { ServerCtx } from '../../core/dispatch.js'
import type { Event, Settings } from '../../core/types.js'
import { getRedis, redisKey } from '../../redis/index.js'
import { broker, bus, type Moved, type QueueStats } from './broker.js'
import { FINAL, Outbox } from './models.js'
import { push, tasks, type Payload } from './task.js'

// Each web server watches the broker feed; with a shared channel layer (channels.backend 'redis') every server sees
// every job event, so ONE of them claims it (SET NX on the channels alias) and publishes it once; with in-process
// channels each server serves its own subscribers.
export type Claim = (key: string) => Promise<boolean>
export function relayClaim(settings: Pick<Settings, 'channels'>): Claim | undefined {
  if (settings.channels.backend !== 'redis') return undefined
  const alias = settings.channels.redis
  return async (key) => (await (await getRedis(alias)).sendCommand(['SET', redisKey(alias, 'tasks', 'relay', key), '1', 'NX', 'PX', '60000'])) === 'OK'
}

export class ProgressRelay {
  private off?: () => void
  constructor(private server: Pick<ServerCtx, 'sessions' | 'channels'>, private everyMs: number, private claim?: Claim) {}

  start(): void { this.off = broker().watch((j) => this.send(j), { minMs: this.everyMs }) }
  stop(): void { this.off?.() }

  private send(j: Moved): void {
    void this.post(j).catch(() => undefined)   // a session store hiccup drops one progress event, never the relay
  }
  private async post(j: Moved): Promise<void> {
    const s = j.sid ? await this.server.sessions.peek({ sid: j.sid }) : undefined
    if (!s) return   // another web process's session, or gone
    // the first server to claim this exact change publishes it (and bumps the rev once); the attempt keeps a retried
    // job's identical progress apart from the previous attempt's
    if (this.claim && !(await this.claim(createHash('sha1').update(JSON.stringify([j.id, j.attempts, j.status, j.progress, j.message])).digest('hex')))) return
    // a final status bumps the rev (the page may show what the job changed); progress keeps it. Rev only, under the
    // session's lock: never a save of this (maybe stale) copy, which would overwrite a command's data
    let rev = s.rev
    if (FINAL.includes(j.status)) rev = (await this.server.sessions.lock(s.sid, () => this.server.sessions.bumpRev(s.sid))) ?? rev
    const e: Event = {
      kind: 'update', sid: s.sid, rev, source: 'job',
      job: { id: j.id, task: j.task, status: j.status, ...(j.progress != null && { progress: j.progress }), ...(j.message != null && { message: j.message }) },
    }
    this.server.channels.group(`sid:${s.sid}`).send(e)
  }
}

// Durable enqueues: drains tasks_outbox into the broker (broker.enqueue is idempotent by job id, so two relays — web
// and worker — may overlap safely). Woken at once by an in-process commit; otherwise it backs off 500 ms → 30 s.
// Never touches the main database when no discovered task is durable.
export const outboxNeeded = (list = tasks()): boolean => list.some((t) => t.opts.durable)

export class OutboxRelay {
  private timer?: NodeJS.Timeout
  private busy?: Promise<number>
  private delay = 500
  private stopped = false
  static MIN = 500
  static MAX = 30_000
  private wake = () => { this.delay = OutboxRelay.MIN; void this.drain() }

  constructor(private log: ServerCtx['log']) {}

  start(): boolean {
    if (!outboxNeeded()) return false
    bus.on('outbox', this.wake)
    void this.drain()
    return true
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    bus.off('outbox', this.wake)
    await this.busy
  }

  drain(): Promise<number> {
    if (this.stopped) return Promise.resolve(0)
    return (this.busy ??= (async () => {
      let n = 0
      try {
        for (;;) {
          const rows = (await Outbox.objects.order('createdAt').page({ size: 100 })).items
          for (const r of rows) {
            await push(r.payload as Payload)
            await Outbox.objects.filter({ id: r.id }).delete()
            n++
          }
          if (rows.length < 100 || this.stopped) break
        }
      } catch (e) {
        if (!this.stopped) this.log('error', 'tasks outbox relay failed', { error: e instanceof Error ? e.message : String(e) })
      }
      this.delay = n ? OutboxRelay.MIN : Math.min(OutboxRelay.MAX, this.delay * 2)
      this.busy = undefined
      if (!this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.drain(), this.delay); this.timer.unref() }
      return n
    })())
  }
}

// /tvine/health `tasks` (a PUBLIC endpoint): counts only — no worker names, hosts or queues. Cached ≤ refreshMs,
// refreshed in the background; health never waits on the store.
export function healthSection(leaseMs: number, log: ServerCtx['log'], refreshMs = 5_000): () => unknown {
  let last: (QueueStats & { at: number }) | undefined
  let failed = false
  let pending = false
  const refresh = () => {
    if (pending) return
    pending = true
    broker().stats(leaseMs).then((s) => { last = { ...s, at: Date.now() }; failed = false }, (e: unknown) => {
      failed = true
      log('warn', 'tasks health stats failed', { error: e instanceof Error ? e.message : String(e) })
    }).finally(() => { pending = false })
  }
  return () => {
    if (!last || Date.now() - last.at > refreshMs) refresh()
    if (!last) return { pending: true, ...(failed && { error: true }) }
    return {
      queued: last.queued, scheduled: last.scheduled, running: last.running, dead: last.dead,
      workers: last.workers.length, staleWorkers: last.workers.filter((w) => w.stale).length,
      ageMs: Date.now() - last.at, ...(failed && { error: true }),
    }
  }
}

// Who runs the jobs: live (non-stale) job workers, jobs ready to run, the scheduler leader. Shared by `tvine check`,
// the admin's System > Health tile and the `tvine start` warning. alarm: jobs wait and nobody will ever take them.
export interface JobWorkers { running: number; waiting: number; scheduler?: string; alarm: boolean }
export function jobWorkers(s: QueueStats): JobWorkers {
  const running = s.workers.filter((w) => !w.stale).length
  return { running, waiting: s.queued, ...(s.beat && { scheduler: s.beat }), alarm: running === 0 && s.queued > 0 }
}
export const jobWorkersLine = (j: JobWorkers): string => `tasks: ${j.running} job worker(s) running · ${j.waiting} job(s) waiting`

// `tvine start` with a broker outside this process (file / db / redis) runs no jobs and no schedules itself: without a
// `tvine worker` queued jobs wait forever, silently. ~30 s after start (a worker started alongside has registered by
// then), one line when the broker knows no live job worker. Not in dev, not with broker 'memory' (jobs run here).
export const NO_WORKER = 'tvine start: background jobs are queued but no job worker is running. Start one: tvine worker --beat   (see docs/deploy.md#background-jobs)'
export function noWorkerWarning(settings: Pick<Settings, 'installedApps' | 'tasks'>, say: (s: string) => void, o: { dev?: boolean; delayMs?: number } = {}): () => void {
  if (o.dev || !settings.installedApps.includes('tvine.tasks') || (settings.tasks.broker ?? 'file') === 'memory') return () => {}
  const t = setTimeout(() => {
    broker().stats(settings.tasks.leaseMs).then((s) => { if (jobWorkers(s).running === 0) say(NO_WORKER) }, () => undefined)
  }, o.delayMs ?? 30_000)
  t.unref()
  return () => clearTimeout(t)
}
