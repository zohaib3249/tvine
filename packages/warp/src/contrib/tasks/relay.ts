// Web-server side of tvine.tasks: the progress relay (job rows → `update` events on the owner's session group)
// and the cached /tvine/health section. docs/design/contrib/tasks.md §Results, §Ops.
// ponytail: the relay polls tasks_job by updatedAt (and wakes at once for in-process writes); a Redis broker
// (#12) replaces the poll with pub/sub.
import type { ServerCtx } from '../../core/dispatch.js'
import type { Event } from '../../core/types.js'
import { DbBroker, type QueueStats } from './broker.js'
import { FINAL, Job } from './models.js'
import { bus } from './task.js'

const OVERLAP = 2_000   // re-read this far back: a transaction may commit an older updatedAt after a newer one
const PAGE = 100
const MAX_PAGES = 50

export class Relay {
  private cursor = Date.now() - OVERLAP
  private seen = new Map<string, number>()   // jobId → updatedAt already sent
  private timer?: NodeJS.Timeout
  private busy?: Promise<void>
  private again = false
  private stopped = false
  private wake = () => { void this.poll() }

  constructor(private server: Pick<ServerCtx, 'sessions' | 'channels' | 'log'>, private everyMs: number) {}

  start(): void {
    this.timer = setInterval(this.wake, this.everyMs)
    this.timer.unref()
    bus.on('moved', this.wake)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    bus.off('moved', this.wake)
    await this.busy
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.busy) { this.again = true; return this.busy }
    return (this.busy = (async () => {
      try {
        do {
          this.again = false
          const qs = Job.objects
            .filter([{ field: 'updatedAt', op: 'gte', value: this.cursor - OVERLAP }, { field: 'sid', op: 'ne', value: null }])
            .order('updatedAt')
          let top = this.cursor, page: string | undefined, n = 0
          do {   // keyset pages (updatedAt, id): a busy window is read through, never re-read in a loop
            const p = await qs.page({ size: PAGE, cursor: page })
            for (const j of p.items) { this.send(j); top = Math.max(top, j.updatedAt) }
            page = p.nextCursor
          } while (page && ++n < MAX_PAGES && !this.stopped)
          this.cursor = top
          for (const [id, at] of this.seen) if (at < this.cursor - 2 * OVERLAP) this.seen.delete(id)
        } while (this.again && !this.stopped)
      } catch (e) {
        if (!this.stopped) this.server.log('error', 'tasks relay failed', { error: e instanceof Error ? e.message : String(e) })
      } finally { this.busy = undefined }
    })())
  }

  private send(j: Awaited<ReturnType<typeof Job.get>> & object): void {
    if (this.seen.get(j.id) === j.updatedAt) return
    this.seen.set(j.id, j.updatedAt)
    const s = this.server.sessions.peek({ sid: j.sid! })
    if (!s) return   // another web process's session, or gone
    // a final status bumps the rev (the page may show what the job changed); progress keeps it
    if (FINAL.includes(j.status)) s.rev++
    const e: Event = {
      kind: 'update', sid: s.sid, rev: s.rev, source: 'agent',
      job: { id: j.id, task: j.task, status: j.status, ...(j.progress != null && { progress: j.progress }), ...(j.message != null && { message: j.message }) },
    }
    this.server.channels.group(`sid:${s.sid}`).send(e)
  }
}

// /tvine/health `tasks`: the last stats (≤ refreshMs old), refreshed in the background — never awaited by health
export function healthSection(leaseMs: number, log: ServerCtx['log'], refreshMs = 5_000): () => unknown {
  const broker = new DbBroker()
  let last: (QueueStats & { at: number }) | undefined
  let error: string | undefined
  let pending = false
  const refresh = () => {
    if (pending) return
    pending = true
    broker.stats(leaseMs).then((s) => { last = { ...s, at: Date.now() }; error = undefined }, (e: unknown) => {
      error = e instanceof Error ? e.message : String(e)
      log('warn', 'tasks health stats failed', { error })
    }).finally(() => { pending = false })
  }
  return () => {
    if (!last || Date.now() - last.at > refreshMs) refresh()
    if (!last) return { pending: true, ...(error && { error }) }
    const { at, ...s } = last
    return { ...s, ageMs: Date.now() - at, ...(error && { error }) }
  }
}
