// One place for session-id digests. Audit DB rows keep hex[:32]; HTTP/inspector logs use base64url[:12].
import { createHash } from 'node:crypto'

/** Audit / admin long digest (hex, 32 chars). Never log the raw sid. */
export const sidHashAudit = (sid: string | undefined): string | null =>
  sid ? createHash('sha256').update(sid).digest('hex').slice(0, 32) : null

/** Access-log / inspector short digest (base64url, 12 chars). */
export const sidHashLog = (sid: string): string =>
  sid ? createHash('sha256').update(sid).digest('base64url').slice(0, 12) : ''
