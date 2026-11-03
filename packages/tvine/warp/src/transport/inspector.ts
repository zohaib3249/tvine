// Dev-only traffic feed for `tvine inspect` (inspect/inspector.md): every command and every agent page
// read becomes one redacted row on the channel layer's `inspector` group, streamed by
// /tvine/channel?group=inspector (loopback + dev only, transport/channel.ts).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerCtx } from '../core/dispatch.js'
import { ev } from '../core/events.js'
import type { HookEvents } from '../core/middleware.js'
import type { Event } from '../core/types.js'
import { localOnly } from './channel.js'
import { sidHash } from './http.js'
import { secretName } from '../core/redact.js'
export { secretName }

export interface InspectorRow {
  kind: 'command' | 'read'
  t: number; action: string; params: unknown; status: string
  sid: string                      // short hash, as in the http log line; the raw sid is a bearer credential
  rev?: number; ms: number; via?: 'http' | 'mcp'; message?: string; field?: string
}

const BIND = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.\d{13}/g   // security/sign: b64url(json).b64url(hmac-sha256).expiry
const JWT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const MAX_STR = 200

// Secret-named keys → '[redacted]'; bind tokens, JWTs, Bearer values → placeholders; the raw sid → its hash; long strings cut.
function redact(v: unknown, sid: string | undefined, depth = 0, max = 6): unknown {
  if (typeof v === 'string') {
    let s = v.replace(BIND, '[bind]').replace(JWT, '[jwt]').replace(BEARER, '$1 [redacted]')
    if (sid) s = s.split(sid).join(`#${sidHash(sid)}`)
    return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s
  }
  if (!v || typeof v !== 'object') return v
  if (depth >= max) return '…'
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, sid, depth + 1, max))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secretName(k) ? '[redacted]' : redact(x, sid, depth + 1, max)]))
}

// /reset?token=abc&q=x → /reset?token=redacted&q=x (then the string pass)
function redactPage(page: string, sid: string | undefined): string {
  const i = page.indexOf('?')
  if (i < 0) return String(redact(page, sid))
  const q = new URLSearchParams(page.slice(i + 1))
  for (const k of new Set(q.keys())) if (secretName(k)) q.set(k, 'redacted')
  return String(redact(`${page.slice(0, i)}?${q}`, sid))
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
  return { kind: 'read', t: Date.now(), action: 'read_page', params: { page: redactPage(e.page, e.sid) }, status: 'ok', sid: sidHash(e.sid), rev: e.rev, ms: e.ms, via: e.via }
}

// Called by createAgentServer when NODE_ENV !== 'production'. The hooks are subscribed only while at least
// one inspector stream is open (watch() per stream, refcounted), so dev pays no hook clone cost otherwise.
export interface InspectorFeed { watch(): () => void; close(): void; push(row: object): boolean }
export function inspectorFeed(ctx: ServerCtx): InspectorFeed {
  const group = ctx.channels.group('inspector')
  const send = (row: InspectorRow) => group.send(ev.ok('inspector.row', row))
  let n = 0
  let offs: (() => void)[] = []
  const stop = () => { for (const off of offs) off(); offs = [] }
  return {
    watch() {
      if (n++ === 0) offs = [ctx.hooks.on('command', (e) => send(commandRow(e))), ctx.hooks.on('read', (e) => send(readRow(e)))]
      let done = false
      return () => { if (!done && (done = true) && --n === 0) stop() }
    },
    close() { n = 0; stop() },
    // a dev tab's row (widgetsTransport): only while an inspector listens
    push(row) { if (!n) return false; group.send(ev.ok('inspector.row', row)); return true },
  }
}

// ---- W10: the inspector's Widgets tab ------------------------------------------------------------------------
// POST /tvine/dev/widgets from a dev tab framed in the inspector's page pane (weft dev/Gallery.tsx): its widget
// tree (kind 'widgets') and the agent commands its executor ran (kind 'agent'). Mounted only in dev. Loopback only
// (localOnly), same origin (Origin present and = Host), and `x-tvine-dev` (a cross-site page can't send it without
// a CORS preflight we never answer). Rows are redacted again here; the tab already masks sensitive state and args.
// Read-only: nothing here runs anything in a tab (the gallery's "try it" runs in the tab itself).
export const DEV_WIDGETS_PATH = '/tvine/dev/widgets'
const DEV_BODY = 512 * 1024
const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/

export function devRow(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const { kind, tab, page } = body
  if ((kind !== 'widgets' && kind !== 'agent') || typeof tab !== 'string' || !TAB_ID.test(tab) || typeof page !== 'string') return undefined
  const base = { kind, t: Date.now(), tab: tab.slice(0, 12), page: redactPage(page.slice(0, 2000), undefined) }
  if (kind === 'widgets') return Array.isArray(body.tree) ? { ...base, tree: redact(body.tree, undefined, 0, 64) } : undefined
  const { via, source, steps, ok, code, message, ms } = body
  return {
    ...base, via: String(via).slice(0, 16), ...(source !== undefined && { source: String(source).slice(0, 16) }),
    steps: redact(Array.isArray(steps) ? steps.slice(0, 20) : [], undefined), ok: ok === true,
    ...(code !== undefined && { code: String(code).slice(0, 32) }), ...(message !== undefined && { message: String(redact(String(message), undefined)) }),
    ms: Number(ms) || 0,
  }
}

export function widgetsTransport(feed: InspectorFeed): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const out = (res: ServerResponse, status: number, body?: unknown) =>
    void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body === undefined ? undefined : JSON.stringify(body))
  const sameOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin
    try { return !!o && new URL(o).host === req.headers.host } catch { return false }
  }
  return (req, res, next) => {
    if ((req.url ?? '/').split('?')[0] !== DEV_WIDGETS_PATH) return next()
    if (req.method !== 'POST') return out(res, 405, { error: 'POST only' })
    if (!localOnly(req) || !sameOrigin(req) || req.headers['x-tvine-dev'] !== '1') return out(res, 403, { error: 'forbidden' })
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return out(res, 415, { error: 'application/json only' })
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => { if ((n += c.length) <= DEV_BODY) chunks.push(c) })
    req.on('end', () => {
      if (n > DEV_BODY) return out(res, 413, { error: 'too large' })
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return out(res, 400, { error: 'bad json' }) }
      const row = body && typeof body === 'object' && !Array.isArray(body) ? devRow(body as Record<string, unknown>) : undefined
      if (!row) return out(res, 400, { error: 'bad row' })
      out(res, 200, { listening: feed.push(row) })
    })
  }
}

// ---- tvine dev: open tabs reload after a server restart ------------------------------------------------------
// GET /tvine/dev/reload (only under `tvine dev`): an event stream that sends this process's boot id, then idles.
// The autoreload supervisor restarts the server; the tab's EventSource reconnects (retry 300 ms), gets a new id
// and reloads (weft runtime/devReload.ts). Read-only, carries nothing but the id. `open`: ended on server close.
export const DEV_RELOAD_PATH = '/tvine/dev/reload'

export function devReloadTransport(boot: string, open: Set<ServerResponse>): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    if (req.method !== 'GET' || (req.url ?? '/').split('?')[0] !== DEV_RELOAD_PATH) return next()
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write(`retry: 300\nevent: boot\ndata: ${boot}\n\n`)
    const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
    open.add(res)
    res.on('close', () => { clearInterval(beat); open.delete(res) })
  }
}
