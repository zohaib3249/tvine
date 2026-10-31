import type { ActionId, ConfirmAsk, Event, ErrCode, FieldError, Rev, Sid, Snapshot } from './types.js'

// Event constructors + terminal check. Ordering rule: core-events.md.
export const ev = {
  snapshot: (snapshot: Snapshot): Event => ({ kind: 'snapshot', snapshot }),
  ok: (action: ActionId, result?: unknown): Event => ({ kind: 'ok', action, result }),
  err: (code: ErrCode, message: string, opts?: { field?: string; errors?: FieldError[]; snapshot?: Snapshot; reason?: string; retryAfterMs?: number; confirm?: ConfirmAsk }): Event => {
    const e: Extract<Event, { kind: 'err' }> = { kind: 'err', code, message }
    if (opts?.field !== undefined) e.field = opts.field
    if (opts?.errors?.length) e.errors = opts.errors
    if (opts?.snapshot !== undefined) e.snapshot = opts.snapshot
    if (opts?.reason !== undefined) e.reason = opts.reason
    if (opts?.retryAfterMs !== undefined) e.retryAfterMs = opts.retryAfterMs
    if (opts?.confirm !== undefined) e.confirm = opts.confirm
    return e
  },
  goto: (url: string): Event => ({ kind: 'goto', url }),
  update: (sid: Sid, rev: Rev, source: 'human' | 'agent', action?: ActionId): Event => ({ kind: 'update', rev, sid, source, ...(action && { action }) }),
}

// snapshot | goto | err end a sync exchange.
export function isTerminal(e: Event): boolean {
  return e.kind === 'snapshot' || e.kind === 'goto' || e.kind === 'err'
}
