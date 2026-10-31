// Beat: periodic tasks (docs/design/contrib/tasks.md §Beat). One leader through tasks_lock('beat'); each due
// schedule is enqueued in ONE transaction with a compare-and-set of its nextRunAt, so even two beats that
// both believe they lead never enqueue a fire time twice.
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { atomic } from '../../data/engine.js'
import { nextFire, parseCron, type Cron } from './cron.js'
import { Lock, Schedule } from './models.js'
import { tasks, type ScheduleOpt, type Task } from './task.js'
import type { Log } from './worker.js'

const MAX_CATCHUP = 100
const KEY = 'beat'

export interface BeatOpts { name?: string; tickMs?: number; lockMs?: number; log?: Log; now?: () => number }

export class Beat {
  readonly name: string
  private tickMs: number; private lockMs: number
  private log: Log
  private now: () => number
  private timer?: NodeJS.Timeout
  private leading = false
  private renewedAt = 0
  private running?: Promise<void>
  private crons = new Map<string, Cron>()

  constructor(o: BeatOpts = {}) {
    this.name = o.name ?? `beat:${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
    this.tickMs = o.tickMs ?? 1000
    this.lockMs = o.lockMs ?? 30_000
    this.log = o.log ?? (() => {})
    this.now = o.now ?? Date.now
  }

  get isLeader(): boolean { return this.leading }

  start(): void {
    for (const t of scheduled()) this.spec(t)   // a bad cron fails at start, not at its first fire
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    void this.tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.running
    if (this.leading) await Lock.objects.filter({ key: KEY, owner: this.name }).delete().catch(() => undefined)
    this.leading = false
  }

  tick(): Promise<void> {
    return (this.running ??= this.step()
      .catch((e) => this.log('error', 'beat.tick', { beat: this.name, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { this.running = undefined }))
  }

  private async step(): Promise<void> {
    if (!(await this.lead())) return
    for (const t of scheduled()) await this.due(t)
  }

  // take the lock when free or expired; renew it every lockMs/3; a failed renew = no longer the leader
  private async lead(): Promise<boolean> {
    const now = this.now()
    if (this.leading && now - this.renewedAt < this.lockMs / 3) return true
    if (this.leading) {
      this.leading = (await Lock.objects.filter({ key: KEY, owner: this.name }).update({ expiresAt: now + this.lockMs })) === 1
      if (!this.leading) this.log('warn', 'beat.lost', { beat: this.name })
    } else {
      try { await Lock.create({ key: KEY, owner: this.name, expiresAt: now + this.lockMs }); this.leading = true } catch {
        this.leading = (await Lock.objects.filter([{ field: 'key', op: 'eq', value: KEY }, { field: 'expiresAt', op: 'lte', value: now }]).update({ owner: this.name, expiresAt: now + this.lockMs })) === 1
      }
      if (this.leading) this.log('info', 'beat.leader', { beat: this.name })
    }
    if (this.leading) this.renewedAt = now
    return this.leading
  }

  private spec(t: Task): string {
    const s = t.opts.schedule!
    if ('cron' in s) { this.crons.set(t.id, parseCron(s.cron)); return `cron:${s.cron}` }
    if (!(Number.isInteger(s.every) && s.every >= 1000)) throw new Error(`task ${t.id}: schedule.every must be an integer >= 1000 ms`)
    return `every:${s.every}`
  }

  private next(t: Task, after: number): number {
    const s = t.opts.schedule!
    return 'cron' in s ? nextFire(this.crons.get(t.id) ?? parseCron(s.cron), after).getTime() : after + s.every
  }

  private async due(t: Task): Promise<void> {
    const now = this.now(), s = t.opts.schedule!, spec = this.spec(t)
    const row = await Schedule.objects.filter({ name: t.id }).first()
    if (!row || row.spec !== spec) {   // new, or its schedule changed in code: the next time from now
      if (!row) await Schedule.create({ name: t.id, spec, nextRunAt: this.next(t, now) }).catch(() => undefined)
      else await Schedule.objects.filter({ name: t.id, spec: row.spec }).update({ spec, nextRunAt: this.next(t, now) })
      return
    }
    if (row.nextRunAt > now) return
    const { runs, next } = this.fires(t, s, row.nextRunAt, now)
    const won = await atomic(async () => {
      if (!(await Schedule.objects.filter({ name: t.id, nextRunAt: row.nextRunAt }).update({ nextRunAt: next, lastRunAt: now }))) return false
      for (let i = 0; i < runs; i++) await t.apply({ args: s.args as never, owner: null })
      return true
    })
    if (won) this.log('info', 'beat.sent', { beat: this.name, task: t.id, runs, late: now - row.nextRunAt, next })
  }

  // how many jobs a due schedule sends now, and its next fire time (always in the future)
  fires(t: Task, s: ScheduleOpt, due: number, now: number): { runs: number; next: number } {
    let missed: number, next: number
    if ('every' in s) {   // arithmetic: a beat down for a year must not loop per interval
      missed = Math.floor((now - due) / s.every) + 1
      next = due + missed * s.every
    } else {
      missed = 0; next = due
      while (next <= now && missed < MAX_CATCHUP) { missed++; next = this.next(t, next) }
      if (next <= now) next = this.next(t, now)   // past the catch-up cap: the first time after now
    }
    missed = Math.min(missed, MAX_CATCHUP)
    const late = now - due > (s.graceMs ?? 60_000)
    const policy = s.misfire ?? 'once'
    const runs = !late ? Math.min(missed, policy === 'all' ? MAX_CATCHUP : 1) : policy === 'skip' ? 0 : policy === 'once' ? 1 : missed
    return { runs, next }
  }
}

const scheduled = () => tasks().filter((t) => t.opts.schedule)
