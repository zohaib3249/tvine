// @tvine/weft/api on the server (react-server: server components, server actions). One process: the
// in-process dispatch() Warp registers. Two servers: HTTP to TVINE_API_URL with the caller's identity in a
// signed x-tvine-forward header (HMAC, TVINE_SECRET, 30 s). Same pipeline either way.
import 'server-only'
import { createHmac } from 'node:crypto'
import { makeApi, network, type ApiOpts, type ApiResult, type Transport } from './core.js'

export * from './core.js'

const API = Symbol.for('tvine.api')
type InProc = (call: { id: string; params: unknown; bind?: string; cmdId?: string }) => Promise<ApiResult>

interface NextHeaders { get(name: string): string | null }
interface NextCookies { get(name: string): { value: string } | undefined; set(name: string, value: string, o: { httpOnly: boolean; sameSite: 'lax'; secure: boolean; path: string }): unknown }
export interface NextAccess { headers(): Promise<NextHeaders>; cookies(): Promise<NextCookies> }

const nextAccess = async (): Promise<NextAccess> => {
  // @ts-ignore next is the app's dependency, not weft's (no types here)
  const m = (await import('next/headers')) as NextAccess
  return m
}

// Same format and domain separation as Warp's verifyForward (transport/api.ts).
export function signForward(p: Record<string, unknown>, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: now + 30_000 })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(`tvine-forward.${body}`).digest('base64url')}`
}

export function forwardTransport(o: { url: string; secret: string; cookieName?: string; next?: () => Promise<NextAccess> }): Transport {
  const name = o.cookieName ?? 'tvine_s'
  return async (id, params, opts?: ApiOpts) => {
    const n = await (o.next ?? nextAccess)()
    const h = await n.headers(), jar = await n.cookies()
    const action = h.get('next-action') !== null
    let path = '/'
    try { const ref = h.get('referer'); if (action && ref) path = new URL(ref).pathname } catch { /* '/' */ }
    // ponytail: rightmost X-Forwarded-For as Next sets it; a proxy in front of Next needs a trustProxy-like knob
    const ip = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1) ?? 'unknown'
    const as = h.get('x-tvine-session') ?? undefined   // an agent's snapshot render; the API server checks its nonce
    const fwd = signForward({ cookie: jar.get(name)?.value, ...(as && { as }), ip, agent: false, path, mode: action ? 'action' : 'render' }, o.secret)
    try {
      const r = await fetch(`${o.url.replace(/\/$/, '')}/tvine/api/${encodeURIComponent(id)}`, {
        method: 'POST', signal: opts?.signal,
        headers: { 'content-type': 'application/json', 'x-tvine-forward': fwd },
        body: JSON.stringify({ params, bind: opts?.bind, cmdId: opts?.cmdId }),
      })
      const minted = r.headers.get('x-tvine-cookie')
      if (minted) jar.set(name, minted, { httpOnly: true, sameSite: 'lax', secure: h.get('x-forwarded-proto') === 'https', path: '/' })
      return (await r.json()) as ApiResult
    } catch (e) { return network(e) }
  }
}

let forward: Transport | undefined
export const serverTransport: Transport = (id, params, opts) => {
  const inproc = (globalThis as Record<symbol, InProc | undefined>)[API]
  if (inproc) return inproc({ id, params, bind: opts?.bind, cmdId: opts?.cmdId })
  const url = process.env.TVINE_API_URL
  if (!url) throw new Error('@tvine/weft/api: no backend. Run the app with `tvine start`/`tvine dev` (one process), or set TVINE_API_URL (and TVINE_SECRET) to a `tvine start --api-only` server')
  const secret = process.env.TVINE_SECRET
  if (!secret) throw new Error('@tvine/weft/api: TVINE_API_URL is set but TVINE_SECRET is not (it signs x-tvine-forward)')
  return (forward ??= forwardTransport({ url, secret, cookieName: process.env.TVINE_COOKIE_NAME }))(id, params, opts)
}

export const api = makeApi(serverTransport)
