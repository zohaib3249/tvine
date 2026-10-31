// @tvine/weft/api in the browser (client components): same-origin POST /tvine/api/<id> with the httpOnly
// session cookie; x-tvine-api forces a CORS preflight cross-site. No sid is ever readable here.
// ponytail: no router.refresh() after a mutation here (needs a hook); call it in the component for now
import { makeApi, network, type Api, type ApiResult, type Transport } from './core.js'

export * from './core.js'

export const browserTransport: Transport = async (id, params, opts) => {
  try {
    const r = await fetch(`/tvine/api/${encodeURIComponent(id)}`, {
      method: 'POST', credentials: 'same-origin', signal: opts?.signal,
      headers: { 'content-type': 'application/json', 'x-tvine-api': '1' },
      body: JSON.stringify({ params, bind: opts?.bind, cmdId: opts?.cmdId }),
    })
    return (await r.json()) as ApiResult
  } catch (e) { return network(e) }
}

export const api: Api = makeApi(browserTransport)   // annotated: else the d.ts inlines the empty manifest and api.* is never typed
