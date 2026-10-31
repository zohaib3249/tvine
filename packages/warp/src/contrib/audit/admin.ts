// tvine.audit in tvine.admin: read-only (loaded by the admin's autodiscover only when 'tvine.admin' is installed).
import { ModelAdmin } from '../admin/options.js'
import { site } from '../admin/sites.js'
import { AuditEntry } from './models.js'

export class AuditAdmin extends ModelAdmin {
  listDisplay = ['at', 'userId', 'via', 'action', 'outcome', 'code', 'ms']
  listFilter = ['via', 'action', 'outcome', 'at']
  searchFields = ['userId', 'action']
  dateHierarchy = 'at'
  ordering = ['-at']
  readonlyFields = Object.keys(AuditEntry.fields)
  str(r: Record<string, unknown>) { return `${String(r.action)} by ${String(r.userId ?? 'anonymous')}` }
  hasAddPermission() { return false }
  hasChangePermission() { return false }
  hasDeletePermission() { return false }
}

site.register(AuditEntry, AuditAdmin)
