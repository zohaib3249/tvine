import type { ErrCode } from './types.js'

// Domain failures thrown by handlers; dispatch maps them to err domain.
export class DomainError extends Error {
  constructor(public code: string, message: string, public field?: string) {
    super(message)
    this.name = 'DomainError'
  }
}

// The page a snapshot render was for redirected (Next redirect()): agents get a `goto`, not an error.
export class Goto extends Error {
  constructor(public url: string) { super(`redirect to ${url}`); this.name = 'Goto' }
}

// Recovery hint appended to err messages on the wire (core-errors.md taxonomy).
export const recovery: Record<ErrCode, string> = {
  invalid_param: 'fix the field named in the error to match the expected type; see the action spec in the snapshot',
  unknown_action: 'use one of the valid actions listed for this page',
  stale_bind: 're-read the page and use its fresh action refs',
  stale_rev: 'state changed; a fresh snapshot is attached, retry against it',
  expired_sid: 'a new sid is in the attached snapshot envelope; use it from now on',
  rate_limited: 'retry after the delay shown',
  conflict: 'command already executed with different params; use a new cmdId for new params',
  domain: 'the message above is the business rule; change the input or choose another option',
  internal: 'server error; retry once, then re-read the page',
}
// err domain with reason 'forbidden' (route guards, permissions, cross-origin): no input change helps
const FORBIDDEN = 'not allowed for this session; do not retry it, choose another page or action'
// a size refusal (body or file over its limit): fixing a field's type does not help
const TOO_LARGE = 'send less: it is over the size limit shown'
export const recoveryOf = (e: { code: ErrCode; reason?: string }): string =>
  e.reason === 'too_large' ? TOO_LARGE : e.code === 'domain' && e.reason === 'forbidden' ? FORBIDDEN : recovery[e.code]
export const RECOVERIES: string[] = [...new Set([...Object.values(recovery), FORBIDDEN, TOO_LARGE])]
