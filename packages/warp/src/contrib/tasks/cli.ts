// tvine worker / tvine tasks (docs/design/contrib/tasks.md §Worker, §Ops). Called from the main CLI.
import { snapshotCacheFor } from '../../backends/index.js'
import { connections } from '../../data/db.js'
import { dataVersion } from '../../data/engine.js'
import { closeRedis, configureRedis } from '../../redis/index.js'
import type { Settings } from '../../core/types.js'
import { Beat } from './beat.js'
import { broker, closeBroker } from './broker.js'
import { benchConfigured } from './bench.js'
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

// broker 'memory' lives inside ONE process: a separate worker / CLI would see an empty, private store
const MEMORY = "settings.tasks.broker is 'memory': jobs live inside the web server's process only, so a separate `tvine worker` / `tvine tasks` cannot see them (the web server runs them itself). Use broker 'file' (default) or 'redis' to run workers as separate processes."

async function boot(apps: string, settings: Settings, cmd: string) {
  if (!settings.installedApps.includes('tvine.tasks')) throw new Error("tvine.tasks is not installed: add 'tvine.tasks' to settings.installedApps")
  if (settings.tasks.broker === 'memory' && cmd !== 'bench') throw new Error(MEMORY)
  configureTasks(settings.tasks)
  // tvine.audit: jobs write audit rows (via 'job') and the prune task reads the retention
  if (settings.audit.enabled) (await import('../audit/prune.js')).installSink(settings)
  connections.configure(settings)
  configureRedis(settings)
  return discoverTasks(apps, settings.installedApps)
}

const int = (v: unknown, name: string, min: number): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`)
  return n
}

// Job handlers write the app's database from this process: with a shared snapshot cache (snapshotCache.backend
// 'redis') those commits must bump the shared version too, exactly like a web server's, or the web servers would keep
// serving pre-job snapshots until the TTL. With the in-process cache there is nothing shared to tell: say so once.
export function workerCache(settings: Settings, log: Log): ReturnType<typeof snapshotCacheFor> {
  const c = settings.snapshotCache
  if (c.backend !== 'redis' && c.ttlMs > 0) log('warn', 'worker.snapshotCache', { msg: "snapshotCache.backend is 'memory': the web servers' cached snapshots do not see job writes until ttlMs passes; use backend 'redis' to invalidate them at once" })
  return snapshotCacheFor(settings, dataVersion, log)
}

export async function workerCommand(apps: string, settings: Settings, o: Flags, io: Io): Promise<undefined> {
  const found = await boot(apps, settings, 'worker')
  const log = logger(settings.logging)
  const queues = typeof o.queues === 'string' && o.queues !== '*' ? o.queues.split(',').map((q) => q.trim()).filter(Boolean) : '*'
  const w = new Worker({ name: o.name as string | undefined, queues, concurrency: int(o.concurrency, 'concurrency', 0), graceMs: int(o.grace, 'grace', 0), log })
  const beat = o.beat ? new Beat({ log }) : undefined
  const outbox = new OutboxRelay(log)
  const cache = workerCache(settings, log)
  await w.start()
  beat?.start()
  outbox.start()
  io.out(`worker ${w.name}: ${found.length} task(s), broker ${settings.tasks.broker ?? 'file'}, queues ${queues === '*' ? '*' : queues.join(',')}, concurrency ${w.concurrency}${beat ? ', beat' : ''}`)
  let stopping = false
  const stop = () => {
    if (stopping) { io.err('tvine worker: second signal, exiting now'); io.exit(1); return }
    stopping = true
    io.err(`tvine worker: stopping (${w.busy} running; grace ${settings.tasks.graceMs} ms)`)
    void (async () => {
      await beat?.stop()
      await outbox.stop()
      await w.stop()
      await cache.settle?.()
      cache.close?.()
      await closeBroker()
      await connections.closeAll()
      await closeRedis()
    })().then(() => io.exit(0), (e: unknown) => { io.err(`tvine worker: stop failed: ${String(e)}`); io.exit(1) })
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  return undefined
}

export async function tasksCommand(apps: string, settings: Settings, args: string[], o_: Flags, io: Io): Promise<number> {
  const o = o_
  const [sub, id] = args
  await boot(apps, settings, sub ?? '')
  try {
    if (sub === 'bench') {
      const o = { jobs: int(o_.jobs, 'jobs', 1) ?? 5000, workers: int(o_.workers, 'workers', 1) ?? 4, batch: int(o_.batch, 'batch', 1) ?? settings.tasks.claimBatch }
      if (o.batch > 100) throw new Error('--batch must be <= 100')
      const r = await benchConfigured(settings, o)
      io.out(`${r.broker}: ${r.jobs} jobs · enqueue ${r.enqueuePerSec}/s (one transaction each) · claim+complete ${r.jobsPerSec} jobs/s (${o.workers} claimers, batch ${o.batch}) · claim p50 ${r.claimP50Ms} ms, p99 ${r.claimP99Ms} ms${r.busyRetries ? ` · ${r.busyRetries} SQLITE_BUSY retries` : ''}`)
      return 0
    }
    const b = broker()
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
      case 'compact': {
        if (!b.compact) { io.err(`tvine tasks compact: broker '${settings.tasks.broker}' has nothing to compact`); return 1 }
        const r = await b.compact()
        io.out(`compacted ${settings.tasks.file}: ${(r.before / 1e6).toFixed(1)} MB → ${(r.after / 1e6).toFixed(1)} MB`)
        return 0
      }
      default:
        io.err('usage: tvine tasks list [--status s] [--queue q] [--limit n] | inspect <jobId> | retry <jobId> | purge --dead | compact | bench [--jobs n] [--workers n] [--batch n]')
        return 1
    }
  } finally { await closeBroker(); await connections.closeAll(); await closeRedis() }
}
