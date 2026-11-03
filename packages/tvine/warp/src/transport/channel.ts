import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChannelLayer, Event, Session, Settings } from '../core/types.js'
import type { SessionStore } from '../core/session.js'
import { clientIp, isLocalRequest, sameOrigin } from '../core/request.js'
import { ev } from '../core/events.js'
import { RING } from '../core/channels.js'
import { render } from '../serialize/envelope.js'
import { cookieValue } from '../security/cookie.js'
import { ipKey } from '../security/ratelimit.js'
import { metrics } from '../core/metrics.js'
import type { Frame, TabHub } from './tab.js'

// transport-channel.md: GET /tvine/channel, SSE push of session events (or the inspector group).
const HEARTBEAT_MS = 25_000
const MAX_BUF = 1_048_576 // close streams whose client stopped reading

export interface Clock { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
export interface ChannelDeps {
  sessions: SessionStore
  channels: ChannelLayer
  settings: Settings
  isDev: boolean
  clock?: Clock
  watchInspector?: () => () => void   // called per open inspector stream; returns its release (the feed refcount)
  tabs?: TabHub                       // transport/tab: `?tab=` cookie streams become controllable tabs
  // tvine.admin's live groups (`?group=admin:live|admin:logs`): may this cookie session's user join? (server.ts)
  // ip = the client's address (request.ip rules); re-asked every ADMIN_RECHECK_MS while the stream is open
  groupAllowed?: (group: string, session: Session, ip: string) => Promise<boolean>
}
const ADMIN_GROUPS = new Set(['admin:live', 'admin:logs'])
const ADMIN_RECHECK_MS = 10_000


// The inspector rule (dev surfaces only): socket loopback (never X-Forwarded-For), no proxy header (a local reverse
// proxy makes every client look like 127.0.0.1), and a loopback Host. `listen(port)` binds every interface.
// The same rule as metrics / health details: core/request.ts isLocalRequest (any x-forwarded-* also counts as proxied).
export const localOnly = (req: IncomingMessage): boolean => isLocalRequest(req, { trustProxy: 0 })

export function channelTransport(deps: ChannelDeps): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { sessions, channels, settings, isDev } = deps
  const clock: Clock = deps.clock ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) }
  const open = new Map<string, number>() // open streams per client ip

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method !== 'GET' || url.pathname !== '/tvine/channel') return next()
    void stream(req, res, url).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy() })
  }

  async function stream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (code: number, e: Event, sid = '', rev = 0) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(render([e], 'json', settings, { ctx: { sid, rev, page: '' } }))
    }
    const hdr = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }
    const remote = req.socket.remoteAddress ?? ''
    const ip = ipKey(clientIp(hdr('x-forwarded-for') ?? null, remote, settings.trustProxy))   // IPv6 per /64, like rate buckets

    const inspector = url.searchParams.get('group') === 'inspector'
    // Inspector feed: dev only, AND loopback only (localOnly).
    if (inspector && (!isDev || !localOnly(req))) return json(403, ev.err('domain', 'forbidden'))

    // cookie (tabs) -> x-tvine-sid (agents); ?sid= only in debug (lands in access logs / Referer)
    const cookie = cookieValue(hdr('cookie'), settings.session.cookieName)
    const sidKey = hdr('x-tvine-sid') ?? (settings.debug ? url.searchParams.get('sid') : null) ?? undefined
    const lookup = async (f: SessionStore['resolve']) => (cookie !== undefined && await f.call(sessions, { cookie })) || (sidKey ? f.call(sessions, { sid: sidKey }) : undefined)
    const session = inspector ? undefined : await lookup(sessions.resolve)
    const cookieSession = session !== undefined && cookie !== undefined && await sessions.peek({ cookie }) === session
    // A tab = a browser page's stream: cookie-authenticated only (an agent's sid stream is never a tab).
    const asTab = !inspector && !!deps.tabs?.on && url.searchParams.has('tab') && cookieSession
    if (!inspector && !session) return json(401, ev.err('expired_sid', 'no live session'))
    // Origin gate (same intent as tab): sid streams refuse a foreign Origin (missing OK for non-browser agents);
    // cookie browser streams require same-origin when Origin is present (EventSource from the site sends it).
    const origin = hdr('origin')
    if (!inspector && origin !== undefined && !sameOrigin(req, settings)) return json(403, ev.err('domain', 'forbidden'))
    const wanted = url.searchParams.get('group')
    const adminGroup = wanted !== null && ADMIN_GROUPS.has(wanted) ? wanted : undefined
    // an admin group: cookie sessions only (the panel), and only for a user the gate lets in
    const realIp = clientIp(hdr('x-forwarded-for') ?? null, remote, settings.trustProxy)
    const allowed = async (s: Session | undefined) => { try { return !!s && !!deps.groupAllowed && await deps.groupAllowed(adminGroup!, s, realIp) } catch { return false } }
    if (adminGroup && !(cookieSession && await allowed(session))) return json(403, ev.err('domain', 'forbidden'))
    const sid = session?.sid ?? ''
    // I3: a stream authenticated by the httpOnly cookie never carries the sid (page script, XSS included, must
    // not learn it); an agent's sid-keyed stream already knows its own sid.
    const byCookie = cookieSession
    const ctx = () => ({ sid: byCookie ? '' : sid, rev: session?.rev ?? 0, page: '' })

    if ((open.get(ip) ?? 0) >= settings.limits.sseConnPerIp) { metrics.inc('tvine_ratelimit_hits_total', { scope: 'sse' }); return json(429, ev.err('rate_limited', 'too many open streams'), byCookie ? '' : sid) }   // I3: never the cookie session's sid

    const group = channels.group(inspector ? 'inspector' : adminGroup ?? `sid:${sid}`)
    req.socket.setTimeout(0) // SSE is exempt from request timeouts
    req.socket.setKeepAlive(true, 30_000) // reap half-open sockets
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })

    let closed = false
    // events name their sid themselves (update, snapshot): blanked too on a cookie stream
    const hide = (e: Event): Event => !byCookie ? e
      : e.kind === 'update' ? { ...e, sid: '' }
      : e.kind === 'snapshot' ? { ...e, snapshot: { ...e.snapshot, sid: '' } }
      : e.kind === 'err' && e.snapshot ? { ...e, snapshot: { ...e.snapshot, sid: '' } } : e
    const frame = (ev0: Event, id?: number) => {
      // admin groups carry their own small payloads (contrib/admin/hooks.ts): `event: admin`, the payload as JSON
      if (adminGroup) { if (ev0.kind === 'patch') res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: admin\ndata: ${JSON.stringify(ev0.changes)}\n\n`); return }
      const e = hide(ev0)
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
      const tabId = await deps.tabs!.open(sid, tf, url.searchParams.get('tab') || undefined, (url.searchParams.get('doc') ?? '').slice(0, 64))
      untab = () => deps.tabs!.gone(tabId, tf)
      if (closed) untab()   // the stream ended while a shared hub registered the tab
    }

    // subscribe first, replay second: an event sent while the replay is read is held, then sent once (by seq)
    let held: { e: Event; seq: number }[] | undefined = []
    let shown = 0
    const live = (e: Event, seq: number) => { if (!closed && seq > shown) { shown = seq; safe(() => frame(e, seq)) } }
    unsub = group.add((e, seq) => { if (held) held.push({ e, seq }); else live(e, seq) })
    const last = hdr('last-event-id')
    if (last !== undefined && /^\d+$/.test(last)) {
      const missed = await group.since(Number(last))
      // ponytail: a full ring after a cursor can't be told from a truncated one (cursors are global); treat as gap.
      if (missed.length >= RING) safe(() => frame(ev.err('stale_rev', 'missed events fell out of the buffer; re-GET a snapshot'), missed[missed.length - 1]!.seq))
      else for (const [i, r] of missed.entries()) { if (closed) break; safe(() => frame(r.e, i === missed.length - 1 ? r.seq : undefined)) }
      shown = Math.max(shown, missed[missed.length - 1]?.seq ?? 0)
    }
    const queued = held
    held = undefined
    for (const r of queued) live(r.e, r.seq)
    if (inspector && deps.watchInspector && !closed) release = deps.watchInspector()

    // an admin group re-checks its user (staff / superuser, allowIps, 2FA, idle) and ends when it no longer passes
    let recheck: unknown
    if (adminGroup) recheck = clock.setInterval(() => {
      void lookup(sessions.peek).then(async (s) => { if (!closed && !(await allowed(s))) close(true) }, () => { /* store hiccup: next round */ })
    }, ADMIN_RECHECK_MS)
    const untimer = unsub
    unsub = () => { untimer(); if (recheck !== undefined) clock.clearInterval(recheck) }
    timer = clock.setInterval(() => {
      if (closed) return
      // Expiry doesn't notify subscribers (core-session): poll here and end the stream.
      if (!inspector) {
        void lookup(sessions.peek).then((s) => {
          if (closed) return
          if (!s) { safe(() => frame(ev.err('expired_sid', 'session expired'))); return close(true) }
          safe(() => { res.write(': ping\n\n'); if (res.writableLength > MAX_BUF) close() })
        }, () => safe(() => { res.write(': ping\n\n') }))   // a store hiccup is not an expiry
        return
      }
      safe(() => { res.write(': ping\n\n'); if (res.writableLength > MAX_BUF) close() })
    }, HEARTBEAT_MS)
  }
}
