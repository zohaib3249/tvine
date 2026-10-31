// Built-in actions (MCP tools too): tasks.status / tasks.revoke. Only the job's session, its user or staff see a
// job; anyone else gets "not found" (existence is not leaked). Args are never returned; error text only to staff
// (others get a DomainError / Retry message, else "failed").
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx } from '../../core/types.js'
import { broker } from './broker.js'
import type { JobRow } from './models.js'
import { resolveJob, revoke as revokeJob } from './task.js'

const params = z.object({ jobId: z.string().uuid() })

// auth's user shape: top-level isActive / isStaff / isSuperuser; a BYO resolver may set only claims
type U = ActionCtx['request']['user'] & { isActive?: boolean; isStaff?: boolean; isSuperuser?: boolean }
export const isStaff = (ctx: Pick<ActionCtx, 'request'>): boolean => {
  const u = ctx.request.user as U, c = u.claims ?? {}
  const flag = (k: 'isActive' | 'isStaff' | 'isSuperuser') => u[k] ?? c[k]
  return u.isAuthenticated && flag('isActive') !== false && (flag('isStaff') === true || flag('isSuperuser') === true)
}

export function canSee(job: Pick<JobRow, 'sid' | 'userId'>, ctx: Pick<ActionCtx, 'sid' | 'request'>): boolean {
  const u = ctx.request.user
  return (job.sid != null && job.sid === ctx.sid) || (job.userId != null && u.isAuthenticated && u.id !== undefined && job.userId === String(u.id)) || isStaff(ctx)
}

// the requested row decides access (a deduped id is the requester's own row); the original it follows shows its
// status, but its result / error only when the caller may see that original too
async function visible(jobId: string, ctx: ActionCtx): Promise<{ asked: JobRow; job: JobRow; full: boolean }> {
  const asked = await broker().get(jobId)
  if (!asked || !canSee(asked, ctx)) throw new DomainError('not_found', 'job not found')
  const job = asked.status === 'deduped' ? (await resolveJob(jobId)) ?? asked : asked
  return { asked, job, full: job === asked || canSee(job, ctx) }
}

const publicError = (e: string) => (/^(DomainError|Retry): /.test(e) ? e.replace(/^\w+: /, '') : 'failed')

export function view(asked: JobRow, j: JobRow, full: boolean, staff: boolean) {
  return {
    jobId: asked.id, task: j.task, status: j.status, attempts: j.attempts, queue: j.queue,
    progress: j.progress, message: j.message,
    ...(full && j.status === 'success' && { result: j.result }),
    ...(full && j.error != null && j.status !== 'success' && { error: staff ? j.error : publicError(j.error) }),
    createdAt: new Date(asked.createdAt).toISOString(),
    ...(j.finishedAt != null && { finishedAt: new Date(j.finishedAt).toISOString() }),
  }
}

export const status = defineAction('status', params, async ({ jobId }, ctx) => {
  const { asked, job, full } = await visible(jobId, ctx)
  return view(asked, job, full, isStaff(ctx))
}, { readOnly: true })

export const revoke = defineAction('revoke', params, async ({ jobId }, ctx) => {
  const { job, full } = await visible(jobId, ctx)
  if (!full) throw new DomainError('not_found', 'job not found')
  return { jobId, status: await revokeJob(job.id) }
}, { destructive: true })
