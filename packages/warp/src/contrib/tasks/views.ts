// Built-in actions (MCP tools too): tasks.status / tasks.revoke. Only the job's session, its user or staff see a
// job; anyone else gets "not found" (existence is not leaked). Args are never returned.
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx } from '../../core/types.js'
import type { JobRow } from './models.js'
import { resolveJob, revoke as revokeJob } from './task.js'

const params = z.object({ jobId: z.string().uuid() })

export const isStaff = (ctx: Pick<ActionCtx, 'request'>): boolean => {
  const c = ctx.request.user.claims
  return ctx.request.user.isAuthenticated && (c?.isStaff === true || c?.isSuperuser === true)
}

export function canSee(job: Pick<JobRow, 'sid' | 'userId'>, ctx: Pick<ActionCtx, 'sid' | 'request'>): boolean {
  const u = ctx.request.user
  return (job.sid != null && job.sid === ctx.sid) || (job.userId != null && u.isAuthenticated && u.id !== undefined && job.userId === String(u.id)) || isStaff(ctx)
}

async function visible(jobId: string, ctx: ActionCtx): Promise<JobRow> {
  const j = await resolveJob(jobId)
  if (!j || !canSee(j, ctx)) throw new DomainError('not_found', 'job not found')
  return j
}

export const view = (j: JobRow) => ({
  jobId: j.id, task: j.task, status: j.status, attempts: j.attempts, queue: j.queue,
  progress: j.progress, message: j.message,
  ...(j.status === 'success' && { result: j.result }),
  ...(j.error != null && j.status !== 'success' && { error: j.error }),
  createdAt: new Date(j.createdAt).toISOString(),
  ...(j.finishedAt != null && { finishedAt: new Date(j.finishedAt).toISOString() }),
})

export const status = defineAction('status', params, async ({ jobId }, ctx) => view(await visible(jobId, ctx)), { readOnly: true })

export const revoke = defineAction('revoke', params, async ({ jobId }, ctx) => {
  const j = await visible(jobId, ctx)
  return { jobId: j.id, status: await revokeJob(j.id) }
}, { destructive: true })
