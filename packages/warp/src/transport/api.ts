// transport/api — the frontend's only data path (docs/design/frontend/v2/core/api-client.md): POST /tvine/api/<id>
// for client components and a Next server in two-server mode, plus `invoke`, which the in-process caller behind
// @tvine/weft/api uses. Every call is one dispatch(): permissions, bind, limits, atomic, hooks, idempotency.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { collect, crossOrigin, dispatch, rateLimited, type ServerCtx } from '../core/dispatch.js'
import { rotatedSession } from '../core/auth.js'
import { buildRequest, clientIp } from '../core/request.js'
import type { ErrCode, Event, Request, Session, Settings } from '../core/types.js'
import { FORBIDDEN_ROUTE, guardCheck } from './guards.js'

export const API_PREFIX = '/tvine/api/'
export const FORWARD = 'x-tvine-forward'        // `<b64url(json)>.<b64url(hmac)>`, from a Next server holding the secret
export const MINTED = 'x-tvine-cookie'          // forwarded mutation that created a session: the cookie for Next to set
const FORWARD_TTL_MS = 30_000

export type ApiResult =
  | { ok: true; data: unknown; goto?: string }
  | { ok: false; code: ErrCode; reason?: string; field?: string; message: string; retryAfterMs?: number }

// Identity a Next server forwards. `as` = the raw x-tvine-session value of an agent's snapshot render.
export interface Forward { cookie?: string; as?: string; ip: string; agent: boolean; path: string; mode: 'render' | 'action'; exp: number }

// Domain-separated from binds: a bind token can never pass as a forward header (and the reverse).
const fmac = (body: string, key: string) => createHmac('sha256', key).update(`tvine-forward.${body}`).digest()

export function signForward(p: Omit<Forward, 'exp'>, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: now + FORWARD_TTL_MS })).toString('base64url')
  return `${body}.${fmac(body, secret).toString('base64url')}`
}

// Any key (rotation), unexpired, well-formed; never throws.
export function verifyForward(v: unknown, settings: Settings): Forward | undefined {
  try {
    if (typeof v !== 'string') return undefined
    const [body, sig, extra] = v.split('.')
    if (!body || !sig || extra !== undefined) return undefined
    const got = Buffer.from(sig, 'base64url')
    const ok = [settings.secret].flat().some((k) => { const want = fmac(body, k); return got.length === want.length && timingSafeEqual(got, want) })
    if (!ok) return undefined
    const f = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Forward
    if (typeof f !== 'object' || f === null || typeof f.exp !== 'number' || Date.now() > f.exp) return undefined
    if (typeof f.path !== 'string' || !f.path.startsWith('/') || typeof f.ip !== 'string' || (f.mode !== 'render' && f.mode !== 'action')) return undefined
    if ((f.cookie !== undefined && typeof f.cookie !== 'string') || (f.as !== undefined && typeof f.as !== 'string')) return undefined
    return f
  } catch { return undefined }
}

// The events of one dispatch → ApiResult. JSON round-trip: in-process and HTTP give byte-equal data.
export function toApiResult(events: Event[]): ApiResult {
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (err) {
    return {
      ok: false, code: err.code, message: err.message,
      ...(err.reason !== undefined && { reason: err.reason }), ...(err.field !== undefined && { field: err.field }),
      ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
    }
  }
  const ok = events.find((e): e is Extract<Event, { kind: 'ok' }> => e.kind === 'ok')
  const goto = events.find((e): e is Extract<Event, { kind: 'goto' }> => e.kind === 'goto')
  if (!ok && !goto) return { ok: false, code: 'internal', message: 'no result' }
  const data = ok?.result === undefined ? null : JSON.parse(JSON.stringify(ok.result)) as unknown
  return { ok: true, data, ...(goto && { goto: goto.url }) }
}

const fail = (code: ErrCode, message: string, reason?: string): ApiResult => ({ ok: false, code, message, ...(reason && { reason }) })
const FORBIDDEN = fail('domain', FORBIDDEN_ROUTE, 'forbidden')

export interface ApiCall { id: string; params?: unknown; bind?: string; cmdId?: string }
export interface Caller {
  request: Request                         // path = the calling page (route guards run on it)
  sid?: string                             // an agent's render session (x-tvine-session)
  cookie?: string
  mode: 'render' | 'action'                // render = a server component render: read actions only
  mint?: (s: Session) => void              // action mode: hand a newly created session's cookie to the caller
}

// One api call. A read with no session runs on a throwaway session; a mutation creates one (after the
// origin + ip checks, as the <Form> path does) and `mint` hands it out.
export async function invoke(server: ServerCtx, call: ApiCall, who: Caller): Promise<ApiResult> {
  const { settings, sessions } = server
  const def = server.actions.get(call.id)
  if (!def) return fail('unknown_action', `unknown action ${String(call.id).slice(0, 100)}`)
  const read = !!def.rules?.readOnly
  if (who.mode === 'render' && !read) {
    return fail('domain', `${def.id} changes data: call it from a form, server action or client event, never while rendering`, 'render_mutation')
  }
  if (call.params !== undefined && (typeof call.params !== 'object' || call.params === null || Array.isArray(call.params))) {
    return { ok: false, code: 'invalid_param', message: 'params must be an object', field: 'params' }
  }
  let session = sessions.peek({ sid: who.sid, cookie: who.cookie })
  if (!(await guardCheck(settings)(who.request.path, who.request, session))) return FORBIDDEN
  let ephemeral = false
  if (session && who.sid !== undefined) {
    // An agent's snapshot render runs INSIDE that agent's command (dispatch step 10), which holds the sid's
    // queue: dispatching on the same sid would wait for itself. Reads run on an ephemeral copy instead.
    session = sessions.ephemeral(copyData(session.data))
    ephemeral = true
  } else if (!session) {
    if (who.sid !== undefined) return fail('expired_sid', 'session expired')   // an agent render whose session is gone
    if (crossOrigin(who.request, settings)) return FORBIDDEN
    const rl = server.limiter.check({ ip: who.request.ip })
    if (!rl.ok) return toApiResult([rateLimited(rl.retryAfterMs)])
    if (read) { session = sessions.ephemeral(); ephemeral = true }   // a read never creates a real session
    else if (!who.mint) return fail('expired_sid', 'this action needs a session')
    else { session = sessions.create(); who.mint(session) }
  }
  const cmd = {
    action: def.id, params: (call.params ?? {}) as Record<string, unknown>, sid: session.sid,
    ...(call.bind !== undefined && { bind: call.bind }),
    ...(call.cmdId !== undefined && !ephemeral && { cmdId: call.cmdId }),   // nothing to replay on a one-call session
  }
  try {
    const r = toApiResult(await collect(dispatch(cmd, server, who.request, { snapshot: false })))
    const rotated = rotatedSession(who.request)   // login/logout rotated the session: its cookie goes out through mint
    if (rotated) who.mint?.(rotated)
    return r
  } finally {
    if (ephemeral) sessions.dropEphemeral(session.sid)
  }
}

// The agent's data for a read-only copy: a deep clone, or (a value structuredClone refuses) a shallow one.
function copyData(d: Map<string, unknown>): Map<string, unknown> {
  try { return structuredClone(d) } catch { return new Map(d) }
}

// ---- POST /tvine/api/<id> -------------------------------------------------------------------
export interface ApiTransportOptions {
  route: (path: string) => string | undefined
  asSession: (v: string | undefined) => { token: string; sid: string } | undefined   // validates x-tvine-session
  tokens: { read(t: string): void }                                                 // C2: renders that read a session
}

const STATUS: Partial<Record<ErrCode, number>> = { expired_sid: 401, rate_limited: 429, internal: 500, unknown_action: 404 }
const DOMAIN_STATUS: Record<string, number> = { forbidden: 403, not_found: 404 }
const statusOf = (r: ApiResult) => r.ok ? 200 : r.code === 'domain' ? DOMAIN_STATUS[r.reason ?? ''] ?? 400 : STATUS[r.code] ?? 400

export function apiTransport(server: ServerCtx, o: ApiTransportOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings, sessions } = server
  const name = settings.session.cookieName
  const send = (res: ServerResponse, r: ApiResult, status = statusOf(r)) => {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' })
    res.end(JSON.stringify(r))
  }
  const cookieOf = (req: IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
    }
    return undefined
  }
  const secure = (req: IncomingMessage) => (req.socket as { encrypted?: boolean }).encrypted === true ||
    (settings.trustProxy > 0 && String(req.headers['x-forwarded-proto'] ?? '').split(',').map((s) => s.trim()).at(-settings.trustProxy) === 'https')

  async function handle(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, fail('invalid_param', 'POST only'), 405) }
    let id: string
    try { id = decodeURIComponent(path.slice(API_PREFIX.length)) } catch { return send(res, fail('unknown_action', 'bad action id')) }
    const fwd = req.headers[FORWARD]
    let who: Caller
    if (fwd !== undefined) {
      // a Next server (two-server mode): only its signed, unexpired identity counts; its own cookies/ip do not
      const f = verifyForward(fwd, settings)
      const own = f?.as === undefined ? undefined : o.asSession(f.as)
      if (!f || (f.as !== undefined && !own)) return send(res, FORBIDDEN)
      if (own) o.tokens.read(own.token)
      const page = new URL(f.path, 'http://tvine.local').pathname
      const request = await buildRequest({ url: f.path, route: o.route(page) ?? page, headers: {}, ip: f.ip || 'unknown', via: 'human' }, settings)
      if (own || f.agent) request.agent = { is: true, via: 'http' }
      who = { request, sid: own?.sid, cookie: f.cookie, mode: own ? 'render' : f.mode, mint: (s) => res.setHeader(MINTED, sessions.cookieFor(s.sid)) }
    } else {
      // a browser (client component): custom header forces a CORS preflight cross-site; origin checked by dispatch
      if (req.headers['x-tvine-api'] !== '1') return send(res, FORBIDDEN)
      let page = '/'
      try { if (req.headers.referer) page = new URL(req.headers.referer).pathname } catch { /* stays '/' */ }
      const shown = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('x-tvine-')).map(([k, v]) => [k, String(v)]))
      const ip = clientIp((req.headers['x-forwarded-for'] as string | undefined) ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
      const request = await buildRequest({ url: page, route: o.route(page) ?? page, headers: shown, ip, via: 'human' }, settings)
      request.raw = req   // the endpoint (/tvine/api/<id>) + method for settings.cors (core/cors-match)
      who = {
        request, cookie: cookieOf(req), mode: 'action',
        mint: (s) => res.setHeader('set-cookie', `${name}=${sessions.cookieFor(s.sid)}; Path=/; Max-Age=${Math.floor(settings.session.ttlMs / 1000)}; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`),
      }
    }
    const ct = String(req.headers['content-type'] ?? '')
    if (!/^application\/json\s*(;|$)/i.test(ct)) return send(res, fail('invalid_param', 'Content-Type must be application/json'))
    const raw = await readBody(req, settings.limits.bodyBytes)
    if (raw === null) { res.setHeader('connection', 'close'); return send(res, fail('invalid_param', `request body exceeds ${settings.limits.bodyBytes} bytes`), 413) }
    let body: unknown
    try { body = raw.length ? JSON.parse(raw) : {} } catch { return send(res, fail('invalid_param', 'body is not valid JSON')) }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || tooDeep(body)) return send(res, fail('invalid_param', 'body must be a JSON object {params, bind?, cmdId?}'))
    const { params, bind, cmdId } = body as Record<string, unknown>
    if ((bind !== undefined && typeof bind !== 'string') || (cmdId !== undefined && typeof cmdId !== 'string')) return send(res, fail('invalid_param', 'bind and cmdId must be strings'))
    send(res, await invoke(server, { id, params, bind, cmdId }, who))
  }

  return (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (!path.startsWith(API_PREFIX)) return next()
    void handle(req, res, path).catch((e: unknown) => {
      server.log('error', 'api transport failed', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
      if (!res.headersSent) send(res, fail('internal', 'internal error'))
      else res.destroy()
    })
  }
}

// ponytail: same as transport/http.ts readBody/tooDeep (owned by another task); share when that file is free
function readBody(req: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    const onData = (c: Buffer) => {
      n += c.length
      if (n <= cap) return void chunks.push(c)
      req.off('data', onData)
      req.resume()
      resolve(null)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.once('error', reject)
  })
}
function tooDeep(v: unknown, max = 64): boolean {
  const stack: [unknown, number][] = [[v, 0]]
  while (stack.length) {
    const [x, d] = stack.pop()!
    if (typeof x !== 'object' || x === null) continue
    if (d >= max) return true
    for (const y of Object.values(x)) stack.push([y, d + 1])
  }
  return false
}
