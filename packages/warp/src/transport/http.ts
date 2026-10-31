// transport/http — header-negotiated HTTP (docs/design/server/transport-http.md). Same URL for humans
// and agents: agent GET → snapshot envelope, agent POST → one dispatch() call, humans → next().
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { collect, dispatch, rateLimited, renderCtx, type ServerCtx } from '../core/dispatch.js'
import { DomainError, Goto } from '../core/errors.js'
import { ev } from '../core/events.js'
import { buildRequest, clientIp, requestId } from '../core/request.js'
import type { Command, ErrCode, Event, Request, Session, Settings, UploadedFile } from '../core/types.js'
import { receiveUpload, storageOf, type UploadDef } from '../media/index.js'
import { bodyCap } from '../security/ratelimit.js'
import { render, snapshotOf, type Ctx, type ExpandOpt, type Format, type ViewOpt } from '../serialize/envelope.js'
import { hasNode, pageSnapshot, runUi, stepsOf, uiInput } from '../core/ui.js'
import type { RouteInfo } from './discovery.js'
import { FORBIDDEN_ROUTE, guardCheck } from './guards.js'
import { routeMatcher } from './routes.js'

type Upload = { file?: UploadedFile; def?: UploadDef; keep?: boolean }
const hideSid = (e: Event): Event =>
  e.kind === 'snapshot' ? { ...e, snapshot: { ...e.snapshot, sid: '' } }
  : e.kind === 'err' && e.snapshot ? { ...e, snapshot: { ...e.snapshot, sid: '' } } : e

export interface HttpOptions {
  routes: RouteInfo[]                               // the route table (Next app routes); unknown paths → 404
  match?: (path: string) => string | undefined      // a ready matcher instead (shared with MCP; live in dev)
}

// One header lookup + one accept scan for human traffic.
export function isAgent(req: IncomingMessage, settings: Settings): boolean {
  if (req.headers[settings.header.toLowerCase()] !== undefined) return true
  const a = req.headers.accept
  return a !== undefined && (a.includes('text/tvine') || a.includes('application/tvine+json'))
}

const STATUS: Partial<Record<ErrCode, number>> = { expired_sid: 401, rate_limited: 429, internal: 500, human_only: 403 }
const TYPE: Record<Format, string> = { json: 'application/json; charset=utf-8', notation: 'text/plain; charset=utf-8' }
const BASE = 'http://tvine.local'
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const VIEWS = new Set(['auto', 'full', 'L1', 'L0'])
const uiBody = uiInput.omit({ url: true })
type UiBody = { ui: unknown; sid?: string }

// Transport-level refusal (bad body, too large, not found, guarded): answered without dispatch.
class Refuse extends Error {
  constructor(public status: number, public code: ErrCode, message: string, public field?: string, public retryAfterMs?: number) { super(message) }
  get reason() { return this.status === 403 ? 'forbidden' : this.status === 413 ? 'too_large' : undefined }
}
const DOMAIN_STATUS: Record<string, number> = { forbidden: 403, not_found: 404 }
const retryAfter = (ms: number) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) })
export const sidHash = (sid: string) => sid && createHash('sha256').update(sid).digest('base64url').slice(0, 12)

// JSON.parse accepts any depth; recursive consumers (hash, clone, zod) then blow the stack.
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

export function httpTransport(server: ServerCtx, opts: HttpOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings, sessions } = server
  const cookieName = settings.session.cookieName
  const match = opts.match ?? routeMatcher(opts.routes)
  const allowed = guardCheck(settings)

  // Only canonical paths: the raw path must already be what URL parsing (and so request.path, the
  // snapshot page) yields; routeMatcher refuses //, trailing /, encoded / or \\, and dot segments.
  // Matching uses the decoded form (%61dmin ≡ admin); dispatch and snapshot get the very same path.
  const canonical = (raw: string, parsed: string) => (raw === parsed ? match(raw) : undefined)

  async function guard(raw: string, request: Request, session: Session | undefined): Promise<void> {
    if (!(await allowed(decodeURIComponent(raw), request, session))) throw new Refuse(403, 'domain', FORBIDDEN_ROUTE)
  }

  const cookieOf = (req: IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim()
    }
    return undefined
  }
  // https per the same trusted hops as request.ip (request.md): rightmost-`trustProxy` X-Forwarded-Proto.
  const https = (req: IncomingMessage) => {
    if ((req.socket as { encrypted?: boolean }).encrypted) return true
    if (settings.trustProxy <= 0) return false
    const parts = String(req.headers['x-forwarded-proto'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return parts[parts.length - settings.trustProxy] === 'https'
  }
  // Only when the browser has no live cookie session: an explicit agent sid never steals a human's cookie.
  const setCookie = async (req: IncomingMessage, res: ServerResponse, sid: string) => {
    const c = cookieOf(req)
    if (!sid || (c !== undefined && await sessions.peek({ cookie: c }))) return
    if (!(await sessions.peek({ sid }))) return
    res.setHeader('set-cookie', `${cookieName}=${await sessions.cookieFor(sid)}; Path=/; Max-Age=${Math.floor(settings.session.ttlMs / 1000)}; HttpOnly; SameSite=Lax${https(req) ? '; Secure' : ''}`)
  }

  const pickFormat = (req: IncomingMessage, q: URLSearchParams, forced?: Format): Format => {
    if (forced) return forced
    const f = q.get('format')
    if (f === 'json' || f === 'notation') return f
    const a = req.headers.accept ?? ''
    if (a.includes('text/tvine')) return 'notation'
    if (a.includes('application/tvine+json')) return 'json'
    return settings.formats.default
  }

  const log = (line: Record<string, unknown>) => {
    if (settings.logging === 'json') console.log(JSON.stringify(line))
    else if (settings.logging === 'pretty') console.log(`${line.status} ${line.route} ${line.action ?? ''} ${line.ms}ms ${line.id}`)
  }

  async function handle(req: IncomingMessage, res: ServerResponse, forced: Format | undefined) {
    const t0 = performance.now()
    const hdr = { get: (n: string) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null } }
    const id = requestId(hdr)
    res.setHeader('x-request-id', id)
    res.setHeader('vary', `${settings.header}, accept, x-tvine-view, x-tvine-expand, x-tvine-offset, x-tvine-limit`)
    const u = new URL(req.url ?? '/', BASE)
    let format: Format = settings.formats.default
    let request: Request | undefined
    let action: string | undefined
    let ctx: Ctx = { sid: '', rev: 0, page: u.pathname }
    let sid = ''
    // I3: a sid known only through the httpOnly cookie is never written into a response body.
    let reveal = !cookieOf(req)
    // secreview H2: a sid the caller named (?sid=, x-tvine-sid, body sid) never becomes a browser cookie (fixation /
    // login CSRF through a plain link). Agents carry their sid; a cookie only goes out for a session this request made.
    const named = new Set<string>()
    const upload: Upload = {}
    // C1: a stored upload survives only as the result of a successful command; removed before replying
    const cleanup = async () => {
      const f = upload.file
      if (!f || upload.keep) return
      upload.file = undefined
      await storageOf(upload.def!, settings.media).delete(f.key)
        .catch((e: unknown) => server.log('error', 'upload cleanup failed', { id, key: f.key, error: String(e) }))
    }
    let shape: { view?: ViewOpt; expand?: ExpandOpt } = {}
    const reply = async (status: number, events: Event[], headers: Record<string, string> = {}) => {
      for (const e of events) if (e.kind === 'snapshot') sessions.remember(e.snapshot)   // expand serves from it
      sid = events.map(snapshotOf).find(Boolean)?.sid ?? ctx.sid
      if (!named.has(sid)) await setCookie(req, res, sid).catch((e: unknown) => server.log('error', 'session cookie failed', { error: String(e) }))
      const shown = reveal ? events : events.map(hideSid)
      res.writeHead(status, { 'content-type': TYPE[format], 'cache-control': 'private, no-store', ...headers })
      res.end(render(shown, format, settings, { ctx: { ...ctx, sid: reveal ? sid : '' }, ...shape }))
      return status
    }
    let status = 0
    try {
      format = pickFormat(req, u.searchParams, forced)
      const raw = (req.url ?? '/').split('?')[0]!
      // /shop/ → 308 /shop, only when the stripped path is itself canonical and routed (never //x: no open redirect)
      if (raw.length > 1 && raw.endsWith('/')) {
        const to = canonical(raw.slice(0, -1), u.pathname.slice(0, -1))
        if (to === undefined) throw new Refuse(404, 'domain', 'not found')
        res.writeHead(308, { location: raw.slice(0, -1) + u.search, 'cache-control': 'private, no-store' })
        res.end()
        status = 308
        return
      }
      const route = canonical(raw, u.pathname)
      if (!route) throw new Refuse(404, 'domain', 'not found: this page has no agent view')
      const isGet = req.method === 'GET'
      if (isGet) {   // before auth and guards: a refused GET costs nothing
        const rl = await server.limiter.check({ ip: clientIp(hdr.get('x-forwarded-for'), req.socket.remoteAddress ?? '', settings.trustProxy) })
        if (!rl.ok) throw new Refuse(429, 'rate_limited', `rate limited: retry after ${rl.retryAfterMs}ms`, undefined, rl.retryAfterMs)
      }
      request = await buildRequest({ req, route, isAgent: true }, settings)
      request.id = id
      // header first: a ?sid= lands in logs and Referers (#14)
      const sidKey = (req.headers['x-tvine-sid'] as string | undefined) ?? (isGet ? u.searchParams.get('sid') : null) ?? undefined
      const cookie = cookieOf(req)
      if (sidKey) named.add(sidKey)
      const bySid = sidKey ? await sessions.peek({ sid: sidKey }) : undefined
      const known = bySid ?? (cookie !== undefined ? await sessions.peek({ cookie }) : undefined)
      if (bySid) reveal = true
      ctx = { sid: known?.sid ?? '', rev: known?.rev ?? 0, page: u.pathname }
      await guard(raw, request, known)
      if (isGet) {
        shape = getShape(req)
        status = await agentGet(req, res, request, u, format, ctx, shape, (c) => { ctx = c }, reply)
      } else {
        const got = await readCommand(req, request, sidKey ?? undefined, upload)
        if ('ui' in got) {
          if (got.sid !== undefined) { reveal = true; named.add(got.sid) }
          action = 'ui'
          const out = await headlessUi(got, request, raw, cookie)
          ctx = out.ctx
          const err = out.events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
          const code = !err ? 200 : err.code === 'domain' ? DOMAIN_STATUS[err.reason ?? ''] ?? 400 : STATUS[err.code] ?? 400
          status = await reply(code, out.events, err?.retryAfterMs !== undefined ? retryAfter(err.retryAfterMs) : {})
          return
        }
        const cmd = got
        action = cmd.action
        if (cmd.sid !== undefined) { reveal = true; named.add(cmd.sid) }
        const events = await collect(dispatch(cmd, server, request))
        const ok = events.find((e): e is Extract<Event, { kind: 'ok' }> => e.kind === 'ok')
        upload.keep = upload.file !== undefined && (ok?.result as UploadedFile | undefined)?.key === upload.file.key
        await cleanup()
        ctx = await renderCtx(server, cmd, request)
        const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
        const code = !err ? 200 : err.code === 'domain' ? DOMAIN_STATUS[err.reason ?? ''] ?? 400 : STATUS[err.code] ?? 400
        status = await reply(code, events, err?.retryAfterMs !== undefined ? retryAfter(err.retryAfterMs) : {})
      }
    } catch (e) {
      await cleanup()
      if (res.headersSent) { res.destroy(); status = 500 }
      else if (e instanceof Refuse) {
        if (e.status === 413 || req.method === 'POST') res.setHeader('connection', 'close')
        const opts = { ...(e.field !== undefined && { field: e.field }), ...(e.retryAfterMs !== undefined && { retryAfterMs: e.retryAfterMs }), ...(e.reason && { reason: e.reason }) }
        status = await reply(e.status, [ev.err(e.code, e.message, opts)], e.retryAfterMs !== undefined ? retryAfter(e.retryAfterMs) : {})
      } else if (e instanceof DomainError) {   // e.g. not_found: the page Next rendered called notFound()
        status = await reply(DOMAIN_STATUS[e.code] ?? 400, [ev.err('domain', e.message, { reason: e.code })])
      } else {
        server.log('error', 'http transport failed', { id, error: e instanceof Error ? e.stack ?? e.message : String(e) })
        status = await reply(500, [ev.err('internal', 'internal error')])
      }
    } finally {
      await cleanup()
      log({ t: new Date().toISOString(), id, sid: sidHash(sid), route: request?.route ?? u.pathname, ...(action && { action }), status, ms: Math.round(performance.now() - t0) })
    }
  }

  // x-tvine-view: auto|full|L1|L0 (bad value → auto); x-tvine-expand: <node id> (+ offset/limit)
  const getShape = (req: IncomingMessage): { view?: ViewOpt; expand?: ExpandOpt } => {
    const h = (n: string) => { const v = req.headers[n]; return typeof v === 'string' ? v : undefined }
    const num = (n: string, lo: number, hi: number) => { const v = Number(h(n)); return Number.isInteger(v) && v >= lo && v <= hi ? v : undefined }
    const id = h('x-tvine-expand')
    if (id) return { expand: { id: id.slice(0, 500), offset: num('x-tvine-offset', 0, 1e6), limit: num('x-tvine-limit', 1, 100) } }
    const v = h('x-tvine-view')
    return v && VIEWS.has(v) ? { view: v as ViewOpt } : {}
  }

  // POST {ui: UiCommand}: headless ui on this page (core/ui.ts); later steps may only change the query.
  async function headlessUi(body: UiBody, request: Request, raw: string, cookie: string | undefined): Promise<{ events: Event[]; ctx: Ctx }> {
    const page0 = request.path + (request.query.size ? `?${request.query}` : '')
    const p = uiBody.safeParse(body.ui)
    const steps = p.success ? stepsOf(p.data) : undefined
    if (!p.success || !steps) {
      const i = p.success ? undefined : p.error.issues[0]
      throw new Refuse(400, 'invalid_param', i ? `ui.${i.path.join('.')}: ${i.message}` : 'ui needs target + control, or steps', 'ui')
    }
    const sidKey = body.sid ?? p.data.sid
    const known = await sessions.resolve({ sid: sidKey, cookie: sidKey === undefined ? cookie : undefined })
    const session = known ?? await sessions.create()
    const ctx = { sid: session.sid, rev: session.rev, page: page0 }
    if (sidKey !== undefined && !known) {   // like dispatch: a dead sid never runs steps
      return { ctx, events: [ev.err('expired_sid', 'session expired or missing; a new sid is attached', { snapshot: await server.snapshot(page0, session.sid) })] }
    }
    const rl = await server.limiter.check({ ip: request.ip, sid: session.sid })
    if (!rl.ok) return { ctx, events: [rateLimited(rl.retryAfterMs)] }
    const at = async (pg: string) => {
      const u = new URL(pg, BASE)
      if (u.origin !== new URL(BASE).origin || u.pathname !== request.path) return undefined   // ponytail: same path only (url maps change the query)
      const r = { ...request, query: new URLSearchParams(u.searchParams) }
      return (await allowed(decodeURIComponent(raw), r, session)) ? r : undefined
    }
    try {
      const out = await runUi(server, steps, p.data, { session, page: page0, request: at })
      return { events: out.events, ctx: { ...ctx, rev: session.rev, page: out.page } }
    } catch (e) {
      if (e instanceof Goto) return { ctx, events: [ev.goto(e.url)] }
      throw e
    }
  }

  async function agentGet(req: IncomingMessage, res: ServerResponse, request: Request, u: URL, format: Format, ctx: Ctx,
    shape: { view?: ViewOpt; expand?: ExpandOpt }, setCtx: (c: Ctx) => void, reply: (s: number, e: Event[]) => Promise<number>): Promise<number> {
    const t0 = performance.now()
    const known = ctx.sid ? await sessions.resolve({ sid: ctx.sid }) : undefined
    const session = known ?? await sessions.create()
    const q = new URLSearchParams(u.searchParams)
    q.delete('sid'); q.delete('format')
    const page = request.path + (q.size ? `?${q}` : '')
    setCtx({ sid: session.sid, rev: session.rev, page })
    let snap
    try { snap = shape.expand ? await pageSnapshot(server, session.sid, page) : await server.snapshot(page, session.sid) } catch (e) {
      if (!known) { await sessions.delete(session.sid); setCtx({ sid: '', rev: 0, page }) }   // a refused render or a redirect leaves no session and no cookie
      if (e instanceof Goto) return reply(200, [ev.goto(e.url)])
      throw e
    }
    if (shape.expand) {   // L2 from the session's cached snapshot; never cached by anyone else
      const id = shape.expand.id
      if (!hasNode(snap, id)) {   // the L0 map comes back to recover from (reply reads this same shape)
        delete shape.expand
        shape.view = 'L0'
        return reply(400, [ev.err('unknown_action', `unknown node ${id.slice(0, 100)}; ids are in the map`, { snapshot: snap })])
      }
      return reply(200, [ev.snapshot(snap)])
    }
    const etag = `"${createHash('sha1').update(format).update(String(req.headers['x-tvine-view'] ?? '')).update(JSON.stringify(snap)).digest('base64url')}"`
    // an agent read the page (a 304 too: it has the content); after the reply, like the command hook
    const ms = Math.round(performance.now() - t0)
    if (server.hooks.has('read')) setImmediate(() => server.hooks.emit('read', { page, via: 'http', sid: session.sid, rev: session.rev, ms }))
    res.setHeader('etag', etag)
    const inm = req.headers['if-none-match']
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      res.writeHead(304, { 'cache-control': 'private, no-cache' })
      res.end()
      return 304
    }
    res.setHeader('cache-control', 'private, no-cache')
    return reply(200, [ev.snapshot(snap)])
  }

  // JSON command, or multipart upload (file streamed through the media module, never buffered whole).
  async function readCommand(req: IncomingMessage, request: Request, headerSid: string | undefined, upload: Upload): Promise<Command | UiBody> {
    const ct = (req.headers['content-type'] ?? '').toLowerCase()
    const mp = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(req.headers['content-type'] ?? '')
    if (mp) {
      // I2: the IP bucket is charged before a byte is stored (dispatch charges it again; fine)
      const rl = await server.limiter.check({ ip: request.ip })
      if (!rl.ok) throw new Refuse(429, 'rate_limited', `rate limited: retry after ${rl.retryAfterMs}ms`, undefined, rl.retryAfterMs)
      const fields = await multipart(req, mp[1] ?? mp[2]!, upload)
      const { file, def } = upload as Required<Upload>
      request.files = [file]
      // M3: params carry content facts, not the generated key, so a cmdId retry hashes the same
      const cmd = toCommand({ ...fields, rev: fields.rev === undefined ? undefined : /^\d+$/.test(fields.rev) ? Number(fields.rev) : fields.rev, params: { file: { type: file.type, size: file.size } } }, headerSid)
      if (cmd.action !== def.id) throw new Refuse(400, 'invalid_param', 'action does not match the upload the file was checked against', 'action')
      return cmd
    }
    if (!/^application\/(json|tvine\+json)\s*(;|$)/.test(ct)) throw new Refuse(400, 'invalid_param', 'Content-Type must be application/json')
    const raw = await readBody(req, settings.limits.bodyBytes)
    if (!raw) throw new Refuse(413, 'invalid_param', `request body exceeds ${settings.limits.bodyBytes} bytes`)
    let body: unknown
    try { body = JSON.parse(raw.toString('utf8')) } catch { throw new Refuse(400, 'invalid_param', 'body is not valid JSON') }
    if (tooDeep(body)) throw new Refuse(400, 'invalid_param', 'body is nested too deeply')
    if (isPlain(body) && 'ui' in body && !('action' in body)) {
      if (body.sid !== undefined && typeof body.sid !== 'string') throw new Refuse(400, 'invalid_param', 'sid must be a string', 'sid')
      return { ui: body.ui, sid: (body.sid as string | undefined) ?? headerSid }
    }
    return toCommand(body, headerSid)
  }

  function toCommand(v: unknown, headerSid: string | undefined): Command {
    if (!isPlain(v)) throw new Refuse(400, 'invalid_param', 'body must be a JSON object {action, params, sid}')
    const { action, params = {}, sid = headerSid, bind, cmdId, rev, agentCmd } = v
    if (typeof action !== 'string' || !action) throw new Refuse(400, 'invalid_param', 'action must be a string', 'action')
    if (!isPlain(params)) throw new Refuse(400, 'invalid_param', 'params must be an object', 'params')
    for (const [k, x] of [['sid', sid], ['bind', bind], ['cmdId', cmdId]] as const) {
      if (x !== undefined && typeof x !== 'string') throw new Refuse(400, 'invalid_param', `${k} must be a string`, k)
    }
    if (rev !== undefined && !Number.isInteger(rev)) throw new Refuse(400, 'invalid_param', 'rev must be an integer', 'rev')
    return {
      action, params,
      ...(sid !== undefined && { sid: sid as string }), ...(bind !== undefined && { bind: bind as string }),
      ...(cmdId !== undefined && { cmdId: cmdId as string }), ...(rev !== undefined && { rev: rev as number }),
      // downgrade-only marker (any value makes the request agent; dispatch reads only `via`)
      ...(agentCmd !== undefined && { agentCmd: { via: isPlain(agentCmd) && typeof agentCmd.via === 'string' ? agentCmd.via : undefined } }),
    }
  }

  // Streaming multipart/form-data. Text fields first (`action` before the file), one file part named
  // `file`. Text fields share limits.bodyBytes; the file is capped by the upload's maxBytes (media.md).
  async function multipart(req: IncomingMessage, boundary: string, upload: Upload): Promise<Record<string, string>> {
    const it = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const delim = Buffer.from(`\r\n--${boundary}`)
    const CRLF2 = Buffer.from('\r\n\r\n')
    const textCap = settings.limits.bodyBytes
    // The text cap counts bytes the text parts CONSUMED (a read chunk may already hold file bytes); the
    // file is capped by receiveUpload's maxBytes alone, so an oversized file always gets its own 413.
    let buf = Buffer.from('\r\n'), total = 0, cap = textCap, taken = 0
    const more = async () => {
      const r = await it.next()
      if (r.done) throw new Refuse(400, 'invalid_param', 'multipart body is truncated')
      total += r.value.length
      buf = Buffer.concat([buf, r.value])
    }
    const textTooBig = (n: number) => { if (bodyCap(n, textCap).ok === false) throw new Refuse(413, 'invalid_param', 'request body too large') }
    const until = async (sep: Buffer) => {
      let i: number
      while ((i = buf.indexOf(sep)) < 0) { textTooBig(taken + buf.length); await more() }
      textTooBig((taken += i + sep.length))
      const out = buf.subarray(0, i)
      buf = buf.subarray(i + sep.length)
      return out
    }
    // Yields file bytes up to the next delimiter, holding back a possible partial delimiter.
    async function* body() {
      for (;;) {
        const i = buf.indexOf(delim)
        if (i >= 0) { if (i) yield buf.subarray(0, i); buf = buf.subarray(i + delim.length); return }
        const n = buf.length - delim.length + 1
        if (n > 0) { yield buf.subarray(0, n); buf = buf.subarray(n) }
        await more()
      }
    }
    await until(delim)   // preamble
    const fields: Record<string, string> = Object.create(null)
    let file: UploadedFile | undefined, def: UploadDef | undefined
    for (;;) {
      if (file) {   // C2: nothing may follow the file (a later field could swap the action it was checked for)
        while (buf.length < 2) await more()
        if (buf.subarray(0, 2).toString('latin1') !== '--') throw new Refuse(400, 'invalid_param', 'no parts are allowed after the file part')
      }
      while (buf.length < 2) await more()
      const tail = buf.subarray(0, 2).toString('latin1')
      buf = buf.subarray(2)
      if (tail === '--') break
      if (tail !== '\r\n') throw new Refuse(400, 'invalid_param', 'malformed multipart body')
      const disp = /^content-disposition:\s*form-data(.*)$/im.exec((await until(CRLF2)).toString('utf8'))?.[1] ?? ''
      const name = /;\s*name="([^"]*)"/i.exec(disp)?.[1]
      if (name === undefined) throw new Refuse(400, 'invalid_param', 'multipart part has no name')
      if (!/;\s*filename\*?=/i.test(disp)) { fields[name] = (await until(delim)).toString('utf8'); continue }
      if (file || name !== 'file') throw new Refuse(400, 'invalid_param', 'exactly one file part, named "file"', name)
      const d = server.actions.get(fields.action ?? '')
      if (!d || !('upload' in d)) throw new Refuse(400, 'invalid_param', 'the action field must come before the file and name an upload action', 'action')
      def = d as UploadDef
      cap = textCap + def.upload.maxBytes
      try { file = upload.file = await receiveUpload(Readable.from(body(), { highWaterMark: 1 }), def, { field: 'file', media: settings.media }); upload.def = def }
      catch (e) {
        const c = (e as { code?: unknown }).code
        if (c === 'too_large') throw new Refuse(413, 'invalid_param', (e as Error).message, 'file')
        if (c === 'unsupported_type' || c === 'invalid_param') throw new Refuse(400, 'invalid_param', (e as Error).message, 'file')
        throw e
      }
    }
    for (let r; !(r = await it.next()).done;) {   // epilogue, still capped
      total += r.value.length
      if (total > cap) throw new Refuse(413, 'invalid_param', 'request body too large')
    }
    if (!file || !def) throw new Refuse(400, 'invalid_param', 'multipart upload has no file part', 'file')
    return fields
  }

  return (req, res, next) => {
    const notationPath = settings.formats.notationPath
    const path = (req.url ?? '/').split('?')[0]!
    const alias = /(?:^|\/)agent\.(json|txt)$/.exec(path)
    if (req.method === 'GET' && alias && (alias[1] === 'json' || notationPath)) {
      const q = req.url!.slice(path.length)
      req.url = (path.slice(0, alias.index) || '/') + q   // the page this alias stands for
      void handle(req, res, alias[1] === 'json' ? 'json' : 'notation')
      return
    }
    if ((req.method !== 'GET' && req.method !== 'POST') || !isAgent(req, settings)) return next()
    void handle(req, res, undefined)
  }
}

// Body up to `cap` bytes; null once it is exceeded (the rest is drained, never stored).
function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    const onData = (c: Buffer) => {
      n += c.length
      if (bodyCap(n, cap).ok) return void chunks.push(c)
      req.off('data', onData)
      req.resume()
      resolve(null)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}
