// tvine.tasks app lifecycle: AppConfig.ready() — discover tasks so actions can enqueue them, start the progress
// relay and (only when a task is durable) the outbox relay, add the /tvine/health section. Stopped with the server.
// broker 'memory' lives in this process only, so the web server runs its jobs itself (an embedded worker).
import type { ServerCtx } from '../../core/dispatch.js'
import { brokerKind, closeBroker } from './broker.js'
import { metrics } from '../../core/metrics.js'
import { healthSection, OutboxRelay, ProgressRelay, relayClaim } from './relay.js'
import { configureTasks, discoverTasks } from './task.js'
import { Worker } from './worker.js'

export async function ready(server: ServerCtx): Promise<void> {
  const t = server.settings.tasks
  configureTasks(t)
  if (server.appsDir) await discoverTasks(server.appsDir, server.settings.installedApps)
  const progress = new ProgressRelay(server, t.relayMs, relayClaim(server.settings))
  progress.start()
  const outbox = new OutboxRelay(server.log)
  outbox.start()
  let worker: Worker | undefined
  if (t.broker === 'memory') {
    server.log('warn', "tasks: broker 'memory' keeps jobs in this process only — they run here (embedded worker) and are lost on restart; a separate `tvine worker` cannot see them. Use 'file' (default) or 'redis' beyond dev / tests.")
    worker = new Worker({ log: server.log })
    await worker.start()
  }
  server.onClose(async () => { progress.stop(); await outbox.stop(); await worker?.stop(); await closeBroker() })
  const health = healthSection(t.leaseMs, server.log)
  server.health.set('tasks', health)
  // queue depth per status from the same cached stats as /tvine/health (a scrape never waits on the store)
  metrics.gauge('tvine_tasks_jobs', () => {
    const s = health() as Partial<Record<'queued' | 'scheduled' | 'running' | 'dead', number>>
    const broker = brokerKind() ?? 'file'
    return (['queued', 'scheduled', 'running', 'dead'] as const).filter((k) => typeof s[k] === 'number').map((k) => [{ broker, status: k }, s[k]!])
  })
}
