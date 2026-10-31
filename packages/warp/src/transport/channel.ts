import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChannelLayer, Event, Settings } from '../core/types.js'
import type { SessionStore } from '../core/session.js'
import { clientIp } from '../core/request.js'
import { ev } from '../core/events.js'
import { render } from '../serialize/envelope.js'
import { ipKey } from '../security/ratelimit.js'
import type { Frame, TabHub } from './tab.js'

// transport-channel.md: GET /tvine/channel, SSE push of session events (or the inspector group).
const HEARTBEAT_MS = 25_000
const MAX_BUF = 1_048_576 // close streams whose client stopped reading
const RING = 64 // must match MemoryChannelLayer's ring size

export interface Clock { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
export interface ChannelDeps {
  sessions: SessionStore
  channels: ChannelLayer
  settings: Settings
  isDev: boolean
  clock?: Clock
  watchInspector?: () => () => void   // called per open inspector stream; returns its release (the feed refcount)
  tabs?: TabHub                       // transport/tab: `?tab=` cookie streams become controllable tabs
}

const LOOPBACK = new Set(['127.0.0.1', '::1'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
// DNS rebinding: a foreign page resolving its own name to 127.0.0.1 still sends its own Host.
const localHost = (h: string | undefined) => {
  try { return h !== undefined && LOCAL_HOSTS.has(new URL(`http://${h}`).hostname) } catch { return false }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

export function channelTransport(deps: ChannelDeps): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { sessions, channels, settings, isDev } = deps
  const clock: Clock = deps.clock ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) }
  const open = new Map<string, number>() // open streams per client ip

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method !== 'GET' || url.pathname !== '/tvine/channel') return next()

    const json = (code: number, e: Event, sid = '', rev = 0) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(render([e], 'json', settings, { ctx: { sid, rev, page: '' } }))
    }
    const hdr = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }
    const remote = req.socket.remoteAddress ?? ''
    const ip = ipKey(clientIp(hdr('x-forwarded-for') ?? null, remote, settings.trustProxy))   // IPv6 per /64, like rate buckets

    const inspector = url.searchParams.get('group') === 'inspector'
    // Inspector feed: dev only, AND socket loopback (never X-Forwarded-For), AND no proxy header (a local
    // reverse proxy makes every client look like 127.0.0.1), AND a loopback Host. `listen(port)` binds every interface.
    const proxied = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((n) => hdr(n) !== undefined)
    if (inspector && (!isDev || proxied || !LOOPBACK.has(clientIp(null, remote, 0)) || !localHost(hdr('host')))) return json(403, ev.err('domain', 'forbidden'))

    // cookie (tabs) -> x-tvine-sid (agents) -> ?sid= (discouraged: lands in logs)
    const cookie = cookieValue(hdr('cookie'), settings.session.cookieName)
    const sidKey = hdr('x-tvine-sid') ?? url.searchParams.get('sid') ?? undefined
    const lookup = (f: SessionStore['resolve']) => (cookie !== undefined && f.call(sessions, { cookie })) || (sidKey ? f.call(sessions, { sid: sidKey }) : undefined)
    const resolve = () => lookup(sessions.resolve)
    const session = inspector ? undefined : resolve()
    // A tab = a browser page's stream: cookie-authenticated only (an agent's sid stream is never a tab).
    const asTab = !inspector && !!deps.tabs?.on && url.searchParams.has('tab') && cookie !== undefined && session !== undefined && sessions.peek({ cookie }) === session
    if (!inspector && !session) return json(401, ev.err('expired_sid', 'no live session'))
    const sid = session?.sid ?? ''
    const ctx = () => ({ sid, rev: session?.rev ?? 0, page: '' })

    if ((open.get(ip) ?? 0) >= settings.limits.sseConnPerIp) return json(429, ev.err('rate_limited', 'too many open streams'), sid)

    const group = channels.group(inspector ? 'inspector' : `sid:${sid}`)
    req.socket.setTimeout(0) // SSE is exempt from request timeouts
    req.socket.setKeepAlive(true, 30_000) // reap half-open sockets
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })

    let closed = false
    const frame = (e: Event, id?: number) => {
      res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${e.kind}\ndata: ${render([e], 'json', settings, { ctx: ctx() }).replace(/\n/g, '')}\n\n`)
      if (res.writableLength > MAX_BUF) close()
    }
    // Own errors stay ours: a failed write drops this stream only, never the layer's fan-out.
    const safe = (fn: () => void) => { try { fn() } catch { close() } }
    let unsub = () => {}
    let release = () => {}
    let untab = () => {}
    let timer: unknown
    const close = (graceful = false) => {
      if (closed) return
      closed = true
      unsub(); release(); untab(); clock.clearInterval(timer)
      open.set(ip, (open.get(ip) ?? 1) - 1)
      if (!open.get(ip)) open.delete(ip)
      // Forced close destroys the socket: end() would wait for a non-reading client to drain its buffer.
      try { if (graceful && !res.writableEnded) res.end(); else if (!graceful) res.destroy() } catch { /* socket already gone */ }
    }
    safe(() => { res.write(': ok\n\n') })
    req.on('close', () => close())
    res.on('error', () => close())
    open.set(ip, (open.get(ip) ?? 0) + 1) // after 'close' is wired: no leak window

    if (asTab && !closed) {
      // tab frames (hello/request/control/release/cmd) go to this stream only, never to the session group;
      // JSON.stringify keeps every value on one data line (no frame injection from an agent's name)
      const tf: Frame = (event, data) => { if (!closed) safe(() => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }) }
      const tabId = deps.tabs!.open(sid, tf, url.searchParams.get('tab') || undefined)
      untab = () => deps.tabs!.gone(tabId, tf)
    }

    const last = hdr('last-event-id')
    if (last !== undefined && /^\d+$/.test(last)) {
      const missed = group.since(Number(last))
      // ponytail: a full ring after a cursor can't be told from a truncated one (no seq exposed); treat as gap.
      if (missed.length >= RING) safe(() => frame(ev.err('stale_rev', 'missed events fell out of the buffer; re-GET a snapshot'), channels.head()))
      else safe(() => { for (const [i, e] of missed.entries()) { if (closed) break; frame(e, i === missed.length - 1 ? channels.head() : undefined) } })
    }

    // send() pushes to the ring before fan-out, so head() is this event's cursor.
    unsub = group.add((e) => { if (!closed) safe(() => frame(e, channels.head())) })
    if (inspector && deps.watchInspector && !closed) release = deps.watchInspector()

    timer = clock.setInterval(() => {
      if (closed) return
      // Expiry doesn't notify subscribers (core-session): poll here and end the stream.
      if (!inspector && !lookup(sessions.peek)) { safe(() => frame(ev.err('expired_sid', 'session expired'))); return close(true) }
      safe(() => { res.write(': ping\n\n'); if (res.writableLength > MAX_BUF) close() })
    }, HEARTBEAT_MS)
  }
}
