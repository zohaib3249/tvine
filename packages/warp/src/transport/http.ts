// transport/http — header-negotiated HTTP (docs/design/server/transport-http.md). Same URL for humans
// and agents: agent GET → snapshot envelope, agent POST → one dispatch() call, humans → next().
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { collect, dispatch, renderCtx, type ServerCtx } from '../core/dispatch.js'
import { ev } from '../core/events.js'
import { buildRequest, requestId } from '../core/request.js'
import type { Command, ErrCode, Event, Permission, Request, Session, Settings, UploadedFile } from '../core/types.js'
import { receiveUpload, type UploadDef } from '../media/index.js'
import { runPermissions } from '../security/permissions.js'
import { bodyCap } from '../security/ratelimit.js'
import { render, snapshotOf, type Ctx, type Format } from '../serialize/envelope.js'
import type { RouteInfo } from './discovery.js'

export interface HttpOptions { routes: RouteInfo[] }   // the route table (Next app routes); unknown paths → 404

// One header lookup + one accept scan for human traffic.
export function isAgent(req: IncomingMessage, settings: Settings): boolean {
  if (req.headers[settings.header.toLowerCase()] !== undefined) return true
  const a = req.headers.accept
  return a !== undefined && (a.includes('text/tvine') || a.includes('application/tvine+json'))
}

const STATUS: Partial<Record<ErrCode, number>> = { expired_sid: 401, rate_limited: 429, internal: 500 }
const TYPE: Record<Format, string> = { json: 'application/json; charset=utf-8', notation: 'text/plain; charset=utf-8' }
const BASE = 'http://tvine.local'
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Transport-level refusal (bad body, too large, not found, guarded): answered without dispatch.
class Refuse extends Error {
  constructor(public status: number, public code: ErrCode, message: string, public field?: string) { super(message) }
}

// Glob → RegExp: `**` any depth (also the base itself: '/admin/**' guards '/admin'), `*` one segment.
const globRe = (g: string) => new RegExp('^' + g.split('/**').map((p) =>
  p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:/.*)?') + '$')

// Next pattern match: [x] one segment, [...x] one or more, [[...x]] zero or more.
function matches(pattern: string, ps: string[]): boolean {
  const rs = pattern.split('/').filter(Boolean)
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!
    if (/^\[\[\.\.\.\w+\]\]$/.test(r)) return true
    if (/^\[\.\.\.\w+\]$/.test(r)) return ps.length > i
    if (i >= ps.length || (/^\[\w+\]$/.test(r) ? ps[i] === '' : r !== ps[i])) return false
  }
  return ps.length === rs.length
}

export function httpTransport(server: ServerCtx, opts: HttpOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings, sessions } = server
  const guards = settings.guards.map((g) => ({ re: globRe(g.path), permissions: g.permissions }))
  const statics = new Set(opts.routes.map((r) => r.path).filter((p) => !p.includes('[')))
  const dynamics = opts.routes.map((r) => r.path).filter((p) => p.includes('['))
  const cookieName = settings.session.cookieName

  // The exact path dispatch/snapshot will use is the one checked here (decoded, so %61dmin ≡ admin).
  function routeOf(path: string): string {
    let d: string
    try { d = decodeURIComponent(path) } catch { throw new Refuse(404, 'domain', 'not found') }
    const segs = d.split('/')
    if (d.includes('\\') || segs.some((s) => s === '.' || s === '..')) throw new Refuse(404, 'domain', 'not found')
    return d.replace(/\/+$/, '') || '/'
  }
  function matchRoute(key: string): string | undefined {
    if (statics.has(key)) return key
    const ps = key === '/' ? [] : key.split('/').slice(1)
    return dynamics.find((p) => matches(p, ps))
  }

  async function guard(key: string, request: Request, session: Session | undefined): Promise<void> {
    const perms: Permission[] = guards.filter((g) => g.re.test(key)).flatMap((g) => g.permissions)
    if (!perms.length) return
    const s = session ?? { sid: '', rev: 0, data: new Map(), createdAt: 0, lastSeen: 0 }
    try {
      await runPermissions(perms, { sid: s.sid, session: s, route: request.route, user: request.user, agent: request.agent, ip: request.ip })
    } catch { throw new Refuse(403, 'domain', 'forbidden: agents may not access this route') }
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
  const setCookie = (req: IncomingMessage, res: ServerResponse, sid: string) => {
    const c = cookieOf(req)
    if (!sid || (c !== undefined && sessions.peek({ cookie: c }))) return
    if (!sessions.peek({ sid })) return
    res.setHeader('set-cookie', `${cookieName}=${sessions.cookieFor(sid)}; Path=/; Max-Age=${Math.floor(settings.session.ttlMs / 1000)}; HttpOnly; SameSite=Lax${https(req) ? '; Secure' : ''}`)
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
    const id = requestId({ get: (n) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null } })
    res.setHeader('x-request-id', id)
    res.setHeader('vary', `${settings.header}, accept`)
    const u = new URL(req.url ?? '/', BASE)
    let format: Format = settings.formats.default
    let request: Request | undefined
    let action: string | undefined
    let ctx: Ctx = { sid: '', rev: 0, page: u.pathname }
    let sid = ''
    const reply = (status: number, events: Event[], headers: Record<string, string> = {}) => {
      const snapSid = events.map(snapshotOf).find(Boolean)?.sid
      sid = snapSid ?? ctx.sid
      setCookie(req, res, sid)
      res.writeHead(status, { 'content-type': TYPE[format], 'cache-control': 'private, no-store', ...headers })
      res.end(render(events, format, settings, { ctx: { ...ctx, sid } }))
      return status
    }
    let status: number
    try {
      format = pickFormat(req, u.searchParams, forced)
      const key = routeOf(u.pathname)
      const route = matchRoute(key)
      if (!route) throw new Refuse(404, 'domain', 'not found: this page has no agent view')
      request = await buildRequest({ req, route, isAgent: true }, settings)
      request.id = id
      const isGet = req.method === 'GET'
      const sidKey = (isGet ? u.searchParams.get('sid') : null) ?? (req.headers['x-tvine-sid'] as string | undefined)
      const cookie = cookieOf(req)
      const known = (sidKey ? sessions.peek({ sid: sidKey }) : undefined) ?? (cookie !== undefined ? sessions.peek({ cookie }) : undefined)
      ctx = { sid: known?.sid ?? '', rev: known?.rev ?? 0, page: u.pathname }
      await guard(key, request, known)
      if (isGet) status = await agentGet(req, res, request, u, format, ctx, (c) => { ctx = c }, reply)
      else {
        const { cmd, file, def } = await readCommand(req, request, sidKey ?? undefined)
        action = cmd.action
        const events = await collect(dispatch(cmd, server, request))
        if (file) {
          const ok = events.find((e): e is Extract<Event, { kind: 'ok' }> => e.kind === 'ok')
          if ((ok?.result as UploadedFile | undefined)?.key !== file.key) await def!.upload.storage.delete(file.key)
        }
        ctx = renderCtx(server, cmd, request)
        const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
        const code = !err ? 200 : err.code === 'domain' && err.message.startsWith('forbidden') ? 403 : STATUS[err.code] ?? 400
        const retry = err?.code === 'rate_limited' && /(\d+)ms/.exec(err.message)?.[1]
        status = reply(code, events, retry ? { 'retry-after': String(Math.max(1, Math.ceil(Number(retry) / 1000))) } : {})
      }
    } catch (e) {
      if (res.headersSent) { res.destroy(); status = 500 }
      else if (e instanceof Refuse) {
        if (e.status === 413 || req.method === 'POST') res.setHeader('connection', 'close')
        status = reply(e.status, [ev.err(e.code, e.message, e.field !== undefined ? { field: e.field } : undefined)])
      } else {
        server.log('error', 'http transport failed', { id, error: e instanceof Error ? e.stack ?? e.message : String(e) })
        status = reply(500, [ev.err('internal', 'internal error')])
      }
    }
    log({ t: new Date().toISOString(), id, sid, route: request?.route ?? u.pathname, ...(action && { action }), status, ms: Math.round(performance.now() - t0) })
  }

  async function agentGet(req: IncomingMessage, res: ServerResponse, request: Request, u: URL, format: Format, ctx: Ctx,
    setCtx: (c: Ctx) => void, reply: (s: number, e: Event[]) => number): Promise<number> {
    const session = (ctx.sid ? sessions.resolve({ sid: ctx.sid }) : undefined) ?? sessions.create()
    const q = new URLSearchParams(u.searchParams)
    q.delete('sid'); q.delete('format')
    const page = request.path + (q.size ? `?${q}` : '')
    setCtx({ sid: session.sid, rev: session.rev, page })
    const snap = await server.snapshot(page, session.sid)
    const etag = `"${createHash('sha1').update(format).update(JSON.stringify(snap)).digest('base64url')}"`
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
  async function readCommand(req: IncomingMessage, request: Request, headerSid: string | undefined):
    Promise<{ cmd: Command; file?: UploadedFile; def?: UploadDef }> {
    const ct = (req.headers['content-type'] ?? '').toLowerCase()
    const mp = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(req.headers['content-type'] ?? '')
    if (mp) {
      const { fields, file, def } = await multipart(req, mp[1] ?? mp[2]!)
      request.files = [file]
      return { cmd: toCommand({ ...fields, rev: fields.rev === undefined ? undefined : /^\d+$/.test(fields.rev) ? Number(fields.rev) : fields.rev, params: { file: { ...file } } }, headerSid), file, def }
    }
    if (!/^application\/(json|tvine\+json)\s*(;|$)/.test(ct)) throw new Refuse(400, 'invalid_param', 'Content-Type must be application/json')
    const raw = await readBody(req, settings.limits.bodyBytes)
    if (!raw) throw new Refuse(413, 'invalid_param', `request body exceeds ${settings.limits.bodyBytes} bytes`)
    let body: unknown
    try { body = JSON.parse(raw.toString('utf8')) } catch { throw new Refuse(400, 'invalid_param', 'body is not valid JSON') }
    return { cmd: toCommand(body, headerSid) }
  }

  function toCommand(v: unknown, headerSid: string | undefined): Command {
    if (!isPlain(v)) throw new Refuse(400, 'invalid_param', 'body must be a JSON object {action, params, sid}')
    const { action, params = {}, sid = headerSid, bind, cmdId, rev } = v
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
    }
  }

  // Streaming multipart/form-data. Text fields first (`action` before the file), one file part named
  // `file`. Text fields share limits.bodyBytes; the file is capped by the upload's maxBytes (media.md).
  async function multipart(req: IncomingMessage, boundary: string): Promise<{ fields: Record<string, string>; file: UploadedFile; def: UploadDef }> {
    const it = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const delim = Buffer.from(`\r\n--${boundary}`)
    const CRLF2 = Buffer.from('\r\n\r\n')
    const textCap = settings.limits.bodyBytes
    let buf = Buffer.from('\r\n'), total = 0, cap = textCap
    const more = async () => {
      const r = await it.next()
      if (r.done) throw new Refuse(400, 'invalid_param', 'multipart body is truncated')
      total += r.value.length
      if (bodyCap(total, cap).ok === false) throw new Refuse(413, 'invalid_param', 'request body too large')
      buf = Buffer.concat([buf, r.value])
    }
    const until = async (sep: Buffer) => {
      let i: number
      while ((i = buf.indexOf(sep)) < 0) await more()
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
    const fields: Record<string, string> = {}
    let file: UploadedFile | undefined, def: UploadDef | undefined
    for (;;) {
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
      try { file = await receiveUpload(Readable.from(body()), def, { field: 'file' }) }
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
    return { fields, file, def }
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
