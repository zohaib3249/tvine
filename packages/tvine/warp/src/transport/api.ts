// transport/api — the frontend's only data path (docs/design/frontend/v2/core/api-client.md): POST /tvine/api/<id>
// for client components and a Next server in two-server mode, plus `invoke`, which the in-process caller behind
// tvine/api uses. Every call is one dispatch(): permissions, bind, limits, atomic, hooks, idempotency.
import { parseMultipart, PARTS, type FilePart } from '../media/index.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { collect, crossOrigin, dispatch, rateLimited, type ServerCtx } from '../core/dispatch.js'
import { authenticate } from '../core/auth.js'
import { permissionCtx, runPermissions } from '../security/permissions.js'
import { rotatedSession } from '../core/auth.js'
import { buildRequest, clientIp, rateChecked } from '../core/request.js'
import { cookieHeader } from '../core/session.js'
import type { ConfirmAsk, ErrCode, Event, FieldError, Request, Session, Settings } from '../core/types.js'
import { cookieValue } from '../security/cookie.js'
import { signForwardPayload, unsignForwardBody } from '../security/forward-mac.js'
import { multipartBoundary, readBodyUtf8, readJsonObject, tooDeep } from './body.js'
import { FORBIDDEN_ROUTE, guardCheck } from './guards.js'
import { isAgent } from './http.js'
import { httpStatusOf } from './http-status.js'

export const API_PREFIX = '/tvine/api/'
export const FORWARD = 'x-tvine-forward'        // `<b64url(json)>.<b64url(hmac)>`, from a Next server holding the secret
export const MINTED = 'x-tvine-cookie'          // forwarded mutation that created a session: the cookie for Next to set

export type ApiResult =
  | { ok: true; data: unknown; goto?: string }
  | { ok: false; code: ErrCode; reason?: string; field?: string; errors?: FieldError[]; message: string; retryAfterMs?: number; confirm?: ConfirmAsk }

// Identity a Next server forwards. `as` = the raw x-tvine-session value of an agent's snapshot render.
export interface Forward { cookie?: string; as?: string; ip: string; agent: boolean; path: string; mode: 'render' | 'action'; exp: number }

export function signForward(p: Omit<Forward, 'exp'>, secret: string, now = Date.now()): string {
  return signForwardPayload(p as Record<string, unknown>, secret, now)
}

// Any key (rotation), unexpired, well-formed; never throws.
export function verifyForward(v: unknown, settings: Settings): Forward | undefined {
  try {
    if (typeof v !== 'string') return undefined
    const body = unsignForwardBody(v, [settings.secret].flat())
    if (body === undefined) return undefined
    const f = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Forward
    if (typeof f !== 'object' || f === null || typeof f.exp !== 'number' || Date.now() > f.exp) return undefined
    if (typeof f.path !== 'string' || !f.path.startsWith('/') || typeof f.ip !== 'string' || (f.mode !== 'render' && f.mode !== 'action')) return undefined
    if ((f.cookie !== undefined && typeof f.cookie !== 'string') || (f.as !== undefined && typeof f.as !== 'string')) return undefined
    return f
  } catch {
    return undefined
  }
}

// The events of one dispatch → ApiResult. JSON round-trip: in-process and HTTP give byte-equal data.
// http: the result is only sent (sendApi), so its data is serialized once and not parsed back.
export function toApiResult(events: Event[], http = false): ApiResult {
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (err) {
    return {
      ok: false, code: err.code, message: err.message,
      ...(err.reason !== undefined && { reason: err.reason }), ...(err.field !== undefined && { field: err.field }), ...(err.errors?.length && { errors: err.errors }),
      ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }), ...(err.confirm && { confirm: err.confirm }),
    }
  }
  const ok = events.find((e): e is Extract<Event, { kind: 'ok' }> => e.kind === 'ok')
  const goto = events.find((e): e is Extract<Event, { kind: 'goto' }> => e.kind === 'goto')
  if (!ok && !goto) return { ok: false, code: 'internal', message: 'no result' }
  if (ok?.result === undefined) return { ok: true, data: null, ...(goto && { goto: goto.url }) }
  const json = JSON.stringify(ok.result)
  if (!http || json === undefined) return { ok: true, data: JSON.parse(json) as unknown, ...(goto && { goto: goto.url }) }
  // HTTP: the JSON goes out as it is (sendApi); no parse + re-stringify of the same data
  const r: ApiResult = { ok: true, data: ok.result, ...(goto && { goto: goto.url }) }
  DATA_JSON.set(r, json)
  return r
}
// an ok result's data as JSON, serialized once by toApiResult
const DATA_JSON = new WeakMap<ApiResult, string>()

const fail = (code: ErrCode, message: string, reason?: string): ApiResult => ({ ok: false, code, message, ...(reason && { reason }) })
const FORBIDDEN = fail('domain', FORBIDDEN_ROUTE, 'forbidden')

export interface ApiCall { id: string; params?: unknown; bind?: string; cmdId?: string; agentCmd?: { via?: string } }
export interface Caller {
  request: Request                         // path = the calling page (route guards run on it)
  sid?: string                             // an agent's render session (x-tvine-session)
  cookie?: string
  mode: 'render' | 'action'                // render = a server component render: read actions only
  mint?: (s: Session) => Promise<void> | void              // action mode: hand a newly created session's cookie to the caller
  http?: boolean                           // the result is sent as JSON by sendApi (callerOf)
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
  // a cookie: resolved once here and handed to dispatch (an agent render's sid is only peeked: its command holds it)
  let session = who.sid !== undefined ? await sessions.peek({ sid: who.sid }) : await sessions.resolve({ cookie: who.cookie })
  if (!(await guardCheck(settings)(who.request.path, who.request, session))) return FORBIDDEN
  let ephemeral = false, deferred = false
  if (session && who.sid !== undefined) {
    // An agent's snapshot render runs INSIDE that agent's command (dispatch step 10), which holds the sid's
    // queue: dispatching on the same sid would wait for itself. Reads run on an ephemeral copy instead.
    session = sessions.ephemeral(copyData(session.data))
    ephemeral = true
  } else if (!session) {
    if (who.sid !== undefined) return fail('expired_sid', 'session expired')   // an agent render whose session is gone
    if (crossOrigin(who.request, settings)) return FORBIDDEN
    // Anti-session-spam: ephemeral/deferred mint — a real session (and cookie) only if keep() runs below.
    // Rate: cookie-less calls pay the general ip bucket in dispatch; cmdId mint charges here + rateChecked
    // so dispatch does not double-bill. Page-render reads use opts.render (no general charge).
    if (read) { session = sessions.ephemeral(); ephemeral = true }   // a read never creates a real session
    else if (!who.mint) return fail('expired_sid', 'this action needs a session')
    // a retry token (cmdId) is replayed per stored session: such a call keeps its session up front, as before
    else if (call.cmdId !== undefined) {
      const rl = await server.limiter.check({ ip: who.request.ip })
      if (!rl.ok) return toApiResult([rateLimited(rl.retryAfterMs)])
      rateChecked.add(who.request)   // charged here so dispatch does not double-bill after mint
      session = await sessions.create(); await who.mint(session)
    }
    // lazy: stored (and its cookie minted) only if the call needs it, see after the dispatch
    else { session = sessions.deferred(); deferred = true }
  }
  const cmd = {
    action: def.id, params: (call.params ?? {}) as Record<string, unknown>, sid: session.sid,
    ...(call.bind !== undefined && { bind: call.bind }),
    ...(call.agentCmd && { agentCmd: call.agentCmd }),
    ...(call.cmdId !== undefined && !ephemeral && { cmdId: call.cmdId }),   // nothing to replay on a one-call session
  }
  try {
    const r = toApiResult(await collect(dispatch(cmd, server, who.request, { snapshot: false, render: who.mode === 'render', session })), who.http)
    const rotated = rotatedSession(who.request)   // login/logout rotated the session: its cookie goes out through mint
    if (rotated) await who.mint?.(rotated)
    // a cookie-less call keeps a session only when it wrote session data or its answer is bound to the sid (a
    // confirm token); anything else (a plain insert from an API client) leaves no session and sets no cookie
    else if (deferred && (session.data.size > 0 || (!r.ok && r.code === 'confirm_required'))) await who.mint!(await sessions.keep(session))
    return r
  } finally {
    if (ephemeral || deferred) sessions.dropEphemeral(session.sid)
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

const statusOf = (r: ApiResult) => r.ok ? 200 : httpStatusOf(r.code, r.reason)

// The caller of one HTTP api call (this transport and transport/urls): a Next server's signed forward, or a
// browser / HTTP client that sent x-tvine-api: 1 (forces a CORS preflight cross-site). undefined = 403.
export async function callerOf(server: ServerCtx, o: ApiTransportOptions, req: IncomingMessage, res: ServerResponse): Promise<Caller | undefined> {
  const { settings, sessions } = server
  const name = settings.session.cookieName
  const fwd = req.headers[FORWARD]
  if (fwd !== undefined) {
    // a Next server (two-server mode): only its signed, unexpired identity counts; its own cookies/ip do not
    const f = verifyForward(fwd, settings)
    const own = f?.as === undefined ? undefined : o.asSession(f.as)
    if (!f || (f.as !== undefined && !own)) return undefined
    if (own) o.tokens.read(own.token)
    const page = new URL(f.path, 'http://tvine.local').pathname
    const request = await buildRequest({ url: f.path, route: o.route(page) ?? page, headers: {}, ip: f.ip || 'unknown', via: 'human' }, settings)
    if (own || f.agent) request.agent = { is: true, via: 'http' }
    return { request, http: true, sid: own?.sid, cookie: f.cookie, mode: own ? 'render' : f.mode, mint: async (s) => { res.setHeader(MINTED, await sessions.cookieFor(s.sid)) } }
  }
  // a browser (client component): custom header forces a CORS preflight cross-site; origin checked by dispatch
  if (req.headers['x-tvine-api'] !== '1') return undefined
  let page = '/'
  try { if (req.headers.referer) page = new URL(req.headers.referer).pathname } catch { /* stays '/' */ }
  const shown = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('x-tvine-')).map(([k, v]) => [k, String(v)]))
  const ip = clientIp((req.headers['x-forwarded-for'] as string | undefined) ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
  const request = await buildRequest({ url: page, route: o.route(page) ?? page, headers: shown, ip, via: 'human' }, settings)
  // secreview H1: the agent markers are read from the RAW headers (`shown` drops x-tvine-*): a declared agent stays one
  if (isAgent(req, settings)) request.agent = { ...request.agent, is: true, via: 'http' }
  request.raw = req   // the endpoint (/tvine/api/<id>, or a urls.ts path) + method for settings.cors (core/cors-match)
  const cookie = cookieValue(req.headers.cookie, name)
  return {
    request, cookie, mode: 'action', http: true,
    mint: async (s) => { res.setHeader('set-cookie', cookieHeader(settings, await sessions.cookieFor(s.sid))) },
  }
}

export const sendApi = (res: ServerResponse, r: ApiResult, status = statusOf(r), headers: Record<string, string> = {}) => {
  if (res.headersSent) return
  const json = DATA_JSON.get(r)
  const body = json === undefined || !r.ok ? JSON.stringify(r) : `{"ok":true,"data":${json}${r.goto === undefined ? '' : `,"goto":${JSON.stringify(r.goto)}`}}`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers })
  res.end(body)
}
export const apiFail = fail
export const API_FORBIDDEN = FORBIDDEN

export function apiTransport(server: ServerCtx, o: ApiTransportOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings } = server
  const send = sendApi

  async function handle(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, fail('invalid_param', 'POST only'), 405) }
    let id: string
    try { id = decodeURIComponent(path.slice(API_PREFIX.length)) } catch { return send(res, fail('unknown_action', 'bad action id')) }
    const who = await callerOf(server, o, req, res)
    if (!who) return send(res, FORBIDDEN)
    const ct = String(req.headers['content-type'] ?? '')
    const boundary = multipartBoundary(ct)
    const mpDef = boundary ? server.actions.get(id) : undefined
    if (boundary) {
      // only actions that declare `multipart` take files here; the body is buffered under bodyBytes + their cap
      if (!mpDef?.multipart) return send(res, fail('invalid_param', 'this action does not take multipart bodies'))
      // nothing is buffered for a caller that cannot run it: uploads need a signed-in user, same-origin, a rate token
      const sess = await server.sessions.peek({ sid: who.sid, cookie: who.cookie })
      await authenticate(settings, who.request, sess)
      if (!who.request.user?.isAuthenticated) { res.setHeader('connection', 'close'); return send(res, fail('domain', 'forbidden: uploads need a signed-in user', 'forbidden')) }
      // the action's static permissions (admin: isStaff) before a byte is buffered; dispatch runs them again
      try { await runPermissions(mpDef.rules?.permissions ?? [], permissionCtx({ sid: sess?.sid ?? '', session: sess as Session, request: who.request }, mpDef.id)) }
      catch { res.setHeader('connection', 'close'); return send(res, FORBIDDEN) }
      if (crossOrigin(who.request, settings)) return send(res, FORBIDDEN)
      const rl = await server.limiter.check({ ip: who.request.ip })
      if (!rl.ok) { res.setHeader('connection', 'close'); return send(res, toApiResult([rateLimited(rl.retryAfterMs)])) }
      const buf = await readMultipart(req, settings.limits.bodyBytes + mpDef.multipart.maxBytes, mpDef.multipart.partBytes ?? mpDef.multipart.maxBytes, boundary)
      if (buf === null) {   // stop reading: the rest of an oversized upload is never received
        res.setHeader('connection', 'close'); res.once('finish', () => req.destroy())
        return send(res, fail('invalid_param', 'request body or a file part too large'), 413)
      }
      const parsed = parseMultipart(buf, boundary)
      const okField = (k: string) => k === 'params' || k === 'bind' || k === 'cmdId' || k === 'agentCmd'
      if (!parsed || Object.keys(parsed.fields).some((k) => !okField(k))) return send(res, fail('invalid_param', 'multipart: a `params` JSON part, optional bind/cmdId/agentCmd, and file parts only'))
      let params: unknown
      try { params = JSON.parse(parsed.fields.params ?? '{}') } catch { return send(res, fail('invalid_param', 'the params part is not valid JSON')) }
      if (typeof params !== 'object' || params === null || Array.isArray(params) || tooDeep(params)) return send(res, fail('invalid_param', 'params must be an object'))
      const bind = parsed.fields.bind, cmdId = parsed.fields.cmdId
      if ((bind !== undefined && typeof bind !== 'string') || (cmdId !== undefined && typeof cmdId !== 'string')) return send(res, fail('invalid_param', 'bind and cmdId must be strings'))
      let agentCmd: { via?: string } | undefined
      if (parsed.fields.agentCmd !== undefined) {
        try {
          const ac = JSON.parse(parsed.fields.agentCmd) as { via?: unknown } | null
          agentCmd = { via: typeof ac?.via === 'string' ? ac.via : undefined }
        } catch { return send(res, fail('invalid_param', 'the agentCmd part is not valid JSON')) }
      }
      ;(who.request as unknown as { [PARTS]?: FilePart[] })[PARTS] = parsed.files
      return send(res, await invoke(server, { id, params, bind, cmdId, ...(agentCmd && { agentCmd }) }, who))
    }
    if (!/^application\/json\s*(;|$)/i.test(ct)) return send(res, fail('invalid_param', 'Content-Type must be application/json'))
    const parsed = await readJsonObject(req, settings.limits.bodyBytes)
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') { res.setHeader('connection', 'close'); return send(res, fail('invalid_param', `request body exceeds ${settings.limits.bodyBytes} bytes`), 413) }
      if (parsed.reason === 'not_json') return send(res, fail('invalid_param', 'body is not valid JSON'))
      return send(res, fail('invalid_param', 'body must be a JSON object {params, bind?, cmdId?}'))
    }
    const { params, bind, cmdId, agentCmd } = parsed.value
    if ((bind !== undefined && typeof bind !== 'string') || (cmdId !== undefined && typeof cmdId !== 'string')) return send(res, fail('invalid_param', 'bind and cmdId must be strings'))
    // downgrade-only agent marker (a WebMCP step's own api.* calls): it can make a call agent, never human
    const via = agentCmd !== undefined ? { via: typeof (agentCmd as { via?: unknown } | null)?.via === 'string' ? (agentCmd as { via: string }).via : undefined } : undefined
    send(res, await invoke(server, { id, params, bind, cmdId, ...(via && { agentCmd: via }) }, who))
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

// A multipart body under `cap` bytes whose every part (the bytes between two boundaries) stays under partCap
// (+ 1 KB of part headers); null as soon as either is exceeded. Boundaries are found while streaming.
function readMultipart(req: IncomingMessage, cap: number, partCap: number, boundary: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const sep = Buffer.from(`--${boundary}`)
    let n = 0, since = 0, tail = Buffer.alloc(0)
    const onData = (c: Buffer) => {
      n += c.length
      const win = Buffer.concat([tail, c]), i = win.lastIndexOf(sep)
      since = i >= 0 ? win.length - i - sep.length : since + c.length
      tail = win.subarray(Math.max(0, win.length - sep.length + 1))
      if (n <= cap && since <= partCap + 1024) return void chunks.push(c)
      req.off('data', onData)
      req.pause()
      resolve(null)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}

export { tooDeep, readBodyUtf8 as readBody } from './body.js'
