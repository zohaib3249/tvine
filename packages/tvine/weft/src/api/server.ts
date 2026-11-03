// tvine/api on the server (react-server: server components, server actions). One process: the
// in-process dispatch() Warp registers. Two servers: HTTP to TVINE_API_URL with the caller's identity in a
// signed x-tvine-forward header (HMAC, TVINE_SECRET, 30 s). Same pipeline either way.
import 'server-only'
import { cache } from 'react'
import { signForwardPayload as signForward } from '../../../warp/dist/security/forward-mac.js'
import { currentUserVia, makeApi, network, type Api, type ApiOpts, type ApiResult, type Transport } from './core.js'

export * from './core.js'
export { UserProvider, useUser } from './user.js'
export { signForward }

const API = Symbol.for('tvine.api')
type InProc = (call: { id: string; params: unknown; bind?: string; cmdId?: string }) => Promise<ApiResult>

interface NextHeaders { get(name: string): string | null }
interface NextCookies { get(name: string): { value: string } | undefined; set(name: string, value: string, o: { httpOnly: boolean; sameSite: 'lax' | 'strict' | 'none'; secure: boolean; path: string; maxAge: number }): unknown }
export interface NextAccess { headers(): Promise<NextHeaders>; cookies(): Promise<NextCookies> }

const nextAccess = async (): Promise<NextAccess> => {
  // @ts-ignore next is the app's dependency, not weft's (no types here)
  const m = (await import('next/headers')) as NextAccess
  return m
}

// The entry `hops` from the right, as Warp's clientIp walks X-Forwarded-For; never further left.
function trusted(v: string | null): string | undefined {
  const hops = Number(process.env.TVINE_TRUST_PROXY ?? 0)
  if (!(hops > 0) || !v) return undefined
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - hops]
}

// header: the API server's settings.header (TVINE_HEADER; default 'x-tvine') — weft has no settings in split mode
export function forwardTransport(o: { url: string; secret: string; cookieName?: string; header?: string; next?: () => Promise<NextAccess> }): Transport {
  // the API server's settings.session (secreview M2): secure in production → the __Host- name; env overrides both
  const secure = process.env.TVINE_SESSION_SECURE !== undefined ? process.env.TVINE_SESSION_SECURE === '1' : process.env.NODE_ENV === 'production'
  const name = o.cookieName ?? (secure ? '__Host-tvine_s' : 'tvine_s')
  const sameSite = (process.env.TVINE_SESSION_SAMESITE ?? 'lax') as 'lax' | 'strict' | 'none'
  return async (id, params, opts?: ApiOpts) => {
    const n = await (o.next ?? nextAccess)()
    const h = await n.headers(), jar = await n.cookies()
    const action = h.get('next-action') !== null
    let path = '/'
    try { const ref = h.get('referer'); if (action && ref) path = new URL(ref).pathname } catch { /* '/' */ }
    // X-Forwarded-* only through TVINE_TRUST_PROXY trusted hops (Warp's clientIp rule); else 'unknown' (one shared
    // rate-limit key). ponytail: headers() has no socket ip; set TVINE_TRUST_PROXY behind a proxy for per-client keys
    const ip = trusted(h.get('x-forwarded-for')) ?? 'unknown'
    const as = h.get('x-tvine-session') ?? undefined   // an agent's snapshot render; the API server checks its nonce
    // secreview H1: a caller that declares itself an agent (x-tvine or the tvine Accept) is forwarded as one
    const agent = h.get(o.header ?? 'x-tvine') !== null || /text\/tvine|application\/tvine\+json/i.test(h.get('accept') ?? '')
    const fwd = signForward({ cookie: jar.get(name)?.value, ...(as && { as }), ip, agent, path, mode: action ? 'action' : 'render' }, o.secret)
    try {
      const r = await fetch(`${o.url.replace(/\/$/, '')}/tvine/api/${encodeURIComponent(id)}`, {
        method: 'POST', signal: opts?.signal,
        headers: { 'content-type': 'application/json', 'x-tvine-forward': fwd },
        body: JSON.stringify({ params, bind: opts?.bind, cmdId: opts?.cmdId }),
      })
      const minted = r.headers.get('x-tvine-cookie')
      if (minted) jar.set(name, minted, { httpOnly: true, sameSite, secure: secure || name.startsWith('__Host-'), path: '/', maxAge: Number(process.env.TVINE_SESSION_TTL_S ?? 86_400) })
      return (await r.json()) as ApiResult
    } catch (e) { return network(e) }
  }
}

let forward: Transport | undefined
export const serverTransport: Transport = (id, params, opts) => {
  const inproc = (globalThis as Record<symbol, InProc | undefined>)[API]
  if (inproc) return inproc({ id, params, bind: opts?.bind, cmdId: opts?.cmdId })
  const url = process.env.TVINE_API_URL
  if (!url) throw new Error('tvine/api: no backend. Run the app with `tvine start`/`tvine dev` (one process), or set TVINE_API_URL (and TVINE_SECRET) to a `tvine start --api-only` server')
  const secret = process.env.TVINE_SECRET?.split(',')[0]?.trim()   // a rotation list signs with its first (newest) key
  if (!secret) throw new Error('tvine/api: TVINE_API_URL is set but TVINE_SECRET is not (it signs x-tvine-forward)')
  return (forward ??= forwardTransport({ url, secret, cookieName: process.env.TVINE_COOKIE_NAME, header: process.env.TVINE_HEADER }))(id, params, opts)
}

export const api: Api = makeApi(serverTransport)   // annotated: else the d.ts inlines the empty manifest and api.* is never typed

// The request's signed-in user (tvine.auth) for server components: auth.me, deduped per render (React cache).
export const currentUser = cache(currentUserVia(serverTransport))
