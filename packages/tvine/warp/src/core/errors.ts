import type { ErrCode, FieldError } from './types.js'

// Domain failures thrown by handlers; dispatch maps them to err domain. `errors` lists every bad field
// (`errors: [{ field, message }]`); `field` stays the first one for older clients.
export class DomainError extends Error {
  constructor(public code: string, message: string, public field?: string, public errors?: FieldError[]) {
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
  human_only: 'only a human can do this; ask the user to do it themselves, do not retry',
  confirm_required: 'nothing ran: confirm as the message says (with the token), or ask the user when only they can confirm',
}
// err domain with reason 'forbidden' (route guards, permissions, cross-origin): no input change helps
const FORBIDDEN = 'not allowed for this session; do not retry it, choose another page or action'
// a size refusal (body or file over its limit): fixing a field's type does not help
const TOO_LARGE = 'send less: it is over the size limit shown'
export const recoveryOf = (e: { code: ErrCode; reason?: string }): string =>
  e.reason === 'too_large' ? TOO_LARGE : e.code === 'domain' && e.reason === 'forbidden' ? FORBIDDEN : recovery[e.code]
// zod issues → FieldError[] (all of them) + the classic single field / message. One issue keeps the old
// `field: message` text exactly; several are joined with '; '.
export function zodErrors(issues: { code: string; path: (string | number)[]; message: string; keys?: string[] }[], readOnly?: Set<string>):
  { errors: FieldError[]; field: string; message: string } {
  const errors: FieldError[] = issues.flatMap(i => i.code === 'unrecognized_keys'
    ? (i.keys ?? []).map(k => readOnly?.has(k) ? { field: k, code: 'read_only', message: `"${k}" is read-only` } : { field: k, code: 'unknown', message: `unknown param "${k}"` })
    : [{ field: String(i.path[0] ?? ''), code: i.code, message: i.path.length > 1 ? `${i.path.slice(1).join('.')}: ${i.message}` : i.message }])
  const text = (e: FieldError) => (e.code === 'unknown' || e.code === 'read_only' ? e.message : `${e.field}: ${e.message}`)
  return { errors, field: errors[0]?.field ?? '', message: errors.map(text).join('; ') }
}
export const RECOVERIES: string[] = [...new Set([...Object.values(recovery), FORBIDDEN, TOO_LARGE])]
