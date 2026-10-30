// createAgentServer — the composition root (docs/design/server/server-index.md). The only file allowed
// to import across layers. Modes: standalone (listen), embedded (handler), API-only (no frontend).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Duplex } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collect, crossOrigin, dispatch, formResult, rateLimited, serverCtx, type FormResult, type ServerCtx } from './core/dispatch.js'
import { ev } from './core/events.js'
import { appModule, importApp, liveManifest, setLiveManifest } from './core/actions.js'
import { discoverMiddleware } from './core/middleware.js'
import { makeSnapshotter, SnapshotCache } from './core/registry.js'
import { buildRequest, clientIp } from './core/request.js'
import type { ActionRef, Command, Node, Request, Session, Settings, Snapshot } from './core/types.js'
import { connections } from './data/db.js'
import { DiskStorage, mediaHandler } from './media/index.js'
import { signBind } from './security/sign.js'
import { defineSettings, merge, type SettingsInput } from './settings.js'
import { channelTransport } from './transport/channel.js'
import { discoveryTransport, loadNextRoutes, type RouteInfo } from './transport/discovery.js'
import { FORBIDDEN_ROUTE, guardCheck } from './transport/guards.js'
import { httpTransport } from './transport/http.js'
import { mcpHandler } from './transport/mcp.js'
import { inspectorFeed } from './transport/inspector.js'
import { liveRouteMatcher, routeMatcher } from './transport/routes.js'
import { discover } from './views/discover.js'

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void
export type HeadersLike = Iterable<[string, string]>   // a fetch Headers, or Next's headers()
export interface CookieJar {                           // Next's cookies()
  get(name: string): { value: string } | undefined
  set(name: string, value: string, o: { httpOnly: boolean; sameSite: 'lax'; secure: boolean; path: string; maxAge: number }): unknown
}
export interface NextApp {
  prepare(): Promise<void>
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>
  getUpgradeHandler?(): (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
  close?(): Promise<void>
}
export type NextFactory = (o: { dev: boolean; dir: string }) => NextApp

export interface AgentServerOptions {
  settings?: SettingsInput & { secret?: string | string[] }   // merged over ./settings.ts (cwd), then defaults
  appsDir?: string                                             // default './apps'
  // nextDir = the .next dir; origin = where pages render (embedded); next = the `next` factory (default: the app's)
  frontend?: { nextDir: string; origin?: string; next?: NextFactory }
  dev?: boolean                                                // next({ dev: true }) in-process, HMR upgrades wired
  headers?: () => HeadersLike | Promise<HeadersLike>           // human Form path; default next/headers headers()
  cookies?: () => CookieJar | Promise<CookieJar>               // default next/headers cookies()
}
export interface AgentServer {
  listen(port: number): Promise<void>
  handler: (req: IncomingMessage, res: ServerResponse, next?: () => void) => void
  ctx: ServerCtx
  server: Server
  close(): Promise<void>
}

// weft stores these on globalThis (Next builds several module graphs); warp never imports weft.
const SIGNER = Symbol.for('tvine.signer'), DISPATCHER = Symbol.for('tvine.dispatcher'), PAGES = Symbol.for('tvine.pages')
const g = globalThis as Record<symbol, unknown>
const API_ROUTES: RouteInfo[] = [{ path: '/' }]
const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?')[0]!
const STAMP = 'x-tvine-ip'   // `<boot nonce>:<https 0|1>:<socket ip per trustProxy>`, set by our handler only
const URL_STAMP = 'x-tvine-url'   // the request url, set by our handler only (trusted with a valid STAMP)
const AS_SESSION = 'x-tvine-session'   // `<boot nonce>:<sid>`: an agent's snapshot render runs as that agent's session

// Server components: the session / request of the page being rendered (the cookie via next/headers, or
// the agent's session during its snapshot render). On globalThis: pages run in Next's bundled copy of warp.
export interface PageAccess { session(): Promise<Session | undefined>; request(): Promise<Request> }
function pageAccess(): PageAccess {
  const a = g[PAGES] as PageAccess | undefined
  if (!a) throw new Error('currentSession()/currentRequest(): no tvine server in this process (run the app with tvine start or tvine dev)')
  return a
}
// The request's Session, or undefined when it has none (a page view never creates one: pages cannot set cookies).
export const currentSession = async (): Promise<Session | undefined> => pageAccess().session()
export const currentRequest = async (): Promise<Request> => pageAccess().request()

// How a module of the APP is found (warp does not depend on next). Replaceable: under pnpm, NODE_PATH can
// make a hoisted `next` resolvable from anywhere, so tests inject "not installed" instead of relying on it.
export const appResolver = { resolve: (spec: string): string => createRequire(join(process.cwd(), 'package.json')).resolve(spec) }

async function fromApp<T>(spec: string): Promise<T> {
  let url: string
  try { url = pathToFileURL(appResolver.resolve(spec)).href }
  catch { throw new Error(`"${spec}" cannot be found from ${process.cwd()}: install next (pnpm add next)`) }
  return (await import(url)) as T
}

export async function loadSettings(over: AgentServerOptions['settings'] = {}): Promise<Settings> {
  const file = appModule(process.cwd(), 'settings')
  const base = file ? ((await importApp(file)) as { default: Settings }).default : {}
  return defineSettings(merge(base as Record<string, unknown>, over) as SettingsInput)
}

export async function createAgentServer(opts: AgentServerOptions = {}): Promise<AgentServer> {
  // next dev in production = unoptimized builds, HMR and dev error overlays served to real users
  if (opts.dev && process.env.NODE_ENV === 'production') throw new Error('dev: true is not allowed when NODE_ENV=production (use the built app: frontend.nextDir without dev)')
  // 1. settings (zod; missing TVINE_SECRET in prod throws). Boot lines go to stderr (stdout stays CLI output).
  const settings = await loadSettings(opts.settings)
  const say = (msg: string, level: 'info' | 'warn' = 'info') => {
    if (settings.logging !== 'none') console.error(settings.logging === 'json' ? JSON.stringify({ level, msg }) : `tvine: ${msg}`)
  }
  say('settings ok')
  if (process.env.NODE_APP_INSTANCE || process.env.pm_id || Number(process.env.WEB_CONCURRENCY) > 1) {
    say('WARNING: multi-instance run detected; sessions, limits and channels are in-process in v1 — run exactly one process', 'warn')
  }

  // 2. discover: duplicate/invalid actions fail here, naming the file, never at request time
  const appsDir = resolve(opts.appsDir ?? 'apps')
  if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
  const actions = await discover(appsDir, { rate: settings.limits.rate })
  const appMiddleware = await discoverMiddleware(appsDir)
  const fe = opts.frontend
  const routes = fe ? loadNextRoutes(fe.nextDir) : API_ROUTES
  // dev: `next dev` writes the manifest as pages compile, so an empty table is fine (re-read live below)
  if (fe && !routes.length && !opts.dev) throw new Error(`no routes in ${join(fe.nextDir, 'app-path-routes-manifest.json')} (run next build)`)
  say(`discovered ${actions.all().length} actions, ${routes.length} routes`)
  if (!actions.all().length && process.env.NODE_ENV === 'production') {
    say(`WARNING: no actions found under ${appsDir} (apps/<app>/views.ts, .js or .mjs); agents will see pages with nothing to do`, 'warn')
  }

  // 3. sessions, limiter, idempotency (serverCtx), snapshot cache + snapshotter
  connections.configure(settings)
  let snapshot: (route: string, sid: string) => Promise<Snapshot>
  const ctx = serverCtx({ actions, settings, appMiddleware, snapshot: (route, sid) => snapshot(route, sid) })
  const cache = new SnapshotCache()
  const nonce = randomBytes(16).toString('hex')
  const renderer = (origin: string) => makeSnapshotter({ origin, sessions: ctx.sessions, cache, cookieName: settings.session.cookieName, asSession: (sid) => ({ [AS_SESSION]: `${nonce}:${sid}` }) })
  if (!fe) snapshot = manifestSnapshot(ctx)
  else if (fe.origin) snapshot = renderer(fe.origin)
  else snapshot = async () => { throw new Error('no frontend origin yet: call listen() or pass frontend.origin') }
  // ponytail: in dev, discovery (/tvine/manifest, llms.txt) still lists the boot-time routes; agent paths and MCP are live
  const route = fe && opts.dev ? liveRouteMatcher(fe.nextDir) : routeMatcher(routes)
  say('runtime ready')

  // 4. mount: [discovery, channel, mcp, media, http] → frontend (in-process Next, or 404 for API-only)
  const sse = new Set<ServerResponse>()
  const isDev = process.env.NODE_ENV !== 'production'
  const feed = isDev ? inspectorFeed(ctx) : undefined   // tvine inspect's traffic log; never in production
  const channel = channelTransport({ sessions: ctx.sessions, channels: ctx.channels, settings, isDev, watchInspector: feed?.watch })
  const mcp = mcpHandler(ctx, { route })
  const media = mediaHandler(new DiskStorage(settings.media.dir, settings.media.route), settings.media.route)
  const fail = (res: ServerResponse) => (e: unknown) => {
    ctx.log('error', 'request failed', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
    if (!res.headersSent) res.writeHead(500).end(); else res.destroy()
  }
  const chain: Handler[] = [
    discoveryTransport({ settings, manifest: actions, routes, stats: () => ({ sessions: ctx.sessions.size }), startedAt: Date.now() }),
    (req, res, next) => {
      if (pathOf(req) !== '/tvine/channel') return next()
      sse.add(res)
      res.on('close', () => sse.delete(res))
      channel(req, res, next)
    },
    (req, res, next) => (pathOf(req) === '/mcp' ? void mcp(req, res).catch(fail(res)) : next()),
    (req, res, next) => void media(req, res, next).catch(fail(res)),
    httpTransport(ctx, { routes, match: route }),
  ]
  let next: Promise<{ app: NextApp; handle: ReturnType<NextApp['getRequestHandler']>; upgrade?: ReturnType<NonNullable<NextApp['getUpgradeHandler']>> }> | undefined
  const startNext = () => (next ??= (async () => {
    const factory = fe!.next ?? ((m: { default?: NextFactory } & NextFactory) => m.default ?? m)(await fromApp('next'))
    const app = factory({ dev: !!opts.dev, dir: dirname(resolve(fe!.nextDir)) })
    await app.prepare()
    return { app, handle: app.getRequestHandler(), upgrade: app.getUpgradeHandler?.() }
  })())
  const frontend: (req: IncomingMessage, res: ServerResponse) => void = fe
    ? (req, res) => { void startNext().then((n) => n.handle(req, res)).catch(fail(res)) }
    : (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found') }

  const handler: AgentServer['handler'] = (req, res, done) => {
    // for the human Form path: only OUR stamp is trusted (a client-sent one is replaced)
    const xff = (req.headers['x-forwarded-for'] as string | undefined) ?? null
    req.headers[STAMP] = `${nonce}:${httpsOf(req, settings) ? 1 : 0}:${clientIp(xff, req.socket.remoteAddress ?? '', settings.trustProxy)}`
    req.headers[URL_STAMP] = req.url ?? '/'
    if (sidFrom(req.headers[AS_SESSION], nonce) === undefined) delete req.headers[AS_SESSION]   // only our snapshotter's survives
    let i = 0
    const step = () => {
      const h = chain[i++]
      if (h) h(req, res, step)
      else if (done) done()
      else frontend(req, res)
    }
    try { step() } catch (e) { fail(res)(e) }
  }

  // human <Form> path + bind signer, for weft's server-side primitives; the previous ones come back on close
  const signer = (p: Record<string, unknown>) => signBind(p, settings)
  const src: FormSource = {
    nonce,
    headers: opts.headers ?? (async () => (await fromApp<{ headers(): Promise<HeadersLike> }>('next/headers')).headers()),
    cookies: opts.cookies ?? (async () => (await fromApp<{ cookies(): Promise<CookieJar> }>('next/headers')).cookies()),
  }
  const dispatcher = formDispatcher(ctx, route, src)
  const pages = pagesFor(ctx, route, src)
  const prev = { signer: g[SIGNER], dispatcher: g[DISPATCHER], actions: liveManifest(), pages: g[PAGES] }
  if (prev.dispatcher) say('WARNING: another tvine server already registered the <Form> dispatcher; this one replaces it until close()', 'warn')
  g[SIGNER] = signer
  g[DISPATCHER] = dispatcher
  setLiveManifest(actions)   // page bundles' copies of apps/ resolve ids and view defs through it
  g[PAGES] = pages

  // 5. session sweep; 6. server hygiene (SSE sets its own socket timeout to 0)
  const sweep = setInterval(() => ctx.sessions.sweep(), settings.session.ttlMs / 4)
  sweep.unref()
  const server = createServer((req, res) => handler(req, res))
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 65_000
  if (fe) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {   // Next HMR websocket
      void startNext().then((n) => (n.upgrade ? n.upgrade(req, socket, head) : void socket.destroy())).catch(() => socket.destroy())
    })
  }

  return {
    ctx, server, handler,
    async listen(port) {
      if (fe) await startNext()
      await new Promise<void>((ok, bad) => {
        server.once('error', bad)
        server.listen(port, () => { server.off('error', bad); ok() })
      })
      if (fe && !fe.origin) snapshot = renderer(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    },
    // stop accepting, drain SSE, clear intervals; in-flight requests get ≤ 4 s before sockets are cut
    async close() {
      clearInterval(sweep)
      feed?.close()
      ctx.close()
      if (g[SIGNER] === signer) g[SIGNER] = prev.signer
      if (g[DISPATCHER] === dispatcher) g[DISPATCHER] = prev.dispatcher
      if (liveManifest() === actions) setLiveManifest(prev.actions)
      if (g[PAGES] === pages) g[PAGES] = prev.pages
      for (const r of sse) r.end()
      if (server.listening) {
        await new Promise<void>((ok) => {
          const force = setTimeout(() => server.closeAllConnections(), 4_000)
          server.close(() => { clearTimeout(force); ok() })
          server.closeIdleConnections()
        })
      }
      if (next) await (await next.catch(() => undefined))?.app.close?.()
      await connections.closeAll()
    },
  }
}

// https per the same trusted hops as request.ip (transport/http.ts): socket TLS, or rightmost-trustProxy X-Forwarded-Proto.
function httpsOf(req: IncomingMessage, settings: Settings): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  return xfpHttps(req.headers['x-forwarded-proto'] as string | undefined, settings.trustProxy)
}
function xfpHttps(xfp: string | undefined, hops: number): boolean {
  if (hops <= 0) return false
  const parts = String(xfp ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - hops] === 'https'
}

// API-only: one node per app carrying its actions (no pages, so no binds).
function manifestSnapshot(ctx: ServerCtx): (page: string, sid: string) => Promise<Snapshot> {
  const byApp = new Map<string, ActionRef[]>()
  for (const d of ctx.actions.all()) {
    const app = d.id.slice(0, d.id.indexOf('.'))
    byApp.set(app, [...(byApp.get(app) ?? []), { id: d.id, params: ctx.actions.paramSpecs(d.id), bind: '' }])
  }
  const nodes: Node[] = [...byApp].map(([app, refs]) => ({ id: `app:${app}`, type: 'app', data: { name: app }, actions: refs }))
  return async (page, sid) => ({ page, title: ctx.settings.site.name, sid, rev: ctx.sessions.peek({ sid })?.rev ?? 0, nodes, links: [] })
}

export interface FormSource {
  headers: () => HeadersLike | Promise<HeadersLike>
  cookies: () => CookieJar | Promise<CookieJar>
  nonce?: string   // the boot nonce our handler stamps into x-tvine-ip
}

// The human <Form> server action → the same dispatch() agents use, with a Request built from the incoming
// Next headers: the page (referer) must be a guarded-ok route, the cookie picks (or now creates) the session,
// origin/host feed dispatch's cross-origin check. No snapshot is rendered (formResult never reads it).
export function formDispatcher(server: ServerCtx, route: (path: string) => string | undefined, src: FormSource): (cmd: Command) => Promise<FormResult> {
  const { settings, sessions } = server
  const name = settings.session.cookieName
  let warned = false
  return async (cmd) => {
    const h: Record<string, string> = Object.fromEntries(await src.headers())
    // Referrer-Policy: no-referrer hides the page: fail safe, but say why
    if (!h.referer) return { ok: false, message: 'Form submit needs a Referer header — check Referrer-Policy' }
    let path: string | undefined
    try { path = new URL(h.referer).pathname } catch { /* refused below */ }
    const pattern = path === undefined ? undefined : route(path)
    if (path === undefined || pattern === undefined) return { ok: false, message: 'forbidden: the referer is not a page of this site' }
    let { ip, secure } = stampOf(h, settings, src.nonce)
    if (!ip) {
      ip = 'unknown'
      if (!warned) { warned = true; server.log('warn', '<Form> request did not pass through the tvine handler and trustProxy is 0: all such submits share one rate-limit key') }
    }
    const jar = await src.cookies()
    let cookie = jar.get(name)?.value
    const request = await buildRequest({ url: path, route: pattern, headers: h, ip, via: 'human' }, settings)
    if (!(await guardCheck(settings)(decodeURIComponent(path), request, sessions.peek({ cookie })))) return { ok: false, message: FORBIDDEN_ROUTE }
    if (!sessions.peek({ cookie })) {
      // a refused request creates no session and sets no cookie: dispatch's own origin + ip checks, run first.
      // ponytail: dispatch charges the ip bucket again, so a session's first submit costs 2 tokens
      if (crossOrigin(request, settings)) return formResult([ev.err('domain', 'forbidden: cross-origin request', { reason: 'forbidden' })])
      const rl = server.limiter.check({ ip: request.ip })
      if (!rl.ok) return formResult([rateLimited(rl.retryAfterMs)])
      cookie = sessions.cookieFor(sessions.create().sid)
      // the same attributes as transport/http.ts sets on its session cookie
      jar.set(name, cookie, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(settings.session.ttlMs / 1000) })
      const others = (h.cookie ?? '').split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${name}=`))
      const header = [...others, `${name}=${cookie}`].join('; ')
      const base = request.headers
      request.headers = { get: (n) => (n.toLowerCase() === 'cookie' ? header : base.get(n)) }
    }
    return formResult(await collect(dispatch(cmd, server, request, { snapshot: false })))
  }
}

// ip + https: our handler's stamp; without it, trusted X-Forwarded-* hops ('' = unknown ip)
function stampOf(h: Record<string, string>, settings: Settings, nonce: string | undefined): { ip: string; secure: boolean; own: boolean } {
  const stamp = /^([^:]*):([01]):(.*)$/.exec(h[STAMP] ?? '')
  const own = stamp !== null && nonce !== undefined && sameNonce(stamp[1]!, nonce)
  if (own) return { ip: stamp[3]!, secure: stamp[2] === '1', own }
  return { ip: settings.trustProxy > 0 ? clientIp(h['x-forwarded-for'] ?? null, '', settings.trustProxy) : '', secure: xfpHttps(h['x-forwarded-proto'], settings.trustProxy), own }
}
const sameNonce = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
function sidFrom(v: string | string[] | undefined, nonce: string | undefined): string | undefined {
  const i = typeof v === 'string' ? v.indexOf(':') : -1
  return nonce !== undefined && i > 0 && sameNonce((v as string).slice(0, i), nonce) ? (v as string).slice(i + 1) || undefined : undefined
}

// currentSession() / currentRequest() for the page Next is rendering right now.
function pagesFor(server: ServerCtx, route: (path: string) => string | undefined, src: FormSource): PageAccess {
  const { settings, sessions } = server
  const read = async () => {
    const h: Record<string, string> = Object.fromEntries(await src.headers())
    return { h, sid: sidFrom(h[AS_SESSION], src.nonce) }
  }
  return {
    async session() {
      const { sid } = await read()
      if (sid !== undefined) return sessions.resolve({ sid })
      const cookie = (await src.cookies()).get(settings.session.cookieName)?.value
      return cookie === undefined ? undefined : sessions.resolve({ cookie })
    },
    async request() {
      const { h, sid } = await read()
      const st = stampOf(h, settings, src.nonce)
      const url = st.own ? h[URL_STAMP] ?? '/' : '/'
      const path = new URL(url, 'http://tvine.local').pathname
      const request = await buildRequest({ url, route: route(path) ?? path, headers: h, ip: st.ip || 'unknown', via: 'human' }, settings)
      // ponytail: an agent's render says http even when the agent came through MCP (the snapshotter does not know)
      if (sid !== undefined) request.agent = { is: true, via: 'http' }
      return request
    },
  }
}
