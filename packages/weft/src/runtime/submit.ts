'use server'
import { getDispatcher, type FormResult } from './dispatcher.js'
import type { Command } from '../types.js'

// Next server action shim: the human path enters the SAME dispatcher agents use. Only the
// agent-visible Command fields pass through (incl. cmdId); sid/rev/auth come from the server side.
// Next's server-action origin check guards this endpoint (not re-implemented here).
export async function submitForm(cmd: Command): Promise<FormResult> {
  const cmdId = typeof cmd.cmdId === 'string' ? cmd.cmdId : undefined   // double-submit idempotency
  return getDispatcher()({ action: String(cmd.action), params: { ...cmd.params }, bind: cmd.bind, cmdId })
}
