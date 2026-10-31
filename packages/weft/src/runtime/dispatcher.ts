import 'server-only'
import type { Command } from '../types.js'
import type { ConfirmAsk } from '../api/core.js'

// Result of a human form submit (primitive-form.md §Human validation errors).
export interface FormResult { ok: boolean; errors?: Record<string, string>; message?: string; goto?: string; confirm?: ConfirmAsk }
export type Dispatcher = (cmd: Command) => Promise<FormResult>

// globalThis-stored like setSigner: Next builds several module graphs.
// TODO(Task 8): server wiring calls setDispatcher((cmd) => dispatch(cmd, req)) at boot.
const KEY = Symbol.for('tvine.dispatcher')
const store = globalThis as { [KEY]?: Dispatcher }

export function setDispatcher(fn: Dispatcher | undefined): void {
  store[KEY] = fn
}

export function getDispatcher(): Dispatcher {
  const d = store[KEY]
  if (!d) throw new Error('tvine: <Form> submitted but no dispatcher configured (setDispatcher)')
  return d
}
