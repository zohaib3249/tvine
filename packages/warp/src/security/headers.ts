// security/headers — helmet-grade response headers + a per-request nonce CSP, and the CSP report sink
// (docs/design/server/security-headers.md). Decided when the headers are sent (transport/compress hookResponse),
// so the class of the response (page / data / media / asset) is known.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Log } from '../core/dispatch.js'
import { clientIp } from '../core/request.js'
import type { Settings } from '../core/types.js'
import { RateLimiter } from './ratelimit.js'

export const CSP_REPORT_PATH = '/tvine/csp-report'
const NONCE = '{{nonce}}'

// Built-in page policy; settings.security.headers.csp.directives replaces single directives (false drops one).
const BASE: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],   // React SSR style="" attributes + the presence overlay's shadow <style>
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"],
}
// tvine dev: React refresh evals, HMR websocket, and `tvine inspect` (another loopback port) frames the app
const DEV: Record<string, string[]> = {
  'script-src': ["'unsafe-eval'"],
  'connect-src': ['ws:', 'wss:'],
  'frame-ancestors': ['http://localhost:*', 'http://127.0.0.1:*'],
}
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'"
const MEDIA_CSP = "default-src 'none'; sandbox"
const DATA = /^(?:application\/(?:json|[\w.-]+\+json|x-ndjson)|text\/(?:plain|markdown|event-stream|tvine))\s*(?:;|$)/i
const INLINE_MEDIA = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+)\s*(?:;|$)/i

const uniq = (xs: string[]) => [...new Set(xs)]
const serialize = (d: Record<string, string[]>) => Object.entries(d).map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k)).join('; ')

export interface HeaderPlan { nonce?: string; https: boolean; path: string }

export function securityHeaders(settings: Settings, o: { isDev: boolean }) {
  const h = settings.security.headers
  const csp = h.enabled ? h.csp : false
  const name = csp && csp.reportOnly ? 'content-security-policy-report-only' : 'content-security-policy'
  const mediaPrefix = settings.media.route.replace(/\/$/, '') + '/'

  // The two page policies, with the nonce as a placeholder: dynamic (nonce + strict-dynamic) and static
  // (prerendered HTML has no nonce: 'unsafe-inline' scripts when staticPages = 'relaxed'), each ± https.
  const build = (https: boolean, nonced: boolean): string => {
    if (!csp) return ''
    const d: Record<string, string[]> = { ...BASE }
    for (const [k, v] of Object.entries(csp.directives)) { if (v === false) delete d[k]; else d[k] = [...v] }
    if (o.isDev) for (const [k, v] of Object.entries(DEV)) if (d[k]) d[k] = uniq([...d[k]!, ...v])
    // relaxed (no nonce) also drops hashes: a hash in script-src makes browsers ignore 'unsafe-inline'
    const drop = nonced ? /^'(nonce-|strict-dynamic|unsafe-inline)/ : /^'(nonce-|strict-dynamic|unsafe-inline|sha(256|384|512)-)/
    const script = (d['script-src'] ?? d['default-src'] ?? ["'self'"]).filter((s) => !drop.test(s))
    d['script-src'] = nonced ? uniq([...script, `'nonce-${NONCE}'`, "'strict-dynamic'"]) : uniq([...script, "'unsafe-inline'"])
    if (https && !csp.reportOnly) d['upgrade-insecure-requests'] = []
    if (csp.reportUri) { d['report-uri'] = [csp.reportUri]; d['report-to'] = ['csp'] }
    return serialize(d)
  }
  const policies = {
    dynamic: [build(false, true), build(true, true)],
    static: [build(false, csp && csp.staticPages === 'strict'), build(true, csp && csp.staticPages === 'strict')],
  }
  // X-Frame-Options can only say DENY or SAMEORIGIN; any other frame-ancestors list leaves it to CSP
  const fa = csp ? csp.directives['frame-ancestors'] : undefined
  const ancestors = [...(fa === undefined ? BASE['frame-ancestors']! : fa === false ? ['*'] : fa), ...(o.isDev ? DEV['frame-ancestors']! : [])]
  const xfo = ancestors.length === 1 && ancestors[0] === "'none'" ? 'DENY' : ancestors.length === 1 && ancestors[0] === "'self'" ? 'SAMEORIGIN' : undefined

  const always: [string, string][] = [
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', h.referrerPolicy],
    ...(h.coop ? [['cross-origin-opener-policy', h.coop] as [string, string]] : []),
    ...(h.corp ? [['cross-origin-resource-policy', h.corp] as [string, string]] : []),
    ['origin-agent-cluster', '?1'],
    ['x-permitted-cross-domain-policies', 'none'],
    ['x-xss-protection', '0'],
  ]
  const pp = Object.entries(h.permissionsPolicy).filter(([, v]) => v !== false)
    .map(([k, v]) => `${k}=(${(v as string[]).map((s) => (s === 'self' || s === '*' ? s : `"${s}"`)).join(' ')})`).join(', ')
  if (pp) always.push(['permissions-policy', pp])
  const hsts = h.hsts ? `max-age=${h.hsts.maxAge}${h.hsts.includeSubDomains ? '; includeSubDomains' : ''}${h.hsts.preload ? '; preload' : ''}` : ''

  const privateOnly = (res: ServerResponse) => {
    const cc = String(res.getHeader('cache-control') ?? '')
    if (!cc) return void res.setHeader('cache-control', 'private, no-cache')
    if (/\b(private|no-store)\b/i.test(cc)) return
    const kept = cc.split(',').map((t) => t.trim()).filter((t) => t && !/^(public|s-maxage=.*)$/i.test(t))
    res.setHeader('cache-control', ['private', ...kept].join(', '))
  }
  const setIfAbsent = (res: ServerResponse, k: string, v: string) => { if (!res.hasHeader(k)) res.setHeader(k, v) }
  // a route's own CSP stays: two policies = the browser enforces both, so a route can only tighten
  const addCsp = (res: ServerResponse, header: string, v: string) => {
    const cur = res.getHeader(header)
    res.setHeader(header, cur === undefined ? v : [...(Array.isArray(cur) ? cur : [String(cur)]), v])
  }

  return {
    // Request side, before anything runs: the nonce Next stamps on its scripts. Client copies never survive.
    begin(req: IncomingMessage, https: boolean): HeaderPlan {
      delete req.headers['content-security-policy']
      delete req.headers['content-security-policy-report-only']
      delete req.headers['x-nonce']
      const plan: HeaderPlan = { https, path: (req.url ?? '/').split('?')[0]! }
      if (!csp) return plan
      plan.nonce = randomBytes(16).toString('base64')
      req.headers[name] = policies.dynamic[https ? 1 : 0]!.replace(NONCE, plan.nonce)
      req.headers['x-nonce'] = plan.nonce
      return plan
    },

    // Response side, once, right before the headers leave.
    apply(res: ServerResponse, plan: HeaderPlan): void {
      res.removeHeader('x-powered-by')
      if (!h.enabled) return
      for (const [k, v] of always) setIfAbsent(res, k, v)
      if (plan.https && hsts) setIfAbsent(res, 'strict-transport-security', hsts)
      const type = String(res.getHeader('content-type') ?? '')
      if (plan.path.startsWith(mediaPrefix)) {
        setIfAbsent(res, 'content-disposition', INLINE_MEDIA.test(type) ? 'inline' : 'attachment')
        if (csp) addCsp(res, 'content-security-policy', MEDIA_CSP)
        return
      }
      if (/^text\/html\s*(;|$)/i.test(type)) {
        if (xfo) setIfAbsent(res, 'x-frame-options', xfo)
        if (!csp) return
        // Next served prerendered HTML (built without a nonce): the static policy
        const prerendered = res.hasHeader('x-nextjs-prerender') || res.hasHeader('x-nextjs-postponed')
        const p = (prerendered ? policies.static : policies.dynamic)[plan.https ? 1 : 0]!.replace(NONCE, plan.nonce ?? '')
        // a nonce must never be replayed from a shared cache: nonce-bearing HTML is private
        if (!prerendered || (csp.staticPages === 'strict')) privateOnly(res)
        addCsp(res, name, p)
        if (csp.reportUri) setIfAbsent(res, 'reporting-endpoints', `csp="${csp.reportUri}"`)
        return
      }
      if (DATA.test(type)) {
        setIfAbsent(res, 'x-frame-options', 'DENY')
        if (csp) addCsp(res, 'content-security-policy', DATA_CSP)
      }
    },

    // POST /tvine/csp-report is ours only when the policy reports to it
    reportsHere: !!csp && csp.reportUri === CSP_REPORT_PATH,
  }
}

// Boot checks against the built Next app (.next): Next compressing HTML itself (not BREACH-aware), and
// ISR / PPR routes served under the relaxed static policy (their cached HTML may carry stored user content).
export function nextBuildWarnings(nextDir: string, settings: Settings): string[] {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(nextDir, f), 'utf8')) as Record<string, unknown> } catch { return undefined } }
  const out: string[] = []
  const config = read('required-server-files.json')?.config as { compress?: boolean } | undefined
  if (config && config.compress !== false && settings.compression.enabled) {
    out.push('next.config has compress on (Next\'s default): Next gzips HTML itself, without tvine\'s BREACH rule — set compress: false in next.config')
  }
  const csp = settings.security.headers.enabled ? settings.security.headers.csp : false
  if (csp && csp.staticPages === 'relaxed') {
    const routes = (read('prerender-manifest.json')?.routes ?? {}) as Record<string, { initialRevalidateSeconds?: number | false; renderingMode?: string }>
    const risky = Object.entries(routes).filter(([, r]) => (typeof r.initialRevalidateSeconds === 'number' && r.initialRevalidateSeconds > 0) || r.renderingMode === 'PARTIALLY_STATIC').map(([p]) => p)
    if (risky.length) {
      out.push(`${risky.length} ISR/PPR route(s) (${risky.slice(0, 5).join(', ')}${risky.length > 5 ? ', …' : ''}) get the relaxed static CSP ('unsafe-inline' scripts): if they render stored user content, make them dynamic and set security.headers.csp.staticPages: 'strict'`)
    }
  }
  return out
}

// ---- POST /tvine/csp-report ------------------------------------------------------------------------
const REPORT_BYTES = 16 * 1024
const MAX_REPORTS = 20
const REPORT_TYPES = /^application\/(?:csp-report|reports\+json|json)\s*(?:;|$)/i

// URLs lose query + fragment (tokens in URLs must not reach logs); keywords ('inline', 'eval') pass.
const cleanUrl = (v: unknown) => {
  if (typeof v !== 'string' || !v) return undefined
  try { const u = new URL(v); return (u.origin === 'null' ? u.protocol : u.origin + u.pathname).slice(0, 300) } catch { return v.slice(0, 60) }
}
const str = (v: unknown, n = 300) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// legacy report-uri body, or the Reporting API's array of {type, body}
export function cspReports(body: unknown): Record<string, unknown>[] {
  const raw: Record<string, unknown>[] = Array.isArray(body)
    ? body.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as { type?: unknown }).type === 'csp-violation')
      .map((r) => (r.body && typeof r.body === 'object' ? r.body as Record<string, unknown> : {}))
    : body && typeof body === 'object' && (body as Record<string, unknown>)['csp-report'] && typeof (body as Record<string, unknown>)['csp-report'] === 'object'
      ? [(body as Record<string, Record<string, unknown>>)['csp-report']!] : []
  return raw.slice(0, MAX_REPORTS).map((r) => {
    const out: Record<string, unknown> = {
      document: cleanUrl(r.documentURL ?? r['document-uri']),
      blocked: cleanUrl(r.blockedURL ?? r['blocked-uri']),
      directive: str(r.effectiveDirective ?? r['effective-directive'] ?? r['violated-directive'], 100),
      disposition: str(r.disposition, 20),
      source: cleanUrl(r.sourceFile ?? r['source-file']),
      line: num(r.lineNumber ?? r['line-number']),
      column: num(r.columnNumber ?? r['column-number']),
      sample: str(r.sample ?? r['script-sample'], 80),
      status: num(r.statusCode ?? r['status-code']),
    }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
    return out
  })
}

export function cspReportHandler(settings: Settings, log: Log): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  // per IP, counted per REPORT: a burst of 100, refilling 100 per 5 min (RateLimiter's ip buckets span 5 windows)
  const limiter = new RateLimiter({ limit: 100, windowMs: 60_000 })
  return (req, res, next) => {
    if ((req.url ?? '/').split('?')[0] !== CSP_REPORT_PATH) return next()
    const done = (status: number, extra: Record<string, string> = {}) => void res.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0', ...extra }).end()
    if (req.method !== 'POST') return done(405, { allow: 'POST' })
    if (!REPORT_TYPES.test(String(req.headers['content-type'] ?? ''))) return done(415, { connection: 'close' })
    const ip = clientIp((req.headers['x-forwarded-for'] as string | undefined) ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
    const chunks: Buffer[] = []
    let n = 0, over = false
    req.on('data', (c: Buffer) => { if (over) return; if ((n += c.length) > REPORT_BYTES) { over = true; done(413, { connection: 'close' }) } else chunks.push(c) })
    req.on('error', () => res.destroy())
    req.on('end', () => {
      if (over) return
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return done(400) }
      for (const r of cspReports(body)) {
        if (!limiter.check({ ip }).ok) return done(429, { 'retry-after': '60' })
        log('warn', 'csp violation', r)
      }
      done(204)
    })
  }
}
