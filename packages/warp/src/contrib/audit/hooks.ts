// tvine.audit app lifecycle: ready() installs the audit sink dispatch writes through (core/audit.ts).
import type { ServerCtx } from '../../core/dispatch.js'
import { setAuditSink } from '../../core/audit.js'
import { installSink } from './prune.js'

export async function ready(server: ServerCtx): Promise<void> {
  if (!server.settings.audit.enabled) return
  installSink(server.settings)
  server.onClose(() => setAuditSink(undefined))
}
