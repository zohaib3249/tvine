// tvine.audit model (BACKLOG #1): one row per audited command (core/audit.ts AuditRow). user is the user's id as
// text (no fk: works with a BYO user resolver); sidHash is a hash, never the session id.
import { defineModel } from '../../data/model.js'
import { field } from '../../data/fields.js'

export const VIAS = ['human', 'agent', 'api-token', 'job', 'webmcp', 'tab'] as const

export const AuditEntry = defineModel('audit_entry', {
  id: field.id(),
  at: field.datetime({ auto: true, index: true }),
  userId: field.text({ optional: true, index: true }),
  via: field.enum(VIAS),
  agent: field.text({ optional: true }),
  agentVerified: field.bool({ default: false }),
  action: field.text({ index: true }),
  outcome: field.enum(['ok', 'error'] as const),
  code: field.text({ optional: true }),
  params: field.json({ optional: true }),
  ip: field.text(),
  sidHash: field.text({ optional: true }),
  ms: field.int(),
  requestId: field.text(),
  cmdId: field.text({ optional: true }),
})
