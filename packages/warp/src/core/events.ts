import type { ActionId, Event, ErrCode, Rev, Sid, Snapshot } from './types.js'

// Event constructors + terminal check. Ordering rule: core-events.md.
export const ev = {
  snapshot: (snapshot: Snapshot): Event => ({ kind: 'snapshot', snapshot }),
  ok: (action: ActionId, result?: unknown): Event => ({ kind: 'ok', action, result }),
  err: (code: ErrCode, message: string, opts?: { field?: string; snapshot?: Snapshot }): Event => {
    const e: Extract<Event, { kind: 'err' }> = { kind: 'err', code, message }
    if (opts?.field !== undefined) e.field = opts.field
    if (opts?.snapshot !== undefined) e.snapshot = opts.snapshot
    return e
  },
  goto: (url: string): Event => ({ kind: 'goto', url }),
  update: (sid: Sid, rev: Rev, source: 'human' | 'agent'): Event => ({ kind: 'update', rev, sid, source }),
}

// snapshot | goto | err end a sync exchange.
export function isTerminal(e: Event): boolean {
  return e.kind === 'snapshot' || e.kind === 'goto' || e.kind === 'err'
}
