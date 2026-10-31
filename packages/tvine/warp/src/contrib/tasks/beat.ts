// Beat: periodic tasks (docs/design/contrib/tasks.md §Beat). One leader through the broker's lock('beat'); each due
// schedule is fired with a compare-and-set of its nextRunAt in the same transaction as its jobs, so even two beats
// that both believe they lead never send a fire time twice. Unique tasks are pushed right after the fire.
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { broker as current, type Broker } from './broker.js'
import { nextFire, parseCron, type Cron } from './cron.js'
import { buildRow, checkSchedule, push, tasks, uniqueKey, type ScheduleOpt, type Task } from './task.js'
import type { Log } from './worker.js'

const MAX_CATCHUP = 100
const KEY = 'beat'

export interface BeatOpts { name?: string; tickMs?: number; lockMs?: number; log?: Log; now?: () => number; broker?: Broker }

export class Beat {
  readonly name: string
  private tickMs: number; private lockMs: number
  private log: Log
  private now: () => number
  private broker: Broker
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
    this.broker = o.broker ?? current()
  }

  get isLeader(): boolean { return this.leading }

  start(): void {
    for (const t of scheduled()) { checkSchedule(t); this.spec(t) }   // a bad cron / args fail at start, not at a fire
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    void this.tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.running
    if (this.leading) await this.broker.unlock(KEY, this.name).catch(() => undefined)
    this.leading = false
  }

  tick(): Promise<void> {
    return (this.running ??= this.step()
      .catch((e) => this.log('error', 'beat.tick', { beat: this.name, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { this.running = undefined }))
  }

  // one failing schedule never stops the others
  private async step(): Promise<void> {
    if (!(await this.lead())) return
    for (const t of scheduled()) {
      try { await this.due(t) } catch (e) {
        this.log('error', 'beat.error', { beat: this.name, task: t.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  // take the lock when free or expired; renew it every lockMs/3; a failed renew = no longer the leader
  private async lead(): Promise<boolean> {
    const now = this.now()
    if (this.leading && now - this.renewedAt < this.lockMs / 3) return true
    const was = this.leading
    this.leading = await this.broker.lock(KEY, this.name, this.lockMs, now)
    if (this.leading) this.renewedAt = now
    if (was !== this.leading) this.log(this.leading ? 'info' : 'warn', this.leading ? 'beat.leader' : 'beat.lost', { beat: this.name })
    return this.leading
  }

  private spec(t: Task): string {
    const s = t.opts.schedule!
    if ('cron' in s) { if (!this.crons.has(t.id)) this.crons.set(t.id, parseCron(s.cron)); return `cron:${s.cron}` }
    return `every:${s.every}`
  }

  private next(t: Task, after: number): number {
    const s = t.opts.schedule!
    return 'cron' in s ? nextFire(this.crons.get(t.id) ?? parseCron(s.cron), after).getTime() : after + s.every
  }

  private async due(t: Task): Promise<void> {
    const now = this.now(), s = t.opts.schedule!
    const row = await this.broker.schedule(t.id, this.spec(t), () => this.next(t, now))
    if (row.fresh || row.nextRunAt > now) return
    const { runs, next } = this.fires(t, s, row.nextRunAt, now)
    const jobs = Array.from({ length: runs }, () => buildRow(t, s.args, {}, { sid: null, userId: null }))
    const unique = !!t.opts.unique
    if (!(await this.broker.fire(t.id, row.nextRunAt, next, unique ? [] : jobs))) return
    if (unique) for (const j of jobs) await push({ jobs: [j], unique: { key: uniqueKey(t, j.args), windowMs: t.opts.unique!.windowMs } })
    this.log('info', 'beat.sent', { beat: this.name, task: t.id, runs, late: now - row.nextRunAt, next })
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
