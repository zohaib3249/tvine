// tvine.admin app lifecycle: ready() starts the dashboard collector (stats.ts) on the core stats tap, the memory log
// ring (the Logs page), the live channel groups (admin:live = "something changed, refetch"; admin:logs = each record)
// and the rollup flush. Stopped with the server (the last flush runs on close).
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { ServerCtx } from '../../core/dispatch.js'
import { stats, type Stat } from '../../core/metrics.js'
import { memoryLog } from '../../log.js'
import { Collector } from './stats.js'
import { runtime } from './system.js'

export async function ready(server: ServerCtx): Promise<void> {
  const conf = server.settings.admin.stats
  const col = new Collector({ slowMs: server.settings.db.slowQueryMs || 100, retentionDays: conf.retentionDays })
  runtime.ctx = server
  runtime.collector = col
  runtime.lag ??= monitorEventLoopDelay({ resolution: 20 })
  runtime.lag.enable()
  memoryLog.ensure()

  const live = server.channels.group('admin:live'), logs = server.channels.group('admin:logs')
  const last: Record<string, number> = {}
  col.onLive = (type) => {   // at most one nudge per kind per second; nobody listening = nothing sent
    const now = Date.now()
    if (now - (last[type] ?? 0) < 1000 || !live.size()) return
    last[type] = now
    live.send({ kind: 'patch', rev: 0, changes: { type } })
  }
  const unlog = memoryLog.subscribe((r) => {
    col.log(r)
    if (logs.size()) logs.send({ kind: 'patch', rev: 0, changes: { type: 'log', record: r } })
  })
  const unread = server.hooks.on('read', (e) => col.read(e.sid, e.page))
  const tap = (s: Stat) => col.record(s)
  let timer: ReturnType<typeof setInterval> | undefined
  if (conf.enabled) {
    stats.tap = tap
    timer = setInterval(() => { col.flush().catch((e: unknown) => server.log('warn', 'admin stats flush failed', { error: (e as Error).message })) }, conf.flushMs)
    timer.unref?.()
  }
  server.onClose(async () => {
    clearInterval(timer)
    if (stats.tap === tap) stats.tap = undefined
    unlog(); unread()
    runtime.lag?.disable()
    if (conf.enabled) await col.flush().catch(() => { /* the database may already be closed */ })
  })
}
