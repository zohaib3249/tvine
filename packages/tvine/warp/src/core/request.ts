import type { IncomingMessage } from 'node:http'
import { nanoid } from 'nanoid'
import { userOfRequest } from './auth.js'
import { ANONYMOUS, type ReadonlyHeaders, type Request, type Settings } from './types.js'

export interface HttpSource { req: IncomingMessage; route: string; isAgent: boolean }
export interface McpSource {
  url: string                                // the tool's url arg, may carry ?query
  route: string
  headers: Record<string, string>
  // MCP ip bypasses trustProxy: the MCP transport must derive it from its own HTTP request
  // via clientIp(). Required and non-empty: '' would put every MCP caller on one rate-limit key.
  ip: string
  clientInfo?: { name?: string }
  isAgent?: boolean
  via?: 'mcp' | 'human'                      // 'human': the <Form> server-action path
  verified?: { directory: string; keyid: string }   // Web Bot Auth, checked by tvine.middleware.Shield
}

function readonlyHeaders(h: Record<string, string | string[] | undefined>): ReadonlyHeaders {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(h)) if (v !== undefined) m.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v)
  return Object.freeze({ get: (name: string) => m.get(name.toLowerCase()) ?? null })
}

// Next pattern -> params. '/product/[id]' and '/docs/[...slug]' (joined with '/').
function parseParams(route: string, path: string): Record<string, string> {
  const out: Record<string, string> = {}
  const rs = route.split('/'), ps = path.split('/')
  rs.forEach((seg, i) => {
    const m = /^\[(\.\.\.)?(\w+)\]$/.exec(seg)
    if (!m) return
    try {
      out[m[2]!] = m[1] ? ps.slice(i).map(decodeURIComponent).join('/') : decodeURIComponent(ps[i] ?? '')
    } catch { out[m[2]!] = m[1] ? ps.slice(i).join('/') : (ps[i] ?? '') }   // malformed %-escape: raw
  })
  return out
}

// Strip whitespace, port, brackets; unmap ::ffff:a.b.c.d. Keeps rate-limit keys stable per client.
function normalizeIp(raw: string): string {
  let a = raw.trim()
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(a)
  if (br) a = br[1]!
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'))
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)
  return m ? m[1]! : a
}

// A direct local request (metrics + health details): the socket itself is loopback, nothing claims to be forwarded,
// and no proxy is trusted — a same-host proxy would otherwise make every request look local.
// The Host must be a loopback name too: a foreign page rebinding its own name to 127.0.0.1 still sends its own Host.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK_SOCKET = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
export const loopbackHost = (h: string | string[] | undefined): boolean => {
  try { return typeof h === 'string' && LOOPBACK_HOSTS.has(new URL(`http://${h}`).hostname) } catch { return false }
}
export const isLocalRequest = (req: IncomingMessage, settings: Pick<Settings, 'trustProxy'>): boolean =>
  settings.trustProxy === 0 && LOOPBACK_SOCKET.test(req.socket?.remoteAddress ?? '') && loopbackHost(req.headers.host) &&
  !Object.keys(req.headers).some((h) => h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip')

// The Host a request reached us by: X-Forwarded-Host walked right-to-left exactly `trustProxy` hops (the same rule
// as clientIp / X-Forwarded-For; fewer entries = the Host header), else Host. Lowercase, port kept; undefined = none.
export function forwardedHost(get: (n: string) => string | null | undefined, trustProxy: number): string | undefined {
  if (trustProxy > 0) {
    const parts = String(get('x-forwarded-host') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const pick = parts[parts.length - trustProxy]
    if (pick) return pick.toLowerCase()
  }
  return get('host')?.toLowerCase() ?? undefined
}
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
export const forwardedHostOf = (req: IncomingMessage, trustProxy: number) => forwardedHost((n) => first(req.headers[n]), trustProxy)

/** X-Forwarded-Proto through the same trusted hops as clientIp (rightmost `trustProxy`). */
export function xfpHttps(xfp: string | undefined, hops: number): boolean {
  if (hops <= 0) return false
  const parts = String(xfp ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - hops] === 'https'
}

/** Socket TLS, or trusted X-Forwarded-Proto. Shared by server stamp + tab originOf. */
export function httpsOf(req: IncomingMessage, settings: Pick<Settings, 'trustProxy'>): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  return xfpHttps(first(req.headers['x-forwarded-proto']) ?? undefined, settings.trustProxy)
}

// Origin URL host equals the request Host (case-insensitive). Shared by sameOrigin and dispatch crossOrigin.
export function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase() } catch { return false }
}

// Origin present and equal to the request Host (X-Forwarded-Host when trustProxy > 0). Tab POSTs and inspector widgets share this.
export function sameOrigin(req: IncomingMessage, settings: Pick<Settings, 'trustProxy'>): boolean {
  const o = first(req.headers.origin), h = forwardedHostOf(req, settings.trustProxy)
  if (!o || !h) return false
  return originMatchesHost(o, h)
}

// The path every path rule matches (middleware lists, guards): percent-decoded, `\` as `/`, dot segments collapsed,
// duplicate slashes merged — what Next routes. Repeated until stable (a decoded %2F can create new segments).
const PLAIN_PATH = /^\/[\w\-.~!$&'()*+,;=:@/]*$/   // + no `//` and no dot segment: already normal (no %, `\`, space…)
export function normalizePath(raw: string): string {
  let p = raw.split('?')[0]!.split('#')[0]! || '/'
  if (PLAIN_PATH.test(p) && !p.includes('//') && !p.includes('/.')) return p
  for (let i = 0; i < 4; i++) {
    // slashes merged BEFORE parsing: '//x' would otherwise parse as a host
    let next = new URL(`/${p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`, 'http://n').pathname
    try { next = decodeURIComponent(next) } catch { /* malformed escape: keep the encoded form */ }
    if (next === p) break
    p = next
  }
  return p
}

// Walk X-Forwarded-For right-to-left exactly `hops` steps; never trust entries further left.
// Fewer entries than hops -> socket address: DELIBERATE fail-closed (the leftmost entry would
// hand the rate-limit key to a client hitting us directly).
export function clientIp(xff: string | null, remote: string, hops: number): string {
  if (hops <= 0 || !xff) return normalizeIp(remote)
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
  const pick = parts[parts.length - hops]
  return normalizeIp(pick ?? remote)
}

// Echoed in a response header and logged: only a short safe token is kept, anything else gets a fresh id.
export function requestId(h: ReadonlyHeaders): string {
  const rid = h.get('x-request-id')
  if (rid && /^[\w.-]{1,128}$/.test(rid)) return rid
  const tid = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(h.get('traceparent') ?? '')?.[1]
  return tid && !/^0+$/.test(tid) ? tid : nanoid()
}

type VerifiedAgent = { directory: string; keyid: string }
// request.agent.verified: only what tvine.middleware.Shield's Web Bot Auth check put on the raw request (never a header)
const verifiedOf = (v: VerifiedAgent | undefined) => (v ? { verified: { directory: v.directory, keyid: v.keyid } } : {})

// Requests (or raw HTTP msgs) whose caller already charged the general rate bucket: Form first-submit pre-check,
// and tvine.shield in enforce mode (with limits.rate.by = 'shield'). Dispatch skips the general bucket for them.
// Never set from anything the client sends.
export const rateChecked = new WeakSet<object>()

export async function buildRequest(src: HttpSource | McpSource, settings: Settings): Promise<Request> {
  const isHttp = 'req' in src
  const rawUrl = isHttp ? (src.req.url ?? '/') : src.url
  const u = new URL(rawUrl, 'http://tvine.local')
  const headers = readonlyHeaders(isHttp ? src.req.headers : src.headers)
  const remote = isHttp ? (src.req.socket.remoteAddress ?? '') : src.ip
  if (!isHttp && !remote.trim()) throw new Error('McpSource.ip is required (derive it with clientIp)')
  const request: Request = {
    method: isHttp && src.req.method === 'GET' ? 'GET' : 'POST',
    path: u.pathname,
    route: src.route,
    params: parseParams(src.route, u.pathname),
    query: u.searchParams,
    headers,
    ip: isHttp ? clientIp(headers.get('x-forwarded-for'), remote, settings.trustProxy) : normalizeIp(remote),
    id: requestId(headers),
    ...(headers.get('x-tvine-locale') && { locale: headers.get('x-tvine-locale')! }),
    agent: isHttp
      ? { is: src.isAgent, via: src.isAgent ? 'http' : 'human', client: headers.get('user-agent') ?? undefined, ...verifiedOf((src.req as { tvine?: { verifiedAgent?: VerifiedAgent } }).tvine?.verifiedAgent) }
      : src.via === 'human' ? { is: false, via: 'human', client: headers.get('user-agent') ?? undefined }
      : { is: src.isAgent ?? true, via: 'mcp', client: src.clientInfo?.name, ...verifiedOf(src.verified) },
    files: [],
    user: ANONYMOUS,
    ...(isHttp ? { raw: src.req } : {}),
  }
  await userOfRequest(request, settings)   // BYO resolver, else a bearer token (tvine.auth); the session user comes later (core/auth.ts)
  return request
}

export function deriveRequest(parent: Request, cmd: { path: string }): Request {
  return { ...parent, path: cmd.path, id: nanoid(), method: 'POST', agent: { ...parent.agent, via: 'channel' } }
}
