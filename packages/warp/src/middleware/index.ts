// HTTP middleware — Django MIDDLEWARE for every request (docs/design/conventions/middleware-hooks.md).
// settings.middleware lists them, outermost first; ONLY listed ones run. Each sees the request on the way in
// (processRequest / process before next()) and the response headers on the way out (processResponse, run at the
// moment headers are sent, innermost first, Django order). An ended response short-circuits: inner middleware and
// the transports never run, and only the middleware it already passed see its headers.
import { BlockList, isIP } from 'node:net'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requestId } from '../core/request.js'
import { securityEvent } from '../core/audit.js'
import type { CompressionSettings, Settings, TvineUser } from '../core/types.js'
import type { Logger } from '../log.js'
import { limiterFor } from '../backends/index.js'
import { addVary } from '../transport/compress.js'
import type { securityHeaders } from '../security/headers.js'
import type { corsLayer } from '../transport/cors.js'

// Per-request state the runner puts on req.tvine
export interface RequestState {
  path: string                       // without the query
  ip: string                         // per settings.trustProxy
  https: boolean                     // per settings.trustProxy (X-Forwarded-Proto)
  host?: string                      // the validated Host (AllowedHosts), lowercase, no port
  id?: string                        // RequestId
  locale?: string                    // Locale
  start: number                      // performance.now() at arrival
  ours: boolean                      // false: embedded mode and the host app answers this path
  compression: CompressionSettings | false   // GZip turns it on
  onHeaders(fn: () => void): void    // run right before the status line + headers go out
  log: Logger                        // tvine.request, bound to the request id
}
export type MwRequest = IncomingMessage & { tvine: RequestState }
type Maybe<T> = T | Promise<T>

export interface HttpMiddleware {
  name: string
  // around style (Koa / Express): next() resolves when the response has finished (or the client went away)
  process?(req: MwRequest, res: ServerResponse, next: () => Promise<void>): Maybe<void>
  // Django hooks. processRequest: end the response to short-circuit. processResponse: at header time, sync.
  processRequest?(req: MwRequest, res: ServerResponse): Maybe<void>
  processResponse?(req: MwRequest, res: ServerResponse): void
  // an error thrown by this or an inner middleware: return true when you answered it (else the next outer one tries; then 500)
  processException?(req: MwRequest, res: ServerResponse, err: unknown): Maybe<boolean | void>
}
export const defineMiddleware = (m: HttpMiddleware): HttpMiddleware => {
  if (!m.name || !(m.process || m.processRequest || m.processResponse || m.processException)) throw new Error('defineMiddleware: needs a name and at least one of process / processRequest / processResponse / processException')
  if (m.process && m.processRequest) throw new Error(`middleware ${m.name}: use process() or processRequest(), not both`)
  return m
}

// What a catalog factory (or a custom middleware class constructor) is built with
export interface BuildCtx {
  settings: Settings
  debug: boolean
  production: boolean
  sec: ReturnType<typeof securityHeaders>
  cors: ReturnType<typeof corsLayer>
  userOf?: (req: IncomingMessage) => Promise<TvineUser | undefined>   // the request's signed-in user (Maintenance allowStaff)
}
type Opts = Record<string, unknown>
type Factory = (o: Opts, b: BuildCtx) => HttpMiddleware

const PREFIX = 'tvine.middleware.'
const AGENT_SURFACE = (p: string) => p === '/mcp' || p.startsWith('/tvine/') || p.startsWith('/.well-known/') || p === '/llms.txt' || /\/agent\.(json|txt)$/.test(p)
const prefixed = (paths: unknown, p: string) => Array.isArray(paths) && paths.some((x) => typeof x === 'string' && (p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`)))
const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)), ...headers }).end(body)
}
const hdr = (req: IncomingMessage, n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }

// Host (x-forwarded-host only through trusted proxy hops, like transport/tab.ts) → [name, ok-shaped]
export function hostOf(req: IncomingMessage, trustProxy: number): string | undefined {
  const h = ((trustProxy > 0 && hdr(req, 'x-forwarded-host')?.split(',')[0]!.trim()) || hdr(req, 'host'))?.toLowerCase()
  if (h === undefined) return undefined
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h)
  return m ? m[1] : ''   // '' = malformed: matches nothing
}
// Django validate_host: '*' any, '.example.com' = example.com and every subdomain, else exact
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (!host) return false
  const h = host.replace(/\.$/, '')
  return allowed.some((p) => {
    const a = p.toLowerCase()
    return a === '*' || (a.startsWith('.') ? h === a.slice(1) || h.endsWith(a) : h === a)
  })
}
export const DEV_HOSTS = ['localhost', '.localhost', '127.0.0.1', '[::1]']

function blockList(list: unknown, name: string): BlockList {
  const b = new BlockList()
  for (const e of (list as string[] | undefined) ?? []) {
    const [addr, bits] = String(e).split('/')
    const v = isIP(addr ?? '')
    if (!v) throw new Error(`${name}: "${e}" is not an IP address or CIDR`)
    const type = v === 6 ? 'ipv6' : 'ipv4'
    if (bits === undefined) b.addAddress(addr!, type); else b.addSubnet(addr!, Number(bits), type)
  }
  return b
}
const ipIn = (b: BlockList, ip: string) => { const v = isIP(ip); return !!v && b.check(ip, v === 6 ? 'ipv6' : 'ipv4') }

// ---- the catalog --------------------------------------------------------------------------------------------
export const CATALOG: Record<string, Factory> = {
  // x-request-id in (a safe client value, or traceparent's trace id) or a fresh one; echoed out; in every log line
  RequestId: () => ({
    name: 'RequestId',
    processRequest(req) {
      const id = requestId({ get: (n) => hdr(req, n.toLowerCase()) ?? null })
      req.headers['x-request-id'] = id
      req.tvine.id = id
      req.tvine.log = req.tvine.log.child({ requestId: id })
    },
    processResponse(req, res) { if (!res.hasHeader('x-request-id')) res.setHeader('x-request-id', req.tvine.id!) },
  }),

  // Django ALLOWED_HOSTS: an unknown Host is a 400 (DNS rebinding, poisoned absolute URLs). Always runs first.
  AllowedHosts: (o, b) => {
    const allowed = (o.hosts as string[] | undefined) ?? b.settings.allowedHosts
    return {
      name: 'AllowedHosts',
      processRequest(req, res) {
        const h = hostOf(req, b.settings.trustProxy)
        // ponytail: no Host at all is HTTP/1.0 or a test double (node refuses HTTP/1.1 without one); only dev lets it by
        if (h === undefined && !b.production) return
        if (h !== undefined && hostAllowed(h, allowed)) { req.tvine.host = h; return }
        securityEvent('host_refused', { host: String(hdr(req, 'host') ?? '').slice(0, 100), ip: req.tvine.ip, requestId: req.tvine.id, path: req.tvine.path }, { settings: b.settings, audit: false })
        send(res, 400, 'Bad Request (invalid host)')
      },
    }
  },

  // Django SECURE_SSL_REDIRECT: plain http → 301 https (behind a proxy: settings.trustProxy reads X-Forwarded-Proto)
  SslRedirect: (o, b) => ({
    name: 'SslRedirect',
    processRequest(req, res) {
      if (req.tvine.https || prefixed(o.exempt, req.tvine.path)) return
      const host = (o.host as string | undefined) ?? req.tvine.host ?? hostOf(req, b.settings.trustProxy)
      if (!host) return send(res, 400, 'Bad Request (no host)')
      send(res, 301, '', { location: `https://${host}${req.url ?? '/'}` })
    },
  }),

  // security headers (CSP + nonce, HSTS on https, COOP/CORP, …): settings.security.headers
  Security: (_o, b) => ({
    name: 'Security',
    processRequest(req) {
      const plan = b.sec.begin(req, req.tvine.https)
      ;(req as MwRequest & { [PLAN]?: unknown })[PLAN] = plan
    },
    processResponse(req, res) { b.sec.apply(res, (req as MwRequest & { [PLAN]?: never })[PLAN]!) },
  }),

  // settings.cors: preflights answered here; allowed origins get the allow headers (only paths this server answers)
  Cors: (_o, b) => ({
    name: 'Cors',
    processRequest(req, res) {
      if (!req.tvine.ours) return
      if (b.cors.preflight(req, res)) return
      const plan = b.cors.request(req)
      if (!plan) return
      req.tvine.onHeaders(() => {
        for (const [k, v] of Object.entries(plan.headers)) res.setHeader(k, v)
        if (plan.dropSetCookie) res.removeHeader('set-cookie')   // no cookie went in: none comes back
        addVary(res, 'Origin')
      })
    },
  }),

  // gzip / brotli (settings.compression; BREACH-safe)
  GZip: (_o, b) => ({ name: 'GZip', processRequest(req) { req.tvine.compression = b.settings.compression } }),

  // ETag + If-None-Match → 304 for GET/HEAD (node then drops the body)
  ConditionalGet: () => ({
    name: 'ConditionalGet',
    processResponse(req, res) {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || res.statusCode !== 200) return
      const etag = res.getHeader('etag'), inm = hdr(req, 'if-none-match')
      if (typeof etag !== 'string' || !inm) return
      const bare = (t: string) => t.trim().replace(/^W\//, '')
      if (inm.trim() === '*' || inm.split(',').some((t) => bare(t) === bare(etag))) {
        res.statusCode = 304
        for (const h of ['content-length', 'content-type', 'content-encoding', 'transfer-encoding']) res.removeHeader(h)
      }
    },
  }),

  // per-ip token bucket for every path (settings.limits.backend: memory, or redis across servers)
  RateLimit: (o, b) => {
    const rate = { limit: (o.limit as number | undefined) ?? b.settings.limits.rate.limit * 5, windowMs: (o.windowMs as number | undefined) ?? b.settings.limits.rate.windowMs }
    const limiter = limiterFor(b.settings, rate)
    return {
      name: 'RateLimit',
      async processRequest(req, res) {
        if (prefixed(o.exempt, req.tvine.path)) return
        const r = await limiter.check({ sid: `mw-ip:${req.tvine.ip}` })
        if (r.ok) return
        securityEvent('rate_limited', { ip: req.tvine.ip, path: req.tvine.path, requestId: req.tvine.id, layer: 'http' }, { settings: b.settings, audit: false })
        send(res, 429, 'Too Many Requests', { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) })
      },
    }
  },

  // allow / deny lists (addresses or CIDR), optionally only under `paths` (list it twice for two rules)
  IpFilter: (o, b) => {
    const allow = o.allow ? blockList(o.allow, 'IpFilter.allow') : undefined
    const deny = blockList(o.deny, 'IpFilter.deny')
    return {
      name: 'IpFilter',
      processRequest(req, res) {
        if (o.paths && !prefixed(o.paths, req.tvine.path)) return
        const ip = req.tvine.ip
        if (!ipIn(deny, ip) && (!allow || ipIn(allow, ip))) return
        securityEvent('ip_refused', { ip, path: req.tvine.path, requestId: req.tvine.id }, { settings: b.settings })
        send(res, 403, 'Forbidden')
      },
    }
  },

  // 503 + Retry-After while on: `enabled: true`, or while `file` exists. allowIps / allowPaths / allowStaff pass.
  Maintenance: (o, b) => {
    const allow = blockList(o.allowIps, 'Maintenance.allowIps')
    return {
      name: 'Maintenance',
      async processRequest(req, res) {
        const on = o.enabled === true || (typeof o.file === 'string' && existsSync(o.file))
        if (!on || ipIn(allow, req.tvine.ip) || prefixed(o.allowPaths, req.tvine.path)) return
        if (o.allowStaff && b.userOf && (await b.userOf(req).catch(() => undefined))?.isStaff) return
        const retry = String((o.retryAfter as number | undefined) ?? 300)
        const msg = (o.message as string | undefined) ?? 'Down for maintenance; back soon.'
        if (/text\/html/.test(hdr(req, 'accept') ?? '')) {
          send(res, 503, `<!doctype html><meta charset="utf-8"><title>Maintenance</title><p>${msg.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`, { 'retry-after': retry, 'content-type': 'text/html; charset=utf-8' })
        } else send(res, 503, JSON.stringify({ error: 'maintenance', message: msg }), { 'retry-after': retry, 'content-type': 'application/json' })
      },
    }
  },

  // a request body larger than maxBytes (or the longest matching `paths` prefix's own cap) is a 413
  // ponytail: reads Content-Length; a chunked body is still capped by each transport's own reader (settings.limits.bodyBytes)
  BodyLimit: (o, b) => {
    const max = (o.maxBytes as number | undefined) ?? b.settings.limits.bodyBytes
    const paths = Object.entries((o.paths as Record<string, number> | undefined) ?? {}).sort((x, y) => y[0].length - x[0].length)
    return {
      name: 'BodyLimit',
      processRequest(req, res) {
        const cap = paths.find(([p]) => prefixed([p], req.tvine.path))?.[1] ?? max
        const len = Number(hdr(req, 'content-length') ?? 0)
        if (Number.isFinite(len) && len > cap) send(res, 413, 'Payload Too Large', { connection: 'close' })
      },
    }
  },

  // no response within `ms` → 503 (headers already out: the connection is cut). Streams (SSE, MCP) are exempt.
  Timeout: (o, b) => {
    const ms = (o.ms as number | undefined) ?? b.settings.limits.handlerMs + 5_000
    const exempt = (o.exempt as string[] | undefined) ?? ['/tvine/channel', '/tvine/tab', '/mcp']
    return {
      name: 'Timeout',
      processRequest(req, res) {
        if (prefixed(exempt, req.tvine.path) || typeof res.once !== 'function') return
        const t = setTimeout(() => {
          req.tvine.log.warn('request timed out', { path: req.tvine.path, ms })
          if (!res.headersSent) send(res, 503, 'Service Unavailable (timeout)', { connection: 'close' }); else res.destroy()
        }, ms)
        t.unref()
        res.once('close', () => clearTimeout(t))
      },
    }
  },

  // one structured line per request on tvine.request (the query string is never logged: it may carry tokens)
  AccessLog: () => ({
    name: 'AccessLog',
    processRequest(req, res) {
      if (typeof res.once !== 'function') return
      res.once('close', () => req.tvine.log.info('request', {
        method: req.method, path: req.tvine.path, status: res.statusCode, ms: Math.round(performance.now() - req.tvine.start),
        ip: req.tvine.ip, ...(res.writableFinished ? {} : { aborted: true }),
      }))
    },
  }),

  // Accept-Language → request.locale (one of `languages`, else `default`); Content-Language + Vary out
  Locale: (o) => {
    const langs = ((o.languages as string[] | undefined) ?? ['en']).map((l) => l.toLowerCase())
    const dflt = ((o.default as string | undefined) ?? langs[0]!).toLowerCase()
    return {
      name: 'Locale',
      processRequest(req) {
        const asked = String(hdr(req, 'accept-language') ?? '').split(',').map((p) => {
          const [tag, ...ps] = p.trim().toLowerCase().split(';')
          const q = ps.map((x) => /^\s*q=([0-9.]+)$/.exec(x)?.[1]).find(Boolean)
          return { tag: tag ?? '', q: q === undefined ? 1 : Number(q) }
        }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q)
        let pick = dflt
        for (const { tag } of asked) {
          const hit = langs.find((l) => l === tag) ?? langs.find((l) => l === tag.split('-')[0]) ?? langs.find((l) => l.split('-')[0] === tag.split('-')[0])
          if (hit) { pick = hit; break }
        }
        req.tvine.locale = pick
        req.headers['x-tvine-locale'] = pick
      },
      processResponse(req, res) {
        if (!res.hasHeader('content-language')) res.setHeader('content-language', req.tvine.locale!)
        addVary(res, 'Accept-Language')
      },
    }
  },

  // Server-Timing: app;dur=<ms> (debug only: timings help an attacker time things)
  ServerTiming: (_o, b) => ({
    name: 'ServerTiming',
    processResponse(req, res) { if (b.debug) res.appendHeader('server-timing', `app;dur=${(performance.now() - req.tvine.start).toFixed(1)}`) },
  }),

  // known-bad scanners' User-Agents get a 403. The agent surface (/mcp, /tvine/*, discovery, agent.json) is never blocked.
  BotGuard: (o, b) => {
    const re = (o.block as RegExp | undefined) ?? /sqlmap|nikto|masscan|zgrab|nmap|nuclei|acunetix|wpscan|dirbuster|gobuster|feroxbuster|ffuf|jaeles|netsparker|havij|w3af/i
    return {
      name: 'BotGuard',
      processRequest(req, res) {
        if (AGENT_SURFACE(req.tvine.path) || !re.test(hdr(req, 'user-agent') ?? '')) return
        securityEvent('bot_refused', { ip: req.tvine.ip, path: req.tvine.path, ua: String(hdr(req, 'user-agent')).slice(0, 120), requestId: req.tvine.id }, { settings: b.settings, audit: false })
        send(res, 403, 'Forbidden')
      },
    }
  },
}
const PLAN = Symbol('tvine.securityPlan')

// secure by default: what a new app runs without configuring anything (settings.middleware replaces it)
export const DEFAULT_MIDDLEWARE = ['RequestId', 'AllowedHosts', 'Security', 'Cors', 'GZip'].map((n) => PREFIX + n)

export type MiddlewareEntry = string | HttpMiddleware | (new (o: Opts, b: BuildCtx) => HttpMiddleware) | [string | HttpMiddleware | (new (o: Opts, b: BuildCtx) => HttpMiddleware), Opts]
export const isClass = (f: unknown): boolean => typeof f === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(f))

// settings.middleware → built middleware, AllowedHosts hoisted to the front (it must run before anything reads Host)
export function buildMiddleware(entries: readonly unknown[], b: BuildCtx): HttpMiddleware[] {
  const out = entries.map((e, i): HttpMiddleware => {
    const [what, opts] = Array.isArray(e) ? [e[0], (e[1] ?? {}) as Opts] : [e, {}]
    if (typeof what === 'string') {
      const f = what.startsWith(PREFIX) ? CATALOG[what.slice(PREFIX.length)] : undefined
      if (!f) throw new Error(`settings.middleware[${i}]: unknown middleware "${what}" (built in: ${Object.keys(CATALOG).map((k) => PREFIX + k).join(', ')})`)
      return f(opts, b)
    }
    if (isClass(what)) return defineMiddleware(Object.assign(new (what as new (o: Opts, b: BuildCtx) => HttpMiddleware)(opts, b), { name: (what as { name: string }).name }))
    if (what && typeof what === 'object' && typeof (what as HttpMiddleware).name === 'string') return defineMiddleware(what as HttpMiddleware)
    throw new Error(`settings.middleware[${i}]: expected 'tvine.middleware.<Name>', a defineMiddleware({...}), a class, or [one of those, options]`)
  })
  const hosts = out.filter((m) => m.name === 'AllowedHosts')
  return [...hosts, ...out.filter((m) => m.name !== 'AllowedHosts')]
}

// Runs the list around `inner` (the transports). Resolves once the chain handed off (or short-circuited).
export function runMiddleware(list: readonly HttpMiddleware[], req: MwRequest, res: ServerResponse, inner: () => void, fail: (e: unknown) => void): void {
  let finished: Promise<void> | undefined
  const done = () => (finished ??= new Promise<void>((ok) => {
    if (typeof res.once !== 'function' || res.writableFinished || res.destroyed) return ok()
    res.once('close', () => ok())
  }))
  const ended = () => res.writableEnded || res.headersSent || res.destroyed
  const onError = async (i: number, e: unknown) => {
    for (let j = i; j >= 0; j--) {
      const h = list[j]!.processException
      if (!h) continue
      try { if (await h.call(list[j], req, res, e)) return } catch (x) { e = x }
    }
    fail(e)
  }
  const at = async (i: number): Promise<void> => {
    if (i === list.length || !req.tvine.ours) { inner(); return done() }   // embedded: the host app's paths are its own
    const m = list[i]!
    try {
      if (m.processResponse) req.tvine.onHeaders(() => m.processResponse!.call(m, req, res))
      if (m.process) {
        let called = false
        await m.process.call(m, req, res, () => {
          if (called) throw new Error(`middleware ${m.name} called next() twice`)
          called = true
          return at(i + 1)
        })
        return
      }
      if (m.processRequest) await m.processRequest.call(m, req, res)
      if (ended()) return
      return at(i + 1)
    } catch (e) { await onError(i, e) }
  }
  void at(0)
}

// the active list, for `tvine check`
export const describeMiddleware = (list: readonly HttpMiddleware[]) => list.map((m) => (CATALOG[m.name] ? PREFIX + m.name : `${m.name} (custom)`))

