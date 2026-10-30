// createAgentServer — the composition root (docs/design/server/server-index.md). The only file allowed
// to import across layers. Modes: standalone (listen), embedded (handler), API-only (no frontend).
import { existsSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collect, dispatch, formResult, serverCtx, type FormResult, type ServerCtx } from './core/dispatch.js'
import { makeSnapshotter, SnapshotCache } from './core/registry.js'
import { buildRequest, clientIp } from './core/request.js'
import type { ActionRef, Command, Node, Settings, Snapshot } from './core/types.js'
import { connections } from './data/db.js'
import { DiskStorage, mediaHandler } from './media/index.js'
import { signBind } from './security/sign.js'
import { defineSettings, merge, type SettingsInput } from './settings.js'
import { channelTransport } from './transport/channel.js'
import { discoveryTransport, loadNextRoutes, type RouteInfo } from './transport/discovery.js'
import { httpTransport } from './transport/http.js'
import { mcpHandler } from './transport/mcp.js'
import { routeMatcher } from './transport/routes.js'
import { discover } from './views/discover.js'

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void
export type HeadersLike = Iterable<[string, string]>   // a fetch Headers, or Next's headers()

export interface AgentServerOptions {
  settings?: SettingsInput & { secret?: string | string[] }   // merged over ./settings.ts (cwd), then defaults
  appsDir?: string                                             // default './apps'
  frontend?: { nextDir: string; origin?: string }              // the .next dir; origin = where pages render (embedded)
  dev?: { proxy: string }                                      // proxy human traffic to `next dev`
  headers?: () => HeadersLike | Promise<HeadersLike>           // human Form path; default next/headers
}
export interface AgentServer {
  listen(port: number): Promise<void>
  handler: (req: IncomingMessage, res: ServerResponse, next?: () => void) => void
  ctx: ServerCtx
  server: Server
  close(): Promise<void>
}

// weft stores these on globalThis (Next builds several module graphs); warp never imports weft.
const SIGNER = Symbol.for('tvine.signer'), DISPATCHER = Symbol.for('tvine.dispatcher')
const g = globalThis as Record<symbol, unknown>
const API_ROUTES: RouteInfo[] = [{ path: '/' }]
const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?')[0]!

export async function loadSettings(over: AgentServerOptions['settings'] = {}): Promise<Settings> {
  const file = ['settings.ts', 'settings.js'].map((f) => resolve(f)).find(existsSync)
  const base = file ? ((await import(pathToFileURL(file).href)) as { default: Settings }).default : {}
  return defineSettings(merge({ secret: process.env.TVINE_SECRET, ...base }, over) as SettingsInput)
}

export async function createAgentServer(opts: AgentServerOptions = {}): Promise<AgentServer> {
  // 1. settings (zod; missing TVINE_SECRET in prod throws)
  const settings = await loadSettings(opts.settings)
  const say = (msg: string, level: 'info' | 'warn' = 'info') => {
    if (settings.logging === 'none') return
    console[level === 'info' ? 'log' : 'warn'](settings.logging === 'json' ? JSON.stringify({ level, msg }) : `tvine: ${msg}`)
  }
  say('settings ok')
  if (process.env.NODE_APP_INSTANCE || process.env.pm_id || Number(process.env.WEB_CONCURRENCY) > 1) {
    say('WARNING: multi-instance run detected; sessions, limits and channels are in-process in v1 — run exactly one process', 'warn')
  }

  // 2. discover: duplicate/invalid actions fail here, naming the file, never at request time
  const appsDir = resolve(opts.appsDir ?? 'apps')
  if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
  const actions = await discover(appsDir, { rate: settings.limits.rate })
  const routes = opts.frontend ? loadNextRoutes(opts.frontend.nextDir) : API_ROUTES
  if (opts.frontend && !routes.length) throw new Error(`no routes in ${join(opts.frontend.nextDir, 'app-path-routes-manifest.json')} (run next build)`)
  say(`discovered ${actions.all().length} actions, ${routes.length} routes`)

  // 3. sessions, limiter, idempotency (serverCtx), snapshot cache + snapshotter
  connections.configure(settings)
  let snapshot: (route: string, sid: string) => Promise<Snapshot>
  // Task 19b seam: pass `appMiddleware: await discoverMiddleware(appsDir)` here once core/middleware.ts lands
  const ctx = serverCtx({ actions, settings, snapshot: (route, sid) => snapshot(route, sid) })
  const cache = new SnapshotCache()
  const renderer = (origin: string) => makeSnapshotter({ origin, sessions: ctx.sessions, cache, cookieName: settings.session.cookieName })
  const apiOnly = !opts.frontend && !opts.dev
  const origin = opts.dev?.proxy ?? opts.frontend?.origin
  if (apiOnly) snapshot = manifestSnapshot(ctx)
  else if (origin) snapshot = renderer(origin)
  else snapshot = async () => { throw new Error('no frontend origin yet: call listen() or pass frontend.origin') }
  const route = routeMatcher(routes)
  say('runtime ready')

  // 4. mount: [discovery, channel, mcp, media, http] → frontend (Next / dev proxy / 404)
  const sse = new Set<ServerResponse>()
  const channel = channelTransport({ sessions: ctx.sessions, channels: ctx.channels, settings, isDev: process.env.NODE_ENV !== 'production' })
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
    httpTransport(ctx, { routes }),
  ]
  let next: Promise<NextApp> | undefined
  const frontend: (req: IncomingMessage, res: ServerResponse) => void =
    opts.dev ? proxy(opts.dev.proxy)
    : opts.frontend ? (req, res) => { void (next ??= nextApp(opts.frontend!.nextDir)).then((a) => a.getRequestHandler()(req, res)).catch(fail(res)) }
    : (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found') }

  const handler: AgentServer['handler'] = (req, res, done) => {
    // the socket ip for the human Form path (overwrites any client-sent value)
    req.headers['x-tvine-ip'] = clientIp((req.headers['x-forwarded-for'] as string | undefined) ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
    let i = 0
    const step = () => {
      const h = chain[i++]
      if (h) h(req, res, step)
      else if (done) done()
      else frontend(req, res)
    }
    try { step() } catch (e) { fail(res)(e) }
  }

  // human <Form> path + bind signer, for weft's server-side primitives
  const signer = (p: Record<string, unknown>) => signBind(p, settings)
  const dispatcher = formDispatcher(ctx, route, opts.headers ?? nextHeaders)
  g[SIGNER] = signer
  g[DISPATCHER] = dispatcher

  // 5. session sweep; 6. server hygiene (SSE sets its own socket timeout to 0)
  const sweep = setInterval(() => ctx.sessions.sweep(), settings.session.ttlMs / 4)
  sweep.unref()
  const server = createServer((req, res) => handler(req, res))
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 65_000

  return {
    ctx, server, handler,
    async listen(port) {
      if (opts.frontend && !opts.dev) await (next ??= nextApp(opts.frontend.nextDir))
      await new Promise<void>((ok, bad) => {
        server.once('error', bad)
        server.listen(port, () => { server.off('error', bad); ok() })
      })
      const { port: real } = server.address() as { port: number }
      if (!apiOnly && !origin) snapshot = renderer(`http://127.0.0.1:${real}`)
    },
    // stop accepting, drain SSE, clear intervals; in-flight requests get ≤ 4 s before sockets are cut
    async close() {
      clearInterval(sweep)
      if (g[SIGNER] === signer) delete g[SIGNER]
      if (g[DISPATCHER] === dispatcher) delete g[DISPATCHER]
      for (const r of sse) r.end()
      if (server.listening) {
        await new Promise<void>((ok) => {
          const force = setTimeout(() => server.closeAllConnections(), 4_000)
          server.close(() => { clearTimeout(force); ok() })
          server.closeIdleConnections()
        })
      }
      if (next) await (await next.catch(() => undefined))?.close?.()
      await connections.closeAll()
    },
  }
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

// The human <Form> server action → the same dispatch() agents use, with a Request built from the
// incoming Next headers (cookie picks the session, origin/host feed the cross-origin check).
export function formDispatcher(server: ServerCtx, route: (path: string) => string | undefined,
  headers: () => HeadersLike | Promise<HeadersLike>): (cmd: Command) => Promise<FormResult> {
  return async (cmd) => {
    const h: Record<string, string> = Object.fromEntries(await headers())
    let path = '/'
    try { path = new URL(h.referer ?? '/', 'http://x').pathname } catch { /* '/' */ }
    if (route(path) === undefined) path = '/'
    // ponytail: without our handler in front (x-tvine-ip), XFF's rightmost entry is client-settable when trustProxy=0
    const ip = h['x-tvine-ip'] || clientIp(h['x-forwarded-for'] ?? null, '0.0.0.0', server.settings.trustProxy || 1)
    const request = await buildRequest({ url: path, route: route(path) ?? path, headers: h, ip, isAgent: false }, server.settings)
    request.agent = { is: false, via: 'human', client: h['user-agent'] }
    return formResult(await collect(dispatch(cmd, server, request)))
  }
}

// Resolved from the app (warp does not depend on next); Next's request storage is process-shared.
const nextHeaders = async (): Promise<HeadersLike> =>
  (createRequire(join(process.cwd(), 'package.json'))('next/headers') as { headers(): Promise<HeadersLike> }).headers()

interface NextApp { prepare(): Promise<void>; getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>; close?(): Promise<void> }
async function nextApp(nextDir: string): Promise<NextApp> {
  let next: (o: { dev: boolean; dir: string }) => NextApp
  try {
    const m = createRequire(join(process.cwd(), 'package.json'))('next')
    next = m.default ?? m
  } catch { throw new Error(`frontend.nextDir is set but the "next" package cannot be found from ${process.cwd()}`) }
  const app = next({ dev: false, dir: dirname(resolve(nextDir)) })
  await app.prepare()
  return app
}

// ponytail: plain HTTP pipe; no websocket upgrade, so `next dev` HMR needs its own port.
function proxy(target: string): (req: IncomingMessage, res: ServerResponse) => void {
  const t = new URL(target)
  return (req, res) => {
    const up = httpRequest({ hostname: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end() })
    req.pipe(up)
  }
}
