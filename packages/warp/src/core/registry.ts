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
const OPEN = '<script type="text/tvine">'
const REQUIRED = ['page', 'title', 'personal', 'nodes', 'links']

// Last embed block wins (nested layouts). JSON.parse handles `</script` inside strings
// because the frontend escapes `<` as <.
export function extract(html: string, route = '?'): Body & { personal: boolean } {
  const i = html.lastIndexOf(OPEN)
  if (i < 0) throw new RegistryError('internal', `route not Tvine-enabled: ${route}`)
  const start = i + OPEN.length
  const end = html.indexOf('</script>', start)
  let o: any
  try { o = JSON.parse(html.slice(start, end < 0 ? undefined : end)) }
  catch { throw new RegistryError('internal', `invalid embed block for ${route}`) }
  if (o?.v !== 1) throw new RegistryError('internal', 'unsupported embed version')
  for (const k of REQUIRED) if (!(k in o)) throw new RegistryError('internal', `embed missing "${k}" for ${route}`)
  if (!Array.isArray(o.nodes) || !Array.isArray(o.links)) throw new RegistryError('internal', `embed nodes/links must be arrays for ${route}`)
  return { page: o.page, title: o.title, personal: o.personal, nodes: o.nodes, links: o.links }
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
