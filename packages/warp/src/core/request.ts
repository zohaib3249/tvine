import type { IncomingMessage } from 'node:http'
import { nanoid } from 'nanoid'
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

// Walk X-Forwarded-For right-to-left exactly `hops` steps; never trust entries further left.
// Fewer entries than hops -> socket address: DELIBERATE fail-closed (the leftmost entry would
// hand the rate-limit key to a client hitting us directly).
export function clientIp(xff: string | null, remote: string, hops: number): string {
  if (hops <= 0 || !xff) return normalizeIp(remote)
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
  const pick = parts[parts.length - hops]
  return normalizeIp(pick ?? remote)
}

function requestId(h: ReadonlyHeaders): string {
  const rid = h.get('x-request-id')
  if (rid) return rid
  const tid = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(h.get('traceparent') ?? '')?.[1]
  return tid && !/^0+$/.test(tid) ? tid : nanoid()
}

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
    agent: isHttp
      ? { is: src.isAgent, via: src.isAgent ? 'http' : 'human', client: headers.get('user-agent') ?? undefined }
      : { is: src.isAgent ?? true, via: 'mcp', client: src.clientInfo?.name },
    files: [],
    user: ANONYMOUS,
    ...(isHttp ? { raw: src.req } : {}),
  }
  request.user = (await settings.auth?.user?.(request)) ?? ANONYMOUS
  return request
}

export function deriveRequest(parent: Request, cmd: { path: string }): Request {
  return { ...parent, path: cmd.path, id: nanoid(), method: 'POST', agent: { ...parent.agent, via: 'channel' } }
}
