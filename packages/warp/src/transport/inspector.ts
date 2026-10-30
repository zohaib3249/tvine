// Dev-only traffic feed for `tvine inspect` (inspect/inspector.md): every command and every agent page
// read becomes one redacted row on the channel layer's `inspector` group, streamed by
// /tvine/channel?group=inspector (loopback + dev only, transport/channel.ts).
import type { ServerCtx } from '../core/dispatch.js'
import { ev } from '../core/events.js'
import type { HookEvents } from '../core/middleware.js'
import type { Event } from '../core/types.js'
import { sidHash } from './http.js'

export interface InspectorRow {
  kind: 'command' | 'read'
  t: number; action: string; params: unknown; status: string
  sid: string                      // short hash, as in the http log line; the raw sid is a bearer credential
  rev?: number; ms: number; via?: 'http' | 'mcp'; message?: string; field?: string
}

const SECRET_KEY = /^(sid|bind|cmdid|auth)$|pass|secret|token|key|cookie|authorization|credential/i
const BIND = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.\d{13}/g   // security/sign: b64url(json).b64url(hmac-sha256).expiry
const MAX_STR = 200

// Secret-named keys → '[redacted]'; bind tokens → '[bind]'; the raw sid → its hash; long strings cut.
function redact(v: unknown, sid: string | undefined, depth = 0): unknown {
  if (typeof v === 'string') {
    let s = v.replace(BIND, '[bind]')
    if (sid) s = s.split(sid).join(`#${sidHash(sid)}`)
    return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s
  }
  if (!v || typeof v !== 'object') return v
  if (depth >= 6) return '…'
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, sid, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(x, sid, depth + 1)]))
}

// cmd.sid / cmd.bind / cmd.cmdId are never copied; params and the err message are redacted.
export function commandRow(e: HookEvents['command']): InspectorRow {
  const sid = e.sid ?? e.cmd.sid
  const revOf = (x: Event) => (x.kind === 'snapshot' ? x.snapshot.rev : x.kind === 'update' ? x.rev : undefined)
  const rev = e.events.map(revOf).find((r) => r !== undefined)
  const err = e.events.find((x): x is Extract<Event, { kind: 'err' }> => x.kind === 'err')
  return {
    kind: 'command', t: Date.now(), action: String(redact(e.action, sid)), params: redact(e.cmd.params, sid), status: e.status,
    sid: sidHash(sid ?? ''), ms: e.ms,
    ...(rev !== undefined && { rev }),
    ...(err && { message: String(redact(err.message, sid)), ...(err.field !== undefined && { field: err.field }) }),
  }
}

export function readRow(e: HookEvents['read']): InspectorRow {
  return { kind: 'read', t: Date.now(), action: 'read_page', params: { page: redact(e.page, e.sid) }, status: 'ok', sid: sidHash(e.sid), rev: e.rev, ms: e.ms, via: e.via }
}

// Called by createAgentServer when NODE_ENV !== 'production'. Rows are built only while someone is watching.
export function inspectorFeed(ctx: ServerCtx): () => void {
  const group = ctx.channels.group('inspector')
  const send = (row: () => InspectorRow) => { if (group.size()) group.send(ev.ok('inspector.row', row())) }
  const offs = [ctx.hooks.on('command', (e) => send(() => commandRow(e))), ctx.hooks.on('read', (e) => send(() => readRow(e)))]
  return () => { for (const off of offs) off() }
}
