// tvine worker / tvine tasks (docs/design/contrib/tasks.md §Worker, §Ops). Called from the main CLI.
import { connections } from '../../data/db.js'
import type { Settings } from '../../core/types.js'
import { Beat } from './beat.js'
import { broker } from './broker.js'
import { STATUSES, type JobStatus } from './models.js'
import { OutboxRelay } from './relay.js'
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
  const outbox = new OutboxRelay(log)
  await w.start()
  beat?.start()
  outbox.start()
  io.out(`worker ${w.name}: ${found.length} task(s), queues ${queues === '*' ? '*' : queues.join(',')}, concurrency ${w.concurrency}${beat ? ', beat' : ''}`)
  let stopping = false
  const stop = () => {
    if (stopping) { io.err('tvine worker: second signal, exiting now'); io.exit(1); return }
    stopping = true
    io.err(`tvine worker: stopping (${w.busy} running; grace ${settings.tasks.graceMs} ms)`)
    void (async () => {
      await beat?.stop()
      await outbox.stop()
      await w.stop()
      await connections.closeAll()
    })().then(() => io.exit(0), (e: unknown) => { io.err(`tvine worker: stop failed: ${String(e)}`); io.exit(1) })
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  return undefined
}

export async function tasksCommand(apps: string, settings: Settings, args: string[], o: Flags, io: Io): Promise<number> {
  await boot(apps, settings)
  const b = broker()
  try {
    const [sub, id] = args
    switch (sub) {
      case 'list': {
        if (typeof o.status === 'string' && !(STATUSES as readonly string[]).includes(o.status)) throw new Error(`--status must be one of ${STATUSES.join(', ')}`)
        const rows = await b.list({ status: o.status as string | undefined, queue: o.queue as string | undefined, limit: int(o.limit, 'limit', 1) ?? 50 })
        const t = [['ID', 'TASK', 'STATUS', 'TRIES', 'QUEUE', 'CREATED'], ...rows.map((j) => [j.id, j.task, j.status, String(j.attempts), j.queue, new Date(j.createdAt).toISOString()])]
        const w = t[0]!.map((_, i) => Math.max(...t.map((r) => r[i]!.length)))
        io.out(t.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n'))
        return 0
      }
      case 'inspect': {
        const j = id && (await b.get(id))
        if (!j) { io.err(`tvine tasks: no job ${id ?? ''}`); return 1 }
        io.out(JSON.stringify(j, null, 2))
        return 0
      }
      case 'retry': {
        const r = id ? await b.retry(id) : undefined
        if (r === undefined) { io.err(`tvine tasks: no job ${id ?? ''}`); return 1 }
        if (r !== 'requeued') { io.err(`tvine tasks: job ${id} is ${r}; only dead / expired / cancelled jobs can be retried`); return 1 }
        io.out(`requeued ${id}`)
        return 0
      }
      case 'purge': {
        if (!o.dead) { io.err('usage: tvine tasks purge --dead'); return 1 }
        io.out(`purged ${await b.purge('dead' as JobStatus)} dead job(s)`)
        return 0
      }
      default:
        io.err('usage: tvine tasks list [--status s] [--queue q] [--limit n] | inspect <jobId> | retry <jobId> | purge --dead')
        return 1
    }
  } finally { await connections.closeAll() }
}
