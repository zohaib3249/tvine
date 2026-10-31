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
import { appSignals, discoverHooks, discoverMiddleware } from './core/middleware.js'
import { makeSnapshotter } from './core/registry.js'
import { backendHealth, backendTable, snapshotCacheFor } from './backends/index.js'
import { authenticate, rotatedSession } from './core/auth.js'
import { buildRequest, clientIp } from './core/request.js'
import type { ActionRef, Command, Node, Request, Session, Settings, Snapshot } from './core/types.js'
import { connections } from './data/db.js'
import { dataVersion } from './data/engine.js'
import { DiskStorage, mediaHandler } from './media/index.js'
import { cspReportHandler, nextBuildWarnings, securityHeaders } from './security/headers.js'
import { signBind } from './security/sign.js'
import { checkBackends, defineSettings, merge, type SettingsInput } from './settings.js'
import { closeRedis, configureRedis } from './redis/index.js'
import { channelTransport } from './transport/channel.js'
import { addVary, hookResponse, weakIfNoneMatch } from './transport/compress.js'
import { corsLayer } from './transport/cors.js'
import { discoveryTransport, loadNextRoutes, type RouteInfo } from './transport/discovery.js'
import { FORBIDDEN_ROUTE, guardCheck } from './transport/guards.js'
import { apiTransport, invoke, type ApiCall, type ApiResult } from './transport/api.js'
import { httpTransport } from './transport/http.js'
import { mcpHandler } from './transport/mcp.js'
import { TabHub, tabTransport } from './transport/tab.js'
import { inspectorFeed, widgetsTransport } from './transport/inspector.js'
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
const API = Symbol.for('tvine.api')   // @tvine/weft/api's in-process transport
const g = globalThis as Record<symbol, unknown>
const API_ROUTES: RouteInfo[] = [{ path: '/' }]
const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?')[0]!
const STAMP = 'x-tvine-ip'   // `<boot nonce>:<https 0|1>:<socket ip per trustProxy>`, set by our handler only
const URL_STAMP = 'x-tvine-url'   // the request url, set by our handler only (trusted with a valid STAMP)
const AS_SESSION = 'x-tvine-session'   // `<boot nonce>:<render token>:<sid>`: an agent's snapshot render runs as that agent's session

// Server components: the session / request of the page being rendered (the cookie via next/headers, or
// the agent's session during its snapshot render). On globalThis: pages run in Next's bundled copy of warp.
export interface PageAccess { session(): Promise<Session | undefined>; request(): Promise<Request> }
function pageAccess(): PageAccess {
  const a = g[PAGES] as PageAccess | undefined
  if (!a) throw new Error('currentSession()/currentRequest(): no tvine server in this process (run the app with tvine start or tvine dev), or this page is being prerendered at build: make it dynamic (await connection())')
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
  const settings = defineSettings(merge(base as Record<string, unknown>, over) as SettingsInput)
  void settings.secret   // boot is where a missing/short secret fails (defineSettings defers it past import)
  checkBackends(settings)   // a 'redis' backend without its settings.redis connection fails here, naming the key
  return settings
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
  const local = backendTable(settings).filter((r) => r.backend === 'memory').map((r) => r.key)
  if ((process.env.NODE_APP_INSTANCE || process.env.pm_id || Number(process.env.WEB_CONCURRENCY) > 1) && local.length) {
    say(`WARNING: multi-instance run detected but ${local.join(', ')} ${local.length > 1 ? 'are' : 'is'} 'memory' (per process): set them to 'redis' (docs/design/conventions/backends.md)`, 'warn')
  }

  // 2. discover: duplicate/invalid actions fail here, naming the file, never at request time
  const appsDir = resolve(opts.appsDir ?? 'apps')
  if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
  const installed = settings.installedApps
  const actions = await discover(appsDir, { rate: settings.limits.rate, installed })
  const appMiddleware = await discoverMiddleware(appsDir, installed)
  const appHooks = await discoverHooks(appsDir, installed)
  const signals = await appSignals(appsDir, installed)
  const fe = opts.frontend
  const routes = fe ? loadNextRoutes(fe.nextDir) : API_ROUTES
  // dev: `next dev` writes the manifest as pages compile, so an empty table is fine (re-read live below)
  if (fe && !routes.length && !opts.dev) throw new Error(`no routes in ${join(fe.nextDir, 'app-path-routes-manifest.json')} (run next build)`)
  say(`discovered ${actions.all().length} actions, ${routes.length} routes`)
  if (fe && !opts.dev) for (const w of nextBuildWarnings(fe.nextDir, settings)) say(`WARNING: ${w}`, 'warn')
  if (!actions.all().length && process.env.NODE_ENV === 'production') {
    say(`WARNING: no actions found under ${appsDir} (apps/<app>/views.ts, .js or .mjs); agents will see pages with nothing to do`, 'warn')
  }

  // 3. sessions, limiter, idempotency (serverCtx), snapshot cache + snapshotter
  connections.configure(settings)
  configureRedis(settings, (level, msg, data) => say(data ? `${msg} ${JSON.stringify(data)}` : msg, level === 'error' ? 'warn' : level))
  let snapshot: (route: string, sid: string) => Promise<Snapshot>
  const ctx = serverCtx({ actions, settings, appMiddleware, appsDir, snapshot: (route, sid) => snapshot(route, sid) })
  for (const [name, fn] of appHooks) ctx.hooks.on(name, fn as never)
  // AppConfig.ready(): each app's hooks.ts ready(server), awaited, in installed-app order (contrib auth installs its backend here)
  for (const { app, fn } of signals.ready) {
    try { await (fn as (s: ServerCtx) => unknown)(ctx) } catch (e) { ctx.close(); throw new Error(`app ${app}: ready() failed: ${(e as Error).message}`, { cause: e }) }
  }
  const cache = snapshotCacheFor(settings, dataVersion, ctx.log)
  if (cache.settle) ctx.settle = () => cache.settle!()
  if (cache.close) ctx.onClose(() => cache.close!())
  ctx.health.set('backends', () => backendHealth(settings))
  // a shared channel layer must be subscribed before the first event it should deliver
  if ('ready' in ctx.channels) await (ctx.channels as { ready: Promise<void> }).ready
  const nonce = randomBytes(16).toString('hex')
  // C2: a render whose page read the agent's session (currentSession/currentRequest) is personal, whatever
  // its fragments say: the page marks its per-render token in `touched`, the snapshotter checks it after extract.
  const tokens = renderTokens()
  const renderer = (origin: string) => makeSnapshotter({
    origin, sessions: ctx.sessions, cache, cookieName: settings.session.cookieName,
    route: (p) => route(p),   // redirect targets must be routed pages (defined below; called per render)
    asSession: (sid) => {
      const token = tokens.start()
      return { headers: { [AS_SESSION]: `${nonce}:${token}:${sid}` }, readSession: () => tokens.end(token) }
    },
  })
  if (!fe) snapshot = manifestSnapshot(ctx)
  else if (fe.origin) snapshot = renderer(fe.origin)
  else snapshot = async () => { throw new Error('no frontend origin yet: call listen() or pass frontend.origin') }
  // ponytail: in dev, discovery (/tvine/manifest, llms.txt) still lists the boot-time routes; agent paths and MCP are live
  const route = fe && opts.dev ? liveRouteMatcher(fe.nextDir) : routeMatcher(routes)
  ctx.route = route
  say('runtime ready')

  // 4. mount: [discovery, channel, mcp, media, http] → frontend (in-process Next, or 404 for API-only)
  const sse = new Set<ServerResponse>()
  const isDev = process.env.NODE_ENV !== 'production'
  const feed = isDev ? inspectorFeed(ctx) : undefined   // tvine inspect's traffic log; never in production
  // tab control is ON in production too (security.md): settings.agent.inTab='off' is the app's opt-out
  const tabs = new TabHub(ctx)
  ctx.tabs = tabs
  const channel = channelTransport({ sessions: ctx.sessions, channels: ctx.channels, settings, isDev, watchInspector: feed?.watch, tabs })
  const mcp = mcpHandler(ctx, { route, tabs })
  const media = mediaHandler(new DiskStorage(settings.media.dir, settings.media.route), settings.media.route)
  const fail = (res: ServerResponse) => (e: unknown) => {
    ctx.log('error', 'request failed', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
    if (!res.headersSent) res.writeHead(500).end(); else res.destroy()
  }
  // security/headers + transport/cors + transport/compress (server/security-headers.md): boot-checked here
  const sec = securityHeaders(settings, { isDev })
  const cors = corsLayer(settings)
  const chain: Handler[] = [
    ...(sec.reportsHere ? [cspReportHandler(settings, ctx.log)] : []),
    discoveryTransport({ settings, manifest: actions, routes, stats: () => ({ sessions: ctx.sessions.size, extra: healthSections(ctx) }), startedAt: Date.now() }),
    (req, res, next) => {
      if (pathOf(req) !== '/tvine/channel') return next()
      sse.add(res)
      res.on('close', () => sse.delete(res))
      channel(req, res, next)
    },
    (req, res, next) => (pathOf(req) === '/mcp' ? void mcp(req, res).catch(fail(res)) : next()),
    ...(feed ? [widgetsTransport(feed)] : []),   // W10 inspector Widgets tab; dev only, like the feed
    tabTransport(ctx, tabs),
    (req, res, next) => void media(req, res, next).catch(fail(res)),
    apiTransport(ctx, { route, tokens, asSession: (v) => internalOf(v, nonce) }),
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

  // the paths this server itself answers (embedded mode hands everything else to the host app)
  const mediaRoot = settings.media.route.replace(/\/$/, '')
  const ownPath = (p: string) => p === '/mcp' || p.startsWith('/tvine/') || p === '/.well-known/tvine.json' || p === '/llms.txt' ||
    p === mediaRoot || p.startsWith(`${mediaRoot}/`) || route(p.replace(/\/agent\.(json|txt)$/, '') || '/') !== undefined
  const handler: AgentServer['handler'] = (req, res, done) => {
    let i = 0
    let unhook = () => {}
    const step = () => {
      const h = chain[i++]
      if (h) h(req, res, step)
      else if (done) { unhook(); done() }   // the host app's response: its own headers
      else frontend(req, res)
    }
    // nothing a client sends may throw out of here (a throw in a 'request' listener kills the process)
    try {
      // for the human Form path: only OUR stamp is trusted (a client-sent one is replaced)
      const xff = (req.headers['x-forwarded-for'] as string | undefined) ?? null
      req.headers[STAMP] = `${nonce}:${httpsOf(req, settings) ? 1 : 0}:${clientIp(xff, req.socket.remoteAddress ?? '', settings.trustProxy)}`
      req.headers[URL_STAMP] = req.url ?? '/'
      if (internalOf(req.headers[AS_SESSION], nonce) === undefined) delete req.headers[AS_SESSION]   // only our snapshotter's survives
      // embedded: CORS only for paths this server answers; the host app's own paths are the host's business
      const ours = !done || ownPath(pathOf(req))
      if (ours && cors.preflight(req, res)) return
      const corsPlan = ours ? cors.request(req) : undefined
      const plan = sec.begin(req, httpsOf(req, settings))
      weakIfNoneMatch(req)
      // a real node response only (a test double without header methods is passed through untouched)
      if (typeof res.getHeader === 'function') {
        unhook = hookResponse(req, res, {
          compression: settings.compression,
          onHeaders: () => {
            sec.apply(res, plan)
            if (corsPlan) {   // a CORS route: Vary: Origin always, the allow headers only for an allowed origin
              for (const [k, v] of Object.entries(corsPlan.headers)) res.setHeader(k, v)
              if (corsPlan.dropSetCookie) res.removeHeader('set-cookie')   // no cookie went in: none comes back
              addVary(res, 'Origin')
            }
          },
        })
      }
      step()
    } catch (e) { fail(res)(e) }
  }

  // human <Form> path + bind signer, for weft's server-side primitives; the previous ones come back on close
  const signer = (p: Record<string, unknown>) => signBind(p, settings)
  const src: FormSource = {
    nonce,
    headers: opts.headers ?? (async () => (await fromApp<{ headers(): Promise<HeadersLike> }>('next/headers')).headers()),
    cookies: opts.cookies ?? (async () => (await fromApp<{ cookies(): Promise<CookieJar> }>('next/headers')).cookies()),
  }
  const dispatcher = formDispatcher(ctx, route, src)
  const pages = pagesFor(ctx, route, src, tokens)
  const api = apiFor(ctx, route, src, tokens)
  const prev = { signer: g[SIGNER], dispatcher: g[DISPATCHER], actions: liveManifest(), pages: g[PAGES], api: g[API] }
  if (prev.dispatcher) say('WARNING: another tvine server already registered the <Form> dispatcher; this one replaces it until close()', 'warn')
  g[SIGNER] = signer
  g[DISPATCHER] = dispatcher
  setLiveManifest(actions)   // page bundles' copies of apps/ resolve ids and view defs through it
  g[PAGES] = pages
  g[API] = api

  // 5. session sweep; 6. server hygiene (SSE sets its own socket timeout to 0)
  const sweep = setInterval(() => void ctx.sessions.sweep().catch((e: unknown) => ctx.log('error', 'session sweep failed', { error: String(e) })), settings.session.ttlMs / 4)
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
      tabs.close()
      ctx.close()
      if (g[SIGNER] === signer) g[SIGNER] = prev.signer
      if (g[DISPATCHER] === dispatcher) g[DISPATCHER] = prev.dispatcher
      if (liveManifest() === actions) setLiveManifest(prev.actions)
      if (g[PAGES] === pages) g[PAGES] = prev.pages
      if (g[API] === api) g[API] = prev.api
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
      await closeRedis()
    },
  }
}

// apps' /tvine/health sections (ServerCtx.health); a failing one reports itself, never fails health
function healthSections(ctx: ServerCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, fn] of ctx.health) {
    try { out[name] = fn() } catch (e) { out[name] = { error: (e as Error).message } }
  }
  return out
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
  return async (page, sid) => ({ page, title: ctx.settings.site.name, sid, rev: (await ctx.sessions.peek({ sid }))?.rev ?? 0, nodes, links: [] })
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
    if (!(await guardCheck(settings)(decodeURIComponent(path), request, await sessions.peek({ cookie })))) return { ok: false, message: FORBIDDEN_ROUTE }
    if (!(await sessions.peek({ cookie }))) {
      // a refused request creates no session and sets no cookie: dispatch's own origin + ip checks, run first.
      // ponytail: dispatch charges the ip bucket again, so a session's first submit costs 2 tokens
      if (crossOrigin(request, settings)) return formResult([ev.err('domain', 'forbidden: cross-origin request', { reason: 'forbidden' })])
      const rl = await server.limiter.check({ ip: request.ip })
      if (!rl.ok) return formResult([rateLimited(rl.retryAfterMs)])
      cookie = await sessions.cookieFor((await sessions.create()).sid)
      // the same attributes as transport/http.ts sets on its session cookie
      jar.set(name, cookie, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(settings.session.ttlMs / 1000) })
      const others = (h.cookie ?? '').split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${name}=`))
      const header = [...others, `${name}=${cookie}`].join('; ')
      const base = request.headers
      request.headers = { get: (n) => (n.toLowerCase() === 'cookie' ? header : base.get(n)) }
    }
    const out = formResult(await collect(dispatch(cmd, server, request, { snapshot: false })))
    const rotated = rotatedSession(request)   // login/logout: the old cookie is dead, hand out the new one
    if (rotated) jar.set(name, await sessions.cookieFor(rotated.sid), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(settings.session.ttlMs / 1000) })
    return out
  }
}

// ip + https: our handler's stamp; without it, trusted X-Forwarded-* hops ('' = unknown ip)
function stampOf(h: Record<string, string>, settings: Settings, nonce: string | undefined): { ip: string; secure: boolean; own: boolean } {
  const stamp = /^([^:]*):([01]):(.*)$/.exec(h[STAMP] ?? '')
  const own = stamp !== null && nonce !== undefined && sameNonce(stamp[1]!, nonce)
  if (own) return { ip: stamp[3]!, secure: stamp[2] === '1', own }
  return { ip: settings.trustProxy > 0 ? clientIp(h['x-forwarded-for'] ?? null, '', settings.trustProxy) : '', secure: xfpHttps(h['x-forwarded-proto'], settings.trustProxy), own }
}
// Byte lengths, not string lengths: a latin1 header char is 2 utf8 bytes and timingSafeEqual throws on a mismatch.
const sameNonce = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
// `<nonce>:<token>:<sid>` from our snapshotter, else undefined
function internalOf(v: string | string[] | undefined, nonce: string | undefined): { token: string; sid: string } | undefined {
  const m = typeof v === 'string' ? /^([^:]+):([^:]+):(.+)$/.exec(v) : null
  return m && nonce !== undefined && sameNonce(m[1]!, nonce) ? { token: m[2]!, sid: m[3]! } : undefined
}

// currentSession() / currentRequest() for the page Next is rendering right now.
// Per agent render: start() → token; read(token) when the page reads the session; end(token) → did it?
// Only a render still awaited is marked, so a page that finishes after a timeout leaves nothing behind.
export function renderTokens() {
  const pending = new Set<string>(), touched = new Set<string>()
  return {
    start() { const t = randomBytes(12).toString('hex'); pending.add(t); return t },
    read(t: string) { if (pending.has(t)) touched.add(t) },
    end(t: string) { pending.delete(t); return touched.delete(t) },
    get size() { return pending.size + touched.size },
  }
}

function pagesFor(server: ServerCtx, route: (path: string) => string | undefined, src: FormSource, tokens: ReturnType<typeof renderTokens>): PageAccess {
  const { settings, sessions } = server
  const read = async () => {
    const h: Record<string, string> = Object.fromEntries(await src.headers())
    const own = internalOf(h[AS_SESSION], src.nonce)
    if (own) tokens.read(own.token)   // this agent render depends on its session: never cache it
    return { h, sid: own?.sid }
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
      const shown = Object.fromEntries(Object.entries(h).filter(([k]) => !k.toLowerCase().startsWith('x-tvine-')))   // no stamps / nonce material
      const request = await buildRequest({ url, route: route(path) ?? path, headers: shown, ip: st.ip || 'unknown', via: 'human' }, settings)
      // ponytail: an agent's render says http even when the agent came through MCP (the snapshotter does not know)
      if (sid !== undefined) request.agent = { is: true, via: 'http' }
      const cookie = sid === undefined ? (await src.cookies()).get(settings.session.cookieName)?.value : undefined
      await authenticate(settings, request, await sessions.peek({ sid, cookie }))   // request.user of the page's session
      return request
    },
  }
}

// @tvine/weft/api in one process: a server component / server action calls dispatch() as the page's request.
// An agent's snapshot render runs as the agent (x-tvine-session); a request with `next-action` is a server
// action (may mutate, may create the session cookie); anything else is a render (read actions only).
// ponytail: `next-action` is how Next marks server-action POSTs; a client faking it only affects its own render
export function apiFor(server: ServerCtx, route: (path: string) => string | undefined, src: FormSource, tokens: { read(t: string): void }): (call: ApiCall) => Promise<ApiResult> {
  const { settings, sessions } = server
  const name = settings.session.cookieName
  return async (call) => {
    const h: Record<string, string> = Object.fromEntries(await src.headers())
    const own = internalOf(h[AS_SESSION], src.nonce)
    if (own) tokens.read(own.token)   // C2: this agent render read its session
    const st = stampOf(h, settings, src.nonce)
    const url = st.own ? h[URL_STAMP] ?? '/' : '/'
    const path = new URL(url, 'http://tvine.local').pathname
    const shown = Object.fromEntries(Object.entries(h).filter(([k]) => !k.toLowerCase().startsWith('x-tvine-')))
    const request = await buildRequest({ url, route: route(path) ?? path, headers: shown, ip: st.ip || 'unknown', via: 'human' }, settings)
    if (own) {
      request.agent = { is: true, via: 'http' }
      return invoke(server, call, { request, sid: own.sid, mode: 'render' })
    }
    const jar = await src.cookies()
    const action = h['next-action'] !== undefined
    return invoke(server, call, {
      request, cookie: jar.get(name)?.value, mode: action ? 'action' : 'render',
      mint: async (s) => { jar.set(name, await sessions.cookieFor(s.sid), { httpOnly: true, sameSite: 'lax', secure: st.secure, path: '/', maxAge: Math.floor(settings.session.ttlMs / 1000) }) },
    })
  }
}
