// Web-server / worker side of tvine.tasks: the progress relay (broker.watch → `update` events with source 'job' on
// the owner's session group), the outbox relay (durable enqueues → broker), and the /tvine/health section.
// docs/design/contrib/tasks.md §Results, §Enqueueing, §Ops.
import type { ServerCtx } from '../../core/dispatch.js'
import type { Event } from '../../core/types.js'
import { broker, bus, type QueueStats } from './broker.js'
import { FINAL, Outbox, type JobRow } from './models.js'
import { push, tasks, type Payload } from './task.js'

export class ProgressRelay {
  private off?: () => void
  constructor(private server: Pick<ServerCtx, 'sessions' | 'channels'>, private everyMs: number) {}

  start(): void { this.off = broker().watch((j) => this.send(j), { minMs: this.everyMs }) }
  stop(): void { this.off?.() }

  private send(j: JobRow): void {
    void this.post(j).catch(() => undefined)   // a session store hiccup drops one progress event, never the relay
  }
  private async post(j: JobRow): Promise<void> {
    const s = j.sid ? await this.server.sessions.peek({ sid: j.sid }) : undefined
    if (!s) return   // another web process's session, or gone
    // a final status bumps the rev (the page may show what the job changed); progress keeps it
    if (FINAL.includes(j.status)) { s.rev++; await this.server.sessions.save(s) }
    const e: Event = {
      kind: 'update', sid: s.sid, rev: s.rev, source: 'job',
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
