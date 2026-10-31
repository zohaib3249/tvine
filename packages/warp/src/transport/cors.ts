// transport/cors — settings.cors (docs/design/server/security-headers.md §CORS). Default closed: only
// paths a `routes` entry names answer CORS at all, and the hard same-origin endpoints never do.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CorsOrigin, CorsPolicy, Settings } from '../core/types.js'

// Never CORS, whatever the settings say: tab control, dev/inspector feeds, cookie streams, the CSP sink.
const HARD = [/^\/tvine\/tab(?:\/|$)/, /^\/tvine\/dev(?:\/|$)/, /^\/tvine\/channel$/, /^\/tvine\/csp-report$/]
const API = /^\/tvine\/api(?:\/|$)/

// the guards glob: `**` any depth (and the base itself), `*` one segment
const globRe = (g: string) => new RegExp('^' + g.split('/**').map((p) =>
  p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:/.*)?') + '$')

// a serialized http(s) origin, exactly as browsers send it
const isOrigin = (s: string) => {
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s } catch { return false }
}

function checkOrigins(origins: CorsOrigin[], credentials: boolean, where: string): void {
  for (const o of origins) {
    if (o instanceof RegExp) {
      if (!o.source.startsWith('^') || !o.source.endsWith('$') || o.source.endsWith('\\$')) throw new Error(`${where}: origin RegExp ${o} must be anchored (^…$), or it matches https://good.example.evil.com`)
      if (/[gym]/.test(o.flags)) throw new Error(`${where}: origin RegExp ${o} may not use the g, y or m flag`)
    } else if (o === '*') {
      if (credentials) throw new Error(`${where}: '*' with credentials: true is refused (browsers reject it, and it would hand the cookie session to every site); list the origins`)
    } else if (o === 'null') {
      throw new Error(`${where}: the 'null' origin (sandboxed frames, file://) is never allowed`)
    } else if (!isOrigin(o)) {
      throw new Error(`${where}: "${o}" is not an origin (scheme://host[:port], no path or trailing slash)`)
    }
  }
}

interface Route { re: RegExp; api: boolean; policy: CorsPolicy }
export type CorsPlan = { headers: Record<string, string>; vary: boolean } | undefined

export function corsLayer(settings: Settings) {
  const { routes: list, ...base } = settings.cors
  checkOrigins(base.origins, base.credentials, 'settings.cors')
  const routes: Route[] = list.map(({ path, ...over }, i) => {
    const policy: CorsPolicy = { ...base, ...over }
    const where = `settings.cors.routes[${i}] (${path})`
    if (HARD.some((h) => h.test(path.replace(/\/\*\*$/, '')) || h.test(path))) throw new Error(`${where}: this endpoint is same-origin only and never answers CORS`)
    checkOrigins(policy.origins, policy.credentials, where)
    return { re: globRe(path), api: API.test(path), policy: { ...policy, methods: policy.methods.map((m) => m.toUpperCase()), allowHeaders: policy.allowHeaders.map((h) => h.toLowerCase()) } }
  })
  const policyOf = (path: string): CorsPolicy | undefined => {
    if (HARD.some((h) => h.test(path))) return undefined
    const isApi = API.test(path)
    return routes.find((r) => r.re.test(path) && (!isApi || r.api))?.policy
  }
  const hostOf = (req: IncomingMessage) => {
    const h = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }
    return ((settings.trustProxy > 0 && h('x-forwarded-host')?.split(',')[0]!.trim()) || h('host'))?.toLowerCase()
  }
  const allowOrigin = (p: CorsPolicy, origin: string): string | undefined => {
    if (origin === 'null' || !isOrigin(origin)) return undefined
    for (const o of p.origins) {
      if (o === '*') return p.credentials ? undefined : '*'
      if (o instanceof RegExp ? o.test(origin) : o === origin) return origin
    }
    return undefined
  }

  // undefined = not a CORS request (no Origin, same origin, or not a CORS route): nothing changes.
  function classify(req: IncomingMessage): { policy: CorsPolicy; origin: string; allowed?: string } | undefined {
    if (settings.cors.routes.length === 0) return undefined
    const origin = req.headers.origin
    if (typeof origin !== 'string') return undefined
    let host: string | undefined
    try { host = new URL(origin).host } catch { /* not same-origin */ }
    if (host !== undefined && host === hostOf(req)) return undefined
    const policy = policyOf((req.url ?? '/').split('?')[0]!)
    if (!policy) return undefined
    return { policy, origin, allowed: allowOrigin(policy, origin) }
  }

  return {
    // OPTIONS preflight on a CORS route: answered here (true). Anything else: false.
    preflight(req: IncomingMessage, res: ServerResponse): boolean {
      if (req.method !== 'OPTIONS' || req.headers['access-control-request-method'] === undefined) return false
      const c = classify(req)
      if (!c) return false
      const vary = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
      const method = String(req.headers['access-control-request-method']).toUpperCase()
      const asked = String(req.headers['access-control-request-headers'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      const ok = c.allowed !== undefined && c.policy.methods.includes(method) && asked.every((h) => c.policy.allowHeaders.includes(h))
      if (!ok) {
        res.writeHead(403, { vary, 'content-length': '0', 'cache-control': 'no-store' }).end()
        return true
      }
      res.writeHead(204, {
        vary,
        'access-control-allow-origin': c.allowed!,
        'access-control-allow-methods': c.policy.methods.join(', '),
        'access-control-allow-headers': c.policy.allowHeaders.join(', '),
        'access-control-max-age': String(c.policy.maxAge),
        ...(c.policy.credentials && { 'access-control-allow-credentials': 'true' }),
        'content-length': '0',
      }).end()
      return true
    },
    // An actual request. Allowed origin: the app opted in, so dispatch's cross-origin refusal must not
    // refuse it (Origin removed) — and without `credentials` the cookie session never comes along.
    request(req: IncomingMessage): CorsPlan {
      const c = classify(req)
      if (!c) return undefined
      if (c.allowed === undefined) return { headers: {}, vary: true }
      if (!c.policy.credentials) delete req.headers.cookie
      delete req.headers.origin
      return {
        vary: true,
        headers: {
          'access-control-allow-origin': c.allowed,
          ...(c.policy.credentials && { 'access-control-allow-credentials': 'true' }),
          ...(c.policy.exposeHeaders.length && { 'access-control-expose-headers': c.policy.exposeHeaders.join(', ') }),
        },
      }
    },
  }
}
