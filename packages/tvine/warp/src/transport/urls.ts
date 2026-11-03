// transport/urls — the routes of the project's urls.ts (docs/design/conventions/urls.md). A matched route runs
// its action exactly as POST /tvine/api/<id> does: same caller check (x-tvine-api: 1 or a signed forward),
// same invoke() → dispatch() (permissions, atomic, rate, idempotency, humanOnly, origin/CORS), same ApiResult JSON.
// Params: the query (GET) or the JSON body, merged with the typed path params; a different value for one key → 400.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerCtx } from '../core/dispatch.js'
import type { UrlTable } from '../urls.js'
import { coerceQuery, creates } from '../views/generic.js'
import { API_FORBIDDEN, apiFail, callerOf, invoke, readBody, sendApi, tooDeep, type ApiTransportOptions } from './api.js'

export function urlsTransport(server: ServerCtx, urls: UrlTable, o: ApiTransportOptions): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings } = server

  async function handle(req: IncomingMessage, res: ServerResponse, hit: ReturnType<UrlTable['match']>[number]) {
    const method = req.method === 'HEAD' ? 'GET' : req.method!   // HEAD = GET without a body (node drops it)
    const def = hit.route.methods.get(method)!
    const who = await callerOf(server, o, req, res)
    if (!who) return sendApi(res, API_FORBIDDEN)
    let given: Record<string, unknown> = {}
    if (method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://tvine.local').searchParams
      for (const k of new Set(q.keys())) { const all = q.getAll(k); given[k] = all.length > 1 ? all : all[0] }
      given = coerceQuery(def, given)
    } else {
      const raw = await readBody(req, settings.limits.bodyBytes)
      if (raw === null) { res.setHeader('connection', 'close'); return sendApi(res, apiFail('invalid_param', `request body exceeds ${settings.limits.bodyBytes} bytes`), 413) }
      if (raw.length) {
        if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return sendApi(res, apiFail('invalid_param', 'Content-Type must be application/json'))
        let body: unknown
        try { body = JSON.parse(raw) } catch { return sendApi(res, apiFail('invalid_param', 'body is not valid JSON')) }
        if (typeof body !== 'object' || body === null || Array.isArray(body) || tooDeep(body)) return sendApi(res, apiFail('invalid_param', 'body must be a JSON object (the params)'))
        given = body as Record<string, unknown>
      }
    }
    for (const [k, v] of Object.entries(hit.params)) {
      if (k in given && String(given[k]) !== String(v)) return sendApi(res, { ok: false, code: 'invalid_param', field: k, message: `${k}: the URL says ${String(v)}, the request says ${String(given[k])}` })
      given[k] = v
    }
    const h = (n: string) => { const v = req.headers[n]; return typeof v === 'string' ? v : undefined }
    const r = await invoke(server, { id: def.id, params: given, bind: h('x-tvine-bind'), cmdId: h('idempotency-key') }, who)
    sendApi(res, r, ...(r.ok && creates.has(def) ? [201] : []))
  }

  return (req, res, next) => {
    let path: string
    try { path = decodeURIComponent((req.url ?? '/').split('?')[0]!) } catch { return next() }
    const hits = urls.match(path)
    if (!hits.length) return next()
    const method = req.method === 'HEAD' ? 'GET' : req.method!
    const hit = hits.find((x) => x.route.methods.has(method))
    if (!hit) {
      const allow = [...new Set(hits.flatMap((x) => [...x.route.methods.keys()].flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m]))))].join(', ')
      return sendApi(res, apiFail('invalid_param', `method ${String(req.method).slice(0, 10)} not allowed`), 405, { allow })
    }
    void handle(req, res, hit).catch((e: unknown) => {
      server.log('error', 'urls transport failed', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
      if (!res.headersSent) sendApi(res, apiFail('internal', 'internal error'))
      else res.destroy()
    })
  }
}
