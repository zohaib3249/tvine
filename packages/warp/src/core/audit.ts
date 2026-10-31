// core/audit — the audit trail's hook point (BACKLOG #1). Dispatch builds one row per audited command; tvine.audit
// (contrib/audit) installs the sink that stores it. No sink (app not installed / audit off) = nothing is written.
import { createHash } from 'node:crypto'
import { redactSecrets } from './redact.js'
import type { ActionDef, Request, Settings } from './types.js'
import { getLogger } from '../log.js'
import { outsideAtomic } from '../data/engine.js'

export type AuditVia = 'human' | 'agent' | 'api-token' | 'job' | 'webmcp' | 'tab'
export interface AuditRow {
  userId: string | null              // null = anonymous
  via: AuditVia
  agent: string | null               // the agent's self-declared name (UA / MCP clientInfo): unverified
  agentVerified: boolean
  action: string
  outcome: 'ok' | 'error'
  code: string | null                // err code ('domain', 'human_only', …) and reason when it has one
  params: unknown                    // redacted
  ip: string
  sidHash: string | null             // sha256 of the sid, never the sid
  ms: number
  requestId: string
  cmdId: string | null
}

// on globalThis: one sink however many copies of warp a process loads
const KEY = Symbol.for('tvine.auditSink')
const slot: { write?: (row: AuditRow) => Promise<void> } = ((globalThis as { [KEY]?: typeof slot })[KEY] ??= {})
export const setAuditSink = (write?: (row: AuditRow) => Promise<void>) => { slot.write = write }
export const auditSinkSet = () => !!slot.write

export const audited = (settings: Settings, def: ActionDef | undefined): boolean =>
  !!slot.write && !!def && settings.audit.enabled && def.rules?.audit !== false && (settings.audit.actions === 'all' || !def.rules?.readOnly)

export function viaOf(r: Request): AuditVia {
  if (!r.agent.is) return r.user.scopes ? 'api-token' : 'human'
  return r.agent.via === 'webmcp' ? 'webmcp' : r.agent.via === 'channel' ? 'tab' : 'agent'
}

export const sidHash = (sid: string | undefined) => (sid ? createHash('sha256').update(sid).digest('hex').slice(0, 32) : null)

export function redactParams(settings: Settings, params: unknown): unknown {
  return redactSecrets(params, 0, new Set(settings.audit.redact.map((k) => k.toLowerCase())))
}

export function auditRow(settings: Settings, o: { action: string; params: unknown; request: Request; sid?: string; cmdId?: string; ms: number; code?: string }): AuditRow {
  const r = o.request, u = r.user
  return {
    userId: u.isAuthenticated && u.id !== undefined ? String(u.id) : null,
    via: viaOf(r),
    agent: r.agent.is ? (r.agent.client ?? null) : null,
    agentVerified: !!r.agent.verified,
    action: o.action,
    outcome: o.code ? 'error' : 'ok',
    code: o.code ?? null,
    params: redactParams(settings, o.params),
    ip: r.ip, sidHash: sidHash(o.sid), ms: Math.round(o.ms), requestId: r.id, cmdId: o.cmdId ?? null,
  }
}

export const writeAudit = (row: AuditRow): Promise<void> => slot.write ? slot.write(row) : Promise.resolve()

// THE security channel (docs/design/conventions/logging.md §tvine.security): login ok/fail, lockout, permission
// denied, human_only, confirm, origin / host / ip refusals, rate-limit hits. Logged on `tvine.security` (redacted);
// with settings.audit on, also one audit row (action `security.<event>`), written outside the caller's transaction
// so a refused command's rollback keeps it. audit: false for floods (rate limits, scanners).
const security = getLogger('tvine.security')
export function securityEvent(event: string, fields: Record<string, unknown>, o: { settings?: Settings; request?: Request; sid?: string; level?: 'info' | 'warn'; audit?: boolean } = {}): void {
  const r = o.request
  const f = { event, ...(r && { ip: r.ip, requestId: r.id, path: r.path, userId: r.user.isAuthenticated ? r.user.id ?? null : null, via: viaOf(r) }), ...(o.sid && { sidHash: sidHash(o.sid) }), ...fields }
  const level = o.level ?? (event === 'login_ok' ? 'info' : 'warn')
  security[level](event, f)
  if (o.audit === false || !o.settings?.audit.enabled || !slot.write) return
  const row: AuditRow = {
    userId: f.userId == null ? null : String(f.userId), via: r ? viaOf(r) : 'human', agent: r?.agent.is ? (r.agent.client ?? null) : null,
    agentVerified: !!r?.agent.verified, action: `security.${event}`, outcome: level === 'info' ? 'ok' : 'error', code: event,
    params: redactParams(o.settings, fields), ip: String(f.ip ?? ''), sidHash: sidHash(o.sid), ms: 0, requestId: String(f.requestId ?? ''), cmdId: null,
  }
  void outsideAtomic(() => writeAudit(row)).catch((e: unknown) => security.error('audit write failed', { event, error: String(e) }))
}
