// tvine.admin app lifecycle: ready() starts the dashboard collector (stats.ts) on the core stats tap, the memory log
// ring (the Logs page), the live channel groups (admin:live = "something changed, refetch"; admin:logs = each record)
// and the rollup flush. Stopped with the server (the last flush runs on close).
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { ServerCtx } from '../../core/dispatch.js'
import { memoryLog } from '../../log.js'
import { newCollector, startStats } from './stats.js'
import { runtime } from './system.js'

export async function ready(server: ServerCtx): Promise<void> {
  const conf = server.settings.admin.stats
  const col = newCollector(server.settings, (p) => server.route?.(p))
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
  const stop = conf.enabled ? startStats(col, conf.flushMs, server.log) : undefined
  server.onClose(async () => {
    unlog(); unread()
    runtime.lag?.disable()
    await stop?.()
  })
}
