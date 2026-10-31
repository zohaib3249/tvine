// tvine.tasks app lifecycle: AppConfig.ready() — discover tasks so actions can enqueue them, start the progress
// relay and (only when a task is durable) the outbox relay, add the /tvine/health section. Stopped with the server.
// broker 'memory' lives in this process only, so the web server runs its jobs itself (an embedded worker).
import type { ServerCtx } from '../../core/dispatch.js'
import { closeBroker } from './broker.js'
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
  server.health.set('tasks', healthSection(t.leaseMs, server.log))
}
