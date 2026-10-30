// In-process half of the inspector: turns warp's `command` hook into redacted rows on the channel
// layer's `inspector` group, which /tvine/channel?group=inspector streams. Dev only.
import { createHash } from 'node:crypto'

// Structural slices of warp's public API (server.ctx.hooks / server.ctx.channels): no runtime dependency on warp.
type Ev = { kind: string; [k: string]: unknown }
export interface CommandHookEvent {
  cmd: { action: string; params: Record<string, unknown>; sid?: string; bind?: string; cmdId?: string }
  action: string; status: string; sid: string | undefined; events: readonly Ev[]; ms: number
}
export interface InspectableServer {
  ctx: {
    hooks: { on(name: 'command', fn: (e: CommandHookEvent) => unknown): () => void }
    channels: { group(name: string): { send(e: never): void } }
  }
}
export interface Row {
  t: number; action: string; params: unknown; status: string; sid: string; rev?: number; ms: number; message?: string; field?: string
}

export const refuseInProduction = (what: string) => {
  if (process.env.NODE_ENV === 'production') throw new Error(`${what} is a dev tool and refuses to run with NODE_ENV=production`)
}

// Same short hash warp's http log line uses, so rows correlate with server logs; the raw sid is a bearer credential.
export const sidHash = (sid: string | undefined) => (sid ? createHash('sha256').update(sid).digest('base64url').slice(0, 12) : '')

const SECRET_KEY = /^(sid|bind|cmdid|auth)$|pass|secret|token|key|cookie|authorization|credential/i
const BIND = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.\d{13}/g   // security/sign: b64url(json).b64url(hmac-sha256).expiry
const MAX_STR = 200

// Secret-named keys → '[redacted]'; bind tokens → '[bind]'; the raw sid → its hash; long strings cut.
export function redact(v: unknown, sid?: string, depth = 0): unknown {
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

export function toRow(e: CommandHookEvent): Row {
  const sid = e.sid ?? e.cmd.sid
  const snap = e.events.map((x) => (x.kind === 'snapshot' ? x.snapshot : x.kind === 'update' ? x : undefined)).find(Boolean) as { rev?: number } | undefined
  const err = e.events.find((x) => x.kind === 'err')
  const row: Row = { t: Date.now(), action: String(redact(e.action)), params: redact(e.cmd.params, sid), status: e.status, sid: sidHash(sid), ms: e.ms }
  if (typeof snap?.rev === 'number') row.rev = snap.rev
  if (err) {
    row.message = String(redact(err.message, sid))
    if (typeof err.field === 'string') row.field = err.field
  }
  return row
}

// Wire: one `ok` event per command, action 'inspector.command', the row as its result (the Event union has no
// free-form kind). Returns the unsubscribe.
export function attachInspector(server: InspectableServer): () => void {
  refuseInProduction('attachInspector')
  const group = server.ctx.channels.group('inspector')
  return server.ctx.hooks.on('command', (e) => {
    group.send({ kind: 'ok', action: 'inspector.command', result: toRow(e) } as never)
  })
}
