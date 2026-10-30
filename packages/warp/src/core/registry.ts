import { createHash } from 'node:crypto'
import type { ErrCode, Sid, Snapshot } from './types.js'
import type { SessionStore } from './session.js'

// Thrown on extraction/render failures; dispatch/transport convert to `err` Events.
export class RegistryError extends Error {
  constructor(public code: ErrCode, message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

type Body = Omit<Snapshot, 'sid' | 'rev'>
const TVINE = /\btype\s*=\s*(["'])text\/tvine\1/i
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

// Collects every real <script type="text/tvine"> fragment in document order (incl. streamed
// Suspense chunks). Text inside other scripts (RSC payload strings) is never parsed. JSON.parse
// handles `</script` inside strings because the frontend escapes `<` as \u003c.
// Dedup is first-wins, so a Suspense FALLBACK fragment can win over the resolved one (ruled behavior).
// Linear scan: each position is visited once; an unclosed <script stops the walk.
export function extract(html: string, route = '?'): Body & { personal: boolean } {
  const low = html.replace(/[A-Z]/g, c => c.toLowerCase()) // ASCII-only: keeps offsets aligned
  const bad = () => new RegistryError('internal', `invalid embed fragment for ${route}`)
  let pg: { page: string; title: string } | undefined
  const nodes = new Map<string, any>(), links = new Map<string, any>()
  let personal = false
  for (let i = 0; (i = low.indexOf('<script', i)) >= 0;) {
    const gt = html.indexOf('>', i)
    if (gt < 0) break
    const next = low[i + 7]
    if (next !== undefined && !/[\s>/]/.test(next)) { i += 7; continue } // e.g. <scripts
    const close = low.indexOf('</script', gt)
    if (close < 0) break
    const attrs = html.slice(i + 7, gt)
    const text = html.slice(gt + 1, close)
    i = close + 8
    if (!TVINE.test(attrs)) continue
    let f: any
    try { f = JSON.parse(text) }
    catch { throw bad() }
    if (f?.v !== 1) throw new RegistryError('internal', 'unsupported embed version')
    // fail closed: anything but absent/false marks the snapshot personal
    if (f.personal !== undefined && f.personal !== false) personal = true
    if (f.k === 'page') {
      if (!isStr(f.page) || !isStr(f.title)) throw bad()
      pg ??= { page: f.page, title: f.title }
    } else if (f.k === 'node') {
      if (!isObj(f.node) || !isStr(f.node.id) || !isStr(f.node.type)) throw bad()
      if (!nodes.has(f.node.id)) nodes.set(f.node.id, f.node)
    } else if (f.k === 'link') {
      if (!isObj(f.link) || !isStr(f.link.id) || !isStr(f.link.href)) throw bad()
      if (!links.has(f.link.id)) links.set(f.link.id, f.link)
    } // unknown k: ignored (forward compatible)
  }
  if (!pg) throw new RegistryError('internal', `route not Tvine-enabled: ${route}`)
  return { ...pg, personal, nodes: [...nodes.values()], links: [...links.values()] }
}

// Sorted-key JSON so key order never changes the etag.
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().filter(k => (v as any)[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
    : JSON.stringify(v)

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

export class SnapshotCache {
  private m = new Map<string, { etag: string; body: Body; at: number }>()
  constructor(private ttlMs = 60_000, private max = 1000) {}

  get(route: string): { etag: string; body: Body } | undefined {
    const e = this.m.get(route)
    if (!e) return undefined
    if (Date.now() - e.at > this.ttlMs) { this.m.delete(route); return undefined }
    this.m.delete(route); this.m.set(route, e) // LRU: re-insert on hit
    return { etag: e.etag, body: e.body }
  }

  // Strips sid/rev so the etag depends on content only. Body is deep-frozen (shared state).
  set(route: string, snap: Body | Snapshot): string {
    const now = Date.now()
    for (const [k, e] of this.m) if (now - e.at > this.ttlMs) this.m.delete(k)
    const { page, title, nodes, links } = snap
    const body = deepFreeze({ page, title, nodes, links })
    const etag = createHash('sha1').update(canon(body)).digest('hex')
    this.m.delete(route)
    this.m.set(route, { etag, body, at: now })
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string)
    return etag
  }
}

export function makeSnapshotter(opts: {
  origin: string
  sessions: SessionStore
  cache: SnapshotCache
  fetch?: typeof globalThis.fetch
  cookieName?: string
  timeoutMs?: number
}): (route: string, sid: Sid) => Promise<Snapshot> {
  const { origin, sessions, cache, cookieName = 'tvine_s', timeoutMs = 10_000 } = opts
  const doFetch = opts.fetch ?? globalThis.fetch
  const stamp = (b: Body, sid: Sid, rev: number): Snapshot => ({ ...b, sid, rev })
  const revOf = (sid: Sid) => sessions.resolve({ sid })?.rev ?? 0
  const origin0 = new URL(origin).origin

  return async (route, sid) => {
    // Reject anything that could steer the cookie-bearing fetch off our origin.
    let url: URL | undefined
    try { if (route.startsWith('/') && !route.startsWith('//')) url = new URL(route, origin) } catch { /* below */ }
    if (!url || url.origin !== origin0) throw new RegistryError('internal', `invalid route: ${route}`)

    const hit = cache.get(route)
    if (hit) return stamp(hit.body, sid, revOf(sid))
    const rev = revOf(sid) // before the await: old content must not get a newer rev
    let res: Response
    try {
      res = await doFetch(url.href, {
        headers: { 'x-tvine-internal': '1', cookie: `${cookieName}=${sessions.cookieFor(sid)}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e: any) {
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network'
      throw new RegistryError('internal', `render failed (${why}) for ${route}`)
    }
    if (res.status !== 200) throw new RegistryError('internal', `render failed (${res.status}) for ${route}`)
    const { personal, ...body } = extract(await res.text(), route)
    if (personal === false) cache.set(route, body) // anything but literal false: uncacheable
    return stamp(body, sid, rev)
  }
}
