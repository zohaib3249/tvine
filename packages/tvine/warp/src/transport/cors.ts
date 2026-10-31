// transport/cors — settings.cors on the wire (docs/design/server/security-headers.md §CORS): preflight answers
// and response headers. Whether an allowed origin may ACT is dispatch's call (core/cors-match corsAllows):
// the Origin header always reaches dispatch untouched. Default closed: only paths a `routes` entry names.
import { forwardedHostOf } from '../core/request.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Settings } from '../core/types.js'
import { corsMatch } from '../core/cors-match.js'

// headers: the allow headers (allowed origin only); vary: always on a CORS route;
// dropSetCookie: an allowed cross-origin request without credentials gets no cookie back (none went in)
export type CorsPlan = { headers: Record<string, string>; vary: true; dropSetCookie: boolean } | undefined

export function corsLayer(settings: Settings) {
  const m = corsMatch(settings)   // throws on a bad configuration: boot fails, naming the setting
  const hostOf = (req: IncomingMessage) => forwardedHostOf(req, settings.trustProxy)   // X-Forwarded-Host per trusted hops
  const crossOriginOf = (req: IncomingMessage): string | undefined => {
    const origin = req.headers.origin
    if (typeof origin !== 'string') return undefined
    let host: string | undefined
    try { host = new URL(origin).host } catch { /* not same-origin */ }
    return host !== undefined && host === hostOf(req) ? undefined : origin
  }
  const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?')[0]!

  return {
    // OPTIONS preflight on a CORS route: answered here (true). Anything else: false.
    preflight(req: IncomingMessage, res: ServerResponse): boolean {
      if (!m.on || req.method !== 'OPTIONS' || req.headers['access-control-request-method'] === undefined) return false
      const p = m.policyOf(pathOf(req))
      const origin = crossOriginOf(req)
      if (!p || origin === undefined) return false
      const vary = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
      const allowed = m.allow(p, origin)
      const method = String(req.headers['access-control-request-method']).toUpperCase()
      const asked = String(req.headers['access-control-request-headers'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      if (allowed === undefined || !p.methods.includes(method) || !asked.every((h) => p.allowHeaders.includes(h))) {
        res.writeHead(403, { vary, 'content-length': '0', 'cache-control': 'no-store' }).end()
        return true
      }
      res.writeHead(204, {
        vary,
        'access-control-allow-origin': allowed,
        'access-control-allow-methods': p.methods.join(', '),
        'access-control-allow-headers': p.allowHeaders.join(', '),
        'access-control-max-age': String(p.maxAge),
        ...(p.credentials && { 'access-control-allow-credentials': 'true' }),
        'content-length': '0',
      }).end()
      return true
    },
    // Any request on a CORS route: Vary: Origin (caches never mix origins); an allowed cross-origin one also
    // gets the allow headers, and without `credentials` its Cookie is removed (the session never crosses).
    request(req: IncomingMessage): CorsPlan {
      const p = m.policyOf(pathOf(req))
      if (!p) return undefined
      const origin = crossOriginOf(req)
      const allowed = origin === undefined ? undefined : m.allow(p, origin)
      if (allowed === undefined) return { headers: {}, vary: true, dropSetCookie: false }
      if (!p.credentials) delete req.headers.cookie
      return {
        vary: true,
        dropSetCookie: !p.credentials,
        headers: {
          'access-control-allow-origin': allowed,
          ...(p.credentials && { 'access-control-allow-credentials': 'true' }),
          ...(p.exposeHeaders.length && { 'access-control-expose-headers': p.exposeHeaders.join(', ') }),
        },
      }
    },
  }
}
