// tvine start --workers <n|auto> (or WEB_CONCURRENCY): one primary (node:cluster) forks N workers on one port, the OS
// shares the connections. Each worker is a full `tvine start` (TVINE_WORKER=<slot>); the primary only checks the
// settings, pings Redis, restarts crashed workers and stops them all on SIGTERM / SIGINT.
// Nothing in the web server needs moving to one worker: beat runs only in `tvine worker --beat` (one leader through the
// broker lock), the redis session sweep claims each expired sid once, the progress relay claims through redis, the
// outbox relay's enqueue skips a job id already there, shield hit counts / admin stats flush per-process buffers
// (additive / per-process rows), and the memory-only per-process state is refused below.
import cluster, { type Worker } from 'node:cluster'
import { availableParallelism } from 'node:os'
import type { Settings } from '../core/types.js'
import { backendTable } from '../backends/index.js'
import { redisUsers } from '../settings.js'
import { configureRedis, closeRedis, redis, safeUrl } from '../redis/index.js'

// flag wins over WEB_CONCURRENCY; 'auto' = the CPU cores; default 1
export function workerCount(flag: string | undefined, webConcurrency: string | undefined, cores = availableParallelism()): number {
  const v = (flag ?? webConcurrency ?? '1').trim()
  if (v === 'auto') return cores
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new Error(`${flag !== undefined ? '--workers' : 'WEB_CONCURRENCY'} must be a number >= 1 or auto (got '${v}')`)
  return Number(v)
}

export function coresWarning(n: number, cores = availableParallelism()): string | undefined {
  if (n !== 1 || cores <= 1) return undefined
  return `tvine start: using 1 of ${cores} CPU cores. To use all of them: set up Redis (REDIS_URL + the backends) and run: tvine start --workers auto`
}

const FIX: Record<string, string> = {
  'session.backend': "session: { backend: 'redis' }", 'channels.backend': "channels: { backend: 'redis' }",
  'limits.backend': "limits: { backend: 'redis' }", 'snapshotCache.backend': "snapshotCache: { backend: 'redis' }", 'tasks.broker': "tasks: { broker: 'redis' }",
}

// every backend still in this process's memory (limits covers rate limits, idempotency, login throttle, tab agent
// marks and Shield's limiter / claims); undefined = all shared. file / dummy caches and the file / db brokers are fine.
export function sharedStateProblem(settings: Settings, n: number, settingsFile = 'config/settings/prod.ts'): string | undefined {
  const mem = backendTable(settings).filter((r) => r.backend === 'memory')
    .map((r) => r.key.startsWith('caches.') ? { name: r.key.slice(0, -'.backend'.length), fix: `caches: { ${r.key.split('.')[1]}: { backend: 'redis' } }` } : { name: r.key, fix: FIX[r.key]! })
  if (!mem.length) return undefined
  const w = Math.max(...mem.map((m) => m.name.length)) + ' = memory'.length
  return [
    `tvine start: ${n} workers need shared state, but these are in memory:`,
    ...mem.map((m) => `  ${`${m.name} = memory`.padEnd(w)}  → ${m.fix}`),
    settings.redis.default
      ? `Add the lines above to ${settingsFile}`
      : `Add to ${settingsFile}:  redis: { default: { url: env.get('REDIS_URL') } }  and the lines above (REDIS_URL alone also fills settings.redis.default)`,
    '(one worker keeps working without Redis: tvine start)',
  ].join('\n')
}

// one PING per redis alias the backends use; an error string naming it, or undefined
export async function pingRedis(settings: Settings): Promise<string | undefined> {
  configureRedis(settings)
  try {
    for (const alias of new Set(redisUsers(settings).map((u) => u.alias))) {
      const r = await redis.ping(alias)
      if (!r.ok) return `tvine start: cannot reach Redis settings.redis.${alias} (${safeUrl(settings.redis[alias]!.url)}): ${r.error}`
    }
    return undefined
  } finally { await closeRedis() }
}

const WINDOW_MS = 60_000, MAX_RESTARTS = 5, STOP_MS = 10_000

// the primary: fork n workers, restart a crashed one (backoff 0.5 s, 1 s, 2 s …; more than 5 in a minute = that slot
// stays down, loudly, the others keep serving), SIGTERM / SIGINT = every worker closes gracefully, then exit
export function runPrimary(n: number, io: { out(s: string): void; err(s: string): void; exit(code: number): void }): void {
  const live = new Set<Worker>(), crashes = new Map<number, number[]>(), up = new Set<number>(), dead = new Set<number>()
  let stopping = false
  const fork = (slot: number) => {
    const w = cluster.fork({ TVINE_WORKER: String(slot) })
    live.add(w)
    w.on('listening', (a) => { if (up.size < n && !up.has(slot) && up.add(slot).size === n) io.out(`tvine start: ${n} workers on :${a.port}`) })
    w.on('exit', (code, sig) => {
      live.delete(w)
      if (stopping) { if (!live.size) io.exit(0); return }
      const now = Date.now(), recent = (crashes.get(slot) ?? []).filter((t) => now - t < WINDOW_MS)
      if (recent.length >= MAX_RESTARTS) {
        dead.add(slot)
        io.err(`tvine start: WORKER ${slot} CRASHED ${MAX_RESTARTS + 1} TIMES IN A MINUTE (last exit: ${code ?? sig}); NOT RESTARTING IT. ${live.size} of ${n} workers still serving.`)
        if (dead.size === n) io.exit(1)
        return
      }
      recent.push(now); crashes.set(slot, recent)
      const ms = 500 * 2 ** (recent.length - 1)
      io.err(`tvine start: worker ${slot} (pid ${w.process.pid}) exited (${code ?? sig}); restarting in ${ms} ms`)
      setTimeout(() => { if (!stopping) fork(slot) }, ms)
    })
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const w of live) w.process.kill('SIGTERM')   // each worker: srv.close() (in-flight requests finish), exit 0
    setTimeout(() => { io.err(`tvine start: workers did not stop within ${STOP_MS / 1000} s; killing them`); for (const w of live) w.process.kill('SIGKILL'); io.exit(1) }, STOP_MS).unref()
    if (!live.size) io.exit(0)
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  for (let slot = 1; slot <= n; slot++) fork(slot)
}
