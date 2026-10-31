// tvine.tasks in tvine.admin: jobs read-only, listed from the broker (any broker: file / memory / redis / db),
// with retry and revoke actions (Django allowed_permissions → hasRetryPermission / hasRevokePermission).
import { DomainError } from '../../core/errors.js'
import { adminAction, ModelAdmin, type Ctx, type ListParams } from '../admin/options.js'
import { site } from '../admin/sites.js'
import { broker } from './broker.js'
import { Job, STATUSES, type JobRow } from './models.js'
import { revoke } from './task.js'

const perm = async (ctx: Ctx, admin: ModelAdmin) => {
  const u = ctx.request.user
  return !!u.isSuperuser || (!!u.hasPerm && (await u.hasPerm(`${admin.app()}.change_job`)))
}

export const retryJobs = adminAction({ name: 'retry', description: 'Retry selected jobs', permissions: ['retry'] }, async (_a, _ctx, _qs, pks) => {
  let n = 0
  for (const id of pks) if ((await broker().retry(id)) === 'requeued') n++
  return { message: `${n} job(s) requeued.`, level: 'success' }
})
export const revokeJobs = adminAction({ name: 'revoke', description: 'Revoke selected jobs', permissions: ['revoke'], confirm: true }, async (_a, _ctx, _qs, pks) => {
  for (const id of pks) await revoke(id)
  return { message: `${pks.length} job(s) revoked.`, level: 'success' }
})

export class JobAdmin extends ModelAdmin<JobRow> {
  listDisplay = ['id', 'task', 'queue', 'status', 'attempts', 'createdAt']
  listFilter = ['status']
  showFacets = false
  readonlyFields = Object.keys(Job.fields)
  // args / result / error can carry reset links, API keys, PII: left out of the form (and so of agent snapshots).
  // Opt in per project: site.register(Job, class extends JobAdmin { exclude = [] }) after unregistering this one.
  exclude = ['args', 'result', 'error']
  actions = [retryJobs, revokeJobs]
  str(j: Record<string, unknown>) { return `${String(j.task)} ${String(j.id)}` }

  hasAddPermission() { return false }
  hasChangePermission() { return false }
  hasDeletePermission() { return false }
  hasRetryPermission(ctx: Ctx) { return perm(ctx, this) }
  hasRevokePermission(ctx: Ctx) { return perm(ctx, this) }

  async getObject(_ctx: Ctx, pk: string | number) { return broker().get(String(pk)) }
  // ponytail: the broker lists by status/queue with a limit (no offset, no search): pages slice the newest 1000
  async changelist(_ctx: Ctx, p: ListParams) {
    const status = p.filters?.status
    for (const k of Object.keys(p.filters ?? {})) if (k !== 'status') throw new DomainError('invalid_param', `filters.${k}: not a list filter of this model`, `filters.${k}`)
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new DomainError('invalid_param', 'filters.status: not a choice', 'filters.status')
    const all = await broker().list({ status, limit: 1000 })
    const size = p.pageSize ?? this.listPerPage, page = p.page ?? 1
    return { rows: all.slice((page - 1) * size, page * size), count: all.length }
  }
}

site.register(Job, JobAdmin)
