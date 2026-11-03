// core/cors-match — settings.cors compiled once per Settings (docs/design/server/security-headers.md §CORS).
// Shared by transport/cors (response headers, preflight) and dispatch's crossOrigin (whether an opted-in
// origin may act at all), so both always agree. Boot-checked: bad configuration throws with a fix line.
import type { CorsOrigin, CorsPolicy, Request, Settings } from './types.js'
import { pathGlob as globRe } from './path-glob.js'
import { MCP_PATH } from '../transport/agent-copy.js'

// Never CORS, whatever the settings say: tab control, dev/inspector feeds, cookie streams, the CSP sink.
const HARD = [/^\/tvine\/tab(?:\/|$)/, /^\/tvine\/dev(?:\/|$)/, /^\/tvine\/channel$/, /^\/tvine\/csp-report$/]
const API = /^\/tvine\/api(?:\/|$)/

// a serialized http(s) origin, exactly as browsers send it
export const isOrigin = (s: string) => {
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s } catch { return false }
}

// An unescaped `.` outside a character class matches any char: /^https:\/\/a.example$/ admits https://aXexample.
function unescapedDot(src: string): boolean {
  let cls = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (cls) { if (c === ']') cls = false; continue }
    if (c === '[') cls = true
    else if (c === '.') return true
  }
  return false
}

// 'https://*.example.com' → exactly one subdomain label (never the bare domain, never deeper)
const WILD = /^(https?):\/\/\*\.((?:[a-z0-9-]+\.)+[a-z0-9-]+)(:\d{1,5})?$/

type Matcher = (origin: string) => boolean
function compileOrigins(origins: CorsOrigin[], credentials: boolean, where: string): { any: boolean; match: Matcher[] } {
  const match: Matcher[] = []
  let any = false
  for (const o of origins) {
    if (o instanceof RegExp) {
      if (!o.source.startsWith('^') || !o.source.endsWith('$') || o.source.endsWith('\\$')) throw new Error(`${where}: origin RegExp ${o} must be anchored (^…$), or it matches https://good.example.evil.com`)
      if (/[gym]/.test(o.flags)) throw new Error(`${where}: origin RegExp ${o} may not use the g, y or m flag`)
      if (unescapedDot(o.source)) throw new Error(`${where}: origin RegExp ${o} has an unescaped "." (matches any character): write \\. — or use 'https://*.example.com'`)
      const re = new RegExp(o.source, o.flags)
      match.push((s) => re.exec(s)?.[0] === s)   // whole-string: /^a$|^b/ style alternations can't half-match
    } else if (o === '*') {
      if (credentials) throw new Error(`${where}: '*' with credentials: true is refused (browsers reject it, and it would hand the cookie session to every site); list the origins`)
      any = true
    } else if (o === 'null') {
      throw new Error(`${where}: the 'null' origin (sandboxed frames, file://) is never allowed`)
    } else if (o.includes('*')) {
      const w = WILD.exec(o)
      if (!w) throw new Error(`${where}: "${o}" — a wildcard origin is 'https://*.example.com' (one subdomain label)`)
      const re = new RegExp(`^${w[1]}://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${w[2]!.replace(/\./g, '\\.')}${w[3] ?? ''}$`)
      match.push((s) => re.test(s))
    } else if (!isOrigin(o)) {
      throw new Error(`${where}: "${o}" is not an origin (scheme://host[:port], no path or trailing slash)`)
    } else {
      match.push((s) => s === o)
    }
  }
  return { any, match }
}

export interface CompiledCors extends CorsPolicy { any: boolean; match: Matcher[] }
export interface CorsMatch {
  on: boolean                                          // any route at all (else everything is same-origin only)
  policyOf(path: string): CompiledCors | undefined     // the route's policy for this endpoint path
  allow(p: CompiledCors, origin: string): string | undefined   // the Access-Control-Allow-Origin value, or refused
}

const built = new WeakMap<Settings, CorsMatch>()
export function corsMatch(settings: Settings): CorsMatch {
  const hit = built.get(settings)
  if (hit) return hit
  const { routes: list, ...base } = settings.cors
  compileOrigins(base.origins, base.credentials, 'settings.cors')
  const routes = list.map(({ path, ...over }, i) => {
    const policy: CorsPolicy = { ...base, ...over }
    const where = `settings.cors.routes[${i}] (${path})`
    if (HARD.some((h) => h.test(path.replace(/\/\*\*$/, '')) || h.test(path))) throw new Error(`${where}: this endpoint is same-origin only and never answers CORS`)
    const c = compileOrigins(policy.origins, policy.credentials, where)
    const compiled: CompiledCors = { ...policy, ...c, methods: policy.methods.map((m) => m.toUpperCase()), allowHeaders: policy.allowHeaders.map((h) => h.toLowerCase()) }
    return { re: globRe(path), api: API.test(path), policy: compiled }
  })
  const m: CorsMatch = {
    on: routes.length > 0,
    policyOf(path) {
      if (!routes.length || HARD.some((h) => h.test(path))) return undefined
      const isApi = API.test(path)   // the browser API endpoint: only a route that names it, never a catch-all
      return routes.find((r) => r.re.test(path) && (!isApi || r.api))?.policy
    },
    allow(p, origin) {
      if (origin === 'null' || !isOrigin(origin)) return undefined
      if (p.match.some((f) => f(origin))) return origin
      return p.any ? '*' : undefined
    },
  }
  built.set(settings, m)
  return m
}

// dispatch's crossOrigin: may this cross-origin request act? Only when its endpoint (the HTTP path it came in
// on: http/api transports carry `raw`; MCP is /mcp) has a CORS route that allows the origin and the method,
// the browser said it is a CORS fetch (Sec-Fetch-Mode, when sent), and — without credentials — no session cookie
// rides along. Every other entry (the human <Form> path) stays strictly same-origin.
export function corsAllows(r: Request, s: Settings, origin: string): boolean {
  const m = corsMatch(s)
  if (!m.on) return false
  const endpoint = r.raw ? (r.raw.url ?? '/').split('?')[0]! : r.agent.via === 'mcp' ? MCP_PATH : undefined
  const method = (r.raw?.method ?? 'POST').toUpperCase()
  if (endpoint === undefined) return false
  const p = m.policyOf(endpoint)
  if (!p || m.allow(p, origin) === undefined || !p.methods.includes(method)) return false
  const mode = r.headers.get('sec-fetch-mode')
  if (mode !== null && mode !== 'cors') return false
  if (!p.credentials && new RegExp(`(?:^|;\\s*)${s.session.cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`).test(r.headers.get('cookie') ?? '')) return false
  return true
}
