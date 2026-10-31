// tvine worker / tvine tasks (docs/design/contrib/tasks.md §Worker, §Ops). Called from the main CLI.
import { connections } from '../../data/db.js'
import type { Settings } from '../../core/types.js'
import { Beat } from './beat.js'
import { Job, type JobStatus } from './models.js'
import { configureTasks, discoverTasks } from './task.js'
import { Worker, type Log } from './worker.js'

export interface Io { out(s: string): void; err(s: string): void; exit(code: number): void }
type Flags = Record<string, string | boolean | undefined>

export function logger(mode: Settings['logging']): Log {
  if (mode === 'none') return () => {}
  return (level, msg, data = {}) => {
    const line = mode === 'json' ? JSON.stringify({ level, msg, ...data }) : `${level} ${msg} ${Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}`
    console.error(line)
  }
}

async function boot(apps: string, settings: Settings) {
  if (!settings.installedApps.includes('tvine.tasks')) throw new Error("tvine.tasks is not installed: add 'tvine.tasks' to settings.installedApps")
  configureTasks(settings.tasks)
  connections.configure(settings)
  return discoverTasks(apps, settings.installedApps)
}

const int = (v: unknown, name: string, min: number): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`)
  return n
}

export async function workerCommand(apps: string, settings: Settings, o: Flags, io: Io): Promise<undefined> {
  const found = await boot(apps, settings)
  const log = logger(settings.logging)
  const queues = typeof o.queues === 'string' && o.queues !== '*' ? o.queues.split(',').map((q) => q.trim()).filter(Boolean) : '*'
  const w = new Worker({ name: o.name as string | undefined, queues, concurrency: int(o.concurrency, 'concurrency', 0), graceMs: int(o.grace, 'grace', 0), log })
  const beat = o.beat ? new Beat({ log }) : undefined
  await w.start()
  beat?.start()
  io.out(`worker ${w.name}: ${found.length} task(s), queues ${queues === '*' ? '*' : queues.join(',')}, concurrency ${w.concurrency}${beat ? ', beat' : ''}`)
  let stopping = false
  const stop = () => {
    if (stopping) { io.err('tvine worker: second signal, exiting now'); io.exit(1); return }
    stopping = true
    io.err(`tvine worker: stopping (${w.busy} running; grace ${settings.tasks.graceMs} ms)`)
    void (async () => {
      await beat?.stop()
      await w.stop()
      await connections.closeAll()
    })().then(() => io.exit(0), (e: unknown) => { io.err(`tvine worker: stop failed: ${String(e)}`); io.exit(1) })
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  return undefined
}

const RETRYABLE: JobStatus[] = ['dead', 'expired', 'cancelled']

export async function tasksCommand(apps: string, settings: Settings, args: string[], o: Flags, io: Io): Promise<number> {
  await boot(apps, settings)
  try {
    const [sub, id] = args
    switch (sub) {
      case 'list': {
        let qs = Job.objects.order('-createdAt')
        if (typeof o.status === 'string') qs = qs.filter({ status: o.status })
        if (typeof o.queue === 'string') qs = qs.filter({ queue: o.queue })
        const rows = (await qs.page({ size: int(o.limit, 'limit', 1) ?? 50 })).items
        const t = [['ID', 'TASK', 'STATUS', 'TRIES', 'QUEUE', 'CREATED'], ...rows.map((j) => [j.id, j.task, j.status, String(j.attempts), j.queue, new Date(j.createdAt).toISOString()])]
        const w = t[0]!.map((_, i) => Math.max(...t.map((r) => r[i]!.length)))
        io.out(t.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n'))
        return 0
      }
      case 'inspect': {
        const j = id && (await Job.get(id).catch(() => undefined))
        if (!j) { io.err(`tvine tasks: no job ${id ?? ''}`); return 1 }
        io.out(JSON.stringify(j, null, 2))
        return 0
      }
      case 'retry': {
        const j = id && (await Job.get(id).catch(() => undefined))
        if (!j) { io.err(`tvine tasks: no job ${id ?? ''}`); return 1 }
        if (!RETRYABLE.includes(j.status)) { io.err(`tvine tasks: job ${j.id} is ${j.status}; only ${RETRYABLE.join(' / ')} jobs can be retried`); return 1 }
        const now = Date.now()
        const n = await Job.objects.filter({ id: j.id, status: j.status }).update({ status: 'queued', attempts: 0, runAt: now, error: null, finishedAt: null, purgeAt: null, cancel: false, expiresAt: null, updatedAt: now })
        if (!n) { io.err(`tvine tasks: job ${j.id} changed meanwhile; try again`); return 1 }
        io.out(`requeued ${j.id} (${j.task})`)
        return 0
      }
      case 'purge': {
        if (!o.dead) { io.err('usage: tvine tasks purge --dead'); return 1 }
        io.out(`purged ${await Job.objects.filter({ status: 'dead' }).delete()} dead job(s)`)
        return 0
      }
      default:
        io.err('usage: tvine tasks list [--status s] [--queue q] [--limit n] | inspect <jobId> | retry <jobId> | purge --dead')
        return 1
    }
  } finally { await connections.closeAll() }
}
