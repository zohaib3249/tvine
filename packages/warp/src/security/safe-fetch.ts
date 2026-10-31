// safeFetch: an outbound HTTP(S) request for a URL that came from input (webhooks, link previews, image import).
// SSRF guard: only http(s); the host is resolved ONCE per connection and the connection goes to that checked address
// (no DNS rebinding window); private / loopback / link-local / metadata / reserved ranges refused; each redirect is
// re-checked; a timeout and a response size cap. Returns a standard Response. Throws SafeFetchError.
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

export class SafeFetchError extends Error {
  constructor(readonly code: 'blocked_scheme' | 'blocked_host' | 'blocked_address' | 'too_many_redirects' | 'timeout' | 'too_large' | 'network', msg: string) {
    super(msg); this.name = 'SafeFetchError'
  }
}

const BLOCKED = new BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(a, p, 'ipv6')

// true for any address an outbound request must never reach (incl. 169.254.169.254 cloud metadata, fd00::/8)
export function isPrivateAddress(ip: string): boolean {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)   // IPv4-mapped IPv6
  if (m) return isPrivateAddress(m[1]!)
  const v = isIP(ip)
  return v === 0 || BLOCKED.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}

export interface SafeFetchOpts {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number          // whole request incl. redirects (default 10 s)
  maxBytes?: number           // response body cap (default 5 MB)
  maxRedirects?: number       // default 3
  allowHosts?: string[]       // only these hosts ('api.example.com', '.example.com' = with subdomains)
  allowPrivate?: boolean      // tests / an intranet integration: skip the address check (scheme, size, time still apply)
}

const hostAllowed = (host: string, list: string[]) =>
  list.some((h) => (h.startsWith('.') ? host === h.slice(1) || host.endsWith(h) : host === h))

export async function safeFetch(input: string | URL, opts: SafeFetchOpts = {}): Promise<Response> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  let url = new URL(String(input))
  let method = (opts.method ?? 'GET').toUpperCase()
  let body = opts.body
  for (let hop = 0; ; hop++) {
    const res = await once(url, method, body, opts, deadline)
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= (opts.maxRedirects ?? 3)) throw new SafeFetchError('too_many_redirects', 'too many redirects')
      url = new URL(loc, url)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
      continue
    }
    return res
  }
}

function once(url: URL, method: string, body: string | Buffer | undefined, opts: SafeFetchOpts, deadline: number): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.reject(new SafeFetchError('blocked_scheme', `only http(s) urls (got ${url.protocol})`))
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (opts.allowHosts && !hostAllowed(host, opts.allowHosts)) return Promise.reject(new SafeFetchError('blocked_host', `host ${host} is not allowed`))
  // the address the socket connects to is the one checked here (pinned): a second DNS answer cannot swap it
  const lookup: LookupFunction = (hostname, o, cb) => dnsLookup(hostname, { ...o, all: false }, (err, address, family) => {
    if (err) return cb(err, '', 0)
    if (!opts.allowPrivate && isPrivateAddress(address as string)) return cb(new SafeFetchError('blocked_address', `${hostname} resolves to a private address`), '', 0)
    cb(null, address as string, family as number)
  })
  if (isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) return Promise.reject(new SafeFetchError('blocked_address', `${host} is a private address`))
  const left = deadline - Date.now()
  if (left <= 0) return Promise.reject(new SafeFetchError('timeout', 'timed out'))
  const max = opts.maxBytes ?? 5 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: opts.headers, lookup, timeout: left, agent: false }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => {
        n += c.length
        if (n > max) { const e = new SafeFetchError('too_large', `response exceeds ${max} bytes`); reject(e); req.destroy(e); return }
        chunks.push(c)
      })
      res.on('end', () => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of [v].flat()) headers.append(k, x)
        const status = res.statusCode ?? 0
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }))
      })
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new SafeFetchError('timeout', 'timed out')), left)
    req.on('close', () => clearTimeout(timer))
    req.on('timeout', () => req.destroy(new SafeFetchError('timeout', 'timed out')))
    req.on('error', (e) => reject(e instanceof SafeFetchError ? e : (e as { cause?: unknown }).cause instanceof SafeFetchError ? (e as { cause: SafeFetchError }).cause : new SafeFetchError('network', e.message)))
    req.end(body)
  })
}
