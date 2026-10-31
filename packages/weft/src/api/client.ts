// @tvine/weft/api in the browser (client components): same-origin POST /tvine/api/<id> with the httpOnly
// session cookie; x-tvine-api forces a CORS preflight cross-site. No sid is ever readable here.
// ponytail: no router.refresh() after a mutation here (needs a hook); call it in the component for now
import { currentUserVia, makeApi, network, type Api, type ApiResult, type Transport } from './core.js'

export * from './core.js'
export { UserProvider, useUser } from './user.js'

// Set by the in-tab executor while a WebMCP agent's step runs (runtime/exec.ts): calls made then are marked
// agent (downgrade-only: a page can only make its own calls agent, never human). On globalThis: separate entries.
const AGENT = Symbol.for('tvine.weft.agentVia')
export const agentVia = (): string | undefined => (globalThis as { [AGENT]?: string })[AGENT]

export const browserTransport: Transport = async (id, params, opts) => {
  const via = agentVia()
  try {
    const r = await fetch(`/tvine/api/${encodeURIComponent(id)}`, {
      method: 'POST', credentials: 'same-origin', signal: opts?.signal,
      headers: { 'content-type': 'application/json', 'x-tvine-api': '1' },
      body: JSON.stringify({ params, bind: opts?.bind, cmdId: opts?.cmdId, ...(via && { agentCmd: { via } }) }),
    })
    return (await r.json()) as ApiResult
  } catch (e) { return network(e) }
}

export const api: Api = makeApi(browserTransport)   // annotated: else the d.ts inlines the empty manifest and api.* is never typed

// The signed-in user from the browser (same auth.me call, the httpOnly cookie rides along). Server components:
// the same name from the react-server entry.
export const currentUser = currentUserVia(browserTransport)
