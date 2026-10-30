'use server'
import { getDispatcher, type FormResult } from './dispatcher.js'
import type { Command } from '../types.js'

// Next server action shim: the human path enters the SAME dispatcher agents use. Only the
// agent-visible Command fields pass through; sid/rev/auth come from the server side.
// Next's server-action origin check guards this endpoint (not re-implemented here).
export async function submitForm(cmd: Command): Promise<FormResult> {
  return getDispatcher()({ action: String(cmd.action), params: { ...cmd.params }, bind: cmd.bind })
}
