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
  return { page: o.page, title: o.title, personal: o.personal, nodes: o.nodes, links: o.links }
}

// Sorted-key JSON so key order never changes the etag.
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().filter(k => (v as any)[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
    : JSON.stringify(v)

export class SnapshotCache {
  private m = new Map<string, { etag: string; body: Body; at: number }>()
  constructor(private ttlMs = 60_000) {}

  get(route: string): { etag: string; body: Body } | undefined {
    const e = this.m.get(route)
    if (!e) return undefined
    if (Date.now() - e.at > this.ttlMs) { this.m.delete(route); return undefined }
    return { etag: e.etag, body: e.body }
  }

  // Strips sid/rev so the etag depends on content only.
  set(route: string, snap: Body | Snapshot): string {
    const { page, title, nodes, links } = snap
    const body = { page, title, nodes, links }
    const etag = createHash('sha1').update(canon(body)).digest('hex')
    this.m.set(route, { etag, body, at: Date.now() })
    return etag
  }
}

export function makeSnapshotter(opts: {
  origin: string
  sessions: SessionStore
  cache: SnapshotCache
  fetch?: typeof globalThis.fetch
  cookieName?: string
}): (route: string, sid: Sid) => Promise<Snapshot> {
  const { origin, sessions, cache, cookieName = 'tvine_s' } = opts
  const doFetch = opts.fetch ?? globalThis.fetch
  const stamp = (b: Body, sid: Sid): Snapshot =>
    ({ ...b, sid, rev: sessions.resolve({ sid })?.rev ?? 0 })

  return async (route, sid) => {
    const hit = cache.get(route)
    if (hit) return stamp(hit.body, sid)
    const res = await doFetch(origin + route, {
      headers: { 'x-tvine-internal': '1', cookie: `${cookieName}=${sessions.cookieFor(sid)}` },
    })
    if (res.status !== 200) throw new RegistryError('internal', `render failed (${res.status}) for ${route}`)
    const { personal, ...body } = extract(await res.text(), route)
    if (!personal) cache.set(route, body)
    return stamp(body, sid)
  }
}
