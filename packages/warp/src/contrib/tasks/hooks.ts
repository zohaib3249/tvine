// tvine.tasks app lifecycle: AppConfig.ready() — discover tasks so actions can enqueue them, start the progress
// relay, add the /tvine/health section. Stopped with the server (ServerCtx.onClose).
import type { ServerCtx } from '../../core/dispatch.js'
import { healthSection, Relay } from './relay.js'
import { configureTasks, discoverTasks } from './task.js'

export async function ready(server: ServerCtx): Promise<void> {
  configureTasks(server.settings.tasks)
  if (server.appsDir) await discoverTasks(server.appsDir, server.settings.installedApps)
  const relay = new Relay(server, server.settings.tasks.relayMs)
  relay.start()
  server.onClose(() => relay.stop())
  server.health.set('tasks', healthSection(server.settings.tasks.leaseMs, server.log))
}
