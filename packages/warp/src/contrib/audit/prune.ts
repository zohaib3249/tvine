// tvine.audit: the sink and retention (`tvine audit prune`, the optional `audit.prune` beat task).
import { setAuditSink, type AuditRow } from '../../core/audit.js'
import type { Settings } from '../../core/types.js'
import { AuditEntry } from './models.js'

export const retention = { days: 90 }   // settings.audit.retentionDays, set with the sink

export function installSink(settings: Settings): void {
  retention.days = settings.audit.retentionDays
  setAuditSink(async (row: AuditRow) => { await AuditEntry.create(row as never) })
}

// deletes rows older than `days` in batches (one short statement each: no long lock on a big table); returns how many
export async function pruneAudit(days = retention.days, now = Date.now(), batch = 5000): Promise<number> {
  const old = AuditEntry.objects.filter({ at__lt: new Date(now - days * 86_400_000) })
  let n = 0
  for (;;) {
    const ids = await old.order('id').limit(batch).valuesList('id', { flat: true }).all() as number[]
    if (!ids.length) return n
    n += await AuditEntry.objects.filter({ id__in: ids }).delete()
  }
}
