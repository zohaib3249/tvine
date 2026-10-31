// tvine.tasks app lifecycle: AppConfig.ready() — discover tasks so actions can enqueue them, start the progress
// relay and (only when a task is durable) the outbox relay, add the /tvine/health section. Stopped with the server.
import type { ServerCtx } from '../../core/dispatch.js'
import { healthSection, OutboxRelay, ProgressRelay } from './relay.js'
import { configureTasks, discoverTasks } from './task.js'

export async function ready(server: ServerCtx): Promise<void> {
  configureTasks(server.settings.tasks)
  if (server.appsDir) await discoverTasks(server.appsDir, server.settings.installedApps)
  const progress = new ProgressRelay(server, server.settings.tasks.relayMs)
  progress.start()
  const outbox = new OutboxRelay(server.log)
  outbox.start()
  server.onClose(async () => { progress.stop(); await outbox.stop() })
  server.health.set('tasks', healthSection(server.settings.tasks.leaseMs, server.log))
}
