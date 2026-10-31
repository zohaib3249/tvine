// Admin URLs ↔ routes (Django admin layout). Query params follow Django where sensible:
// q = search, o = ordering (comma list, `-` desc), p = page, all = show all; every other key is a filter.
export type Route =
  | { name: 'index' }
  | { name: 'app'; app: string }
  | { name: 'changelist'; model: string }
  | { name: 'add'; model: string }
  | { name: 'change'; model: string; pk: string }
  | { name: 'delete'; model: string; pk: string }
  | { name: 'history'; model: string; pk: string }
  | { name: 'url'; model: string; url: string; args: Record<string, string> }
  | { name: 'page'; path: string }
  | { name: 'system'; page: SystemPage }
  | { name: 'notFound' }

export type Query = Record<string, string>
export const SYSTEM = ['health', 'traffic', 'metrics', 'agents', 'search', 'pages', 'queries', 'jobs', 'logs', 'security'] as const
export type SystemPage = (typeof SYSTEM)[number]
type Urls = { name: string; path: string }[]

// <int:id>/refund/ → regex with named groups (Django path converters).
const pattern = (p: string) => new RegExp('^' + p.replace(/^\/|\/$/g, '').replace(/<(?:\w+:)?(\w+)>/g, '(?<$1>[^/]+)') + '$')

export function parse(segments: string[], o: { pages?: { path: string }[]; urls?: (model: string) => Urls | undefined } = {}): Route {
  const s = segments.filter(Boolean).map(decodeURIComponent)
  const joined = s.join('/')
  const page = o.pages?.find((p) => p.path.replace(/^\/|\/$/g, '') === joined)
  if (page && s.length) return { name: 'page', path: page.path }
  if (s.length === 0) return { name: 'index' }
  // the System section wins over an app labelled 'system' only for its six page names
  if (s.length === 2 && s[0] === 'system' && (SYSTEM as readonly string[]).includes(s[1])) return { name: 'system', page: s[1] as SystemPage }
  if (s.length === 1) return { name: 'app', app: s[0] }
  const model = `${s[0]}.${s[1]}`
  const rest = s.slice(2)
  if (rest.length === 0) return { name: 'changelist', model }
  if (rest.length === 1 && rest[0] === 'add') return { name: 'add', model }
  if (rest.length === 2 && ['change', 'delete', 'history'].includes(rest[1])) return { name: rest[1] as 'change', model, pk: rest[0] }
  for (const u of o.urls?.(model) ?? []) {
    const m = pattern(u.path).exec(rest.join('/'))
    if (m) return { name: 'url', model, url: u.name, args: { ...m.groups } }
  }
  if (rest.length === 1) return { name: 'change', model, pk: rest[0] }   // Django: /<pk>/ redirects to change
  return { name: 'notFound' }
}

const enc = encodeURIComponent
export const modelPath = (base: string, model: string) => `${base}/${model.split('.').map(enc).join('/')}/`
export function href(base: string, r: Route, q?: Query): string {
  const qs = q && Object.keys(q).length ? '?' + new URLSearchParams(q).toString() : ''
  switch (r.name) {
    case 'index': case 'notFound': return `${base}/`
    case 'app': return `${base}/${enc(r.app)}/`
    case 'changelist': return modelPath(base, r.model) + qs
    case 'add': return modelPath(base, r.model) + 'add/'
    case 'change': case 'delete': case 'history': return `${modelPath(base, r.model)}${enc(r.pk)}/${r.name}/`
    case 'page': return `${base}/${r.path.replace(/^\/|\/$/g, '')}/`
    case 'system': return `${base}/system/${r.page}/`
    case 'url': return modelPath(base, r.model) + qs
  }
}
export const urlFor = (base: string, model: string, path: string, args: Record<string, string>) =>
  modelPath(base, model) + path.replace(/^\//, '').replace(/<(?:\w+:)?(\w+)>/g, (_, k) => enc(args[k] ?? ''))

export const RESERVED = new Set(['q', 'o', 'p', 'all', '_saved'])
export type ListParams = { model: string; q?: string; filters?: Record<string, string>; ordering?: string[]; page?: number; pageSize?: number; all?: boolean }
export function listParams(model: string, q: Query): ListParams {
  const filters: Record<string, string> = {}
  // tvine-approve / tvine-connect belong to the tab socket, never a filter
  for (const [k, v] of Object.entries(q)) if (!RESERVED.has(k) && !k.startsWith('tvine-') && v !== '') filters[k] = v
  return {
    model,
    ...(q.q && { q: q.q }),
    ...(Object.keys(filters).length && { filters }),
    ...(q.o && { ordering: q.o.split(',').filter(Boolean) }),
    ...(q.p && Number(q.p) > 1 && { page: Number(q.p) }),
    ...(q.all === '1' && { all: true }),
  }
}
export function queryOf(p: Omit<ListParams, 'model'>): Query {
  const q: Query = {}
  if (p.q) q.q = p.q
  if (p.ordering?.length) q.o = p.ordering.join(',')
  if (p.page && p.page > 1) q.p = String(p.page)
  if (p.all) q.all = '1'
  return { ...q, ...p.filters }
}
// Multi-sort like Django: clicking a column makes it primary; clicking the primary flips it; others keep their order.
export function toggleSort(o: string[], col: string, multi = true): string[] {
  const cur = o.find((x) => x.replace(/^-/, '') === col)
  const rest = o.filter((x) => x.replace(/^-/, '') !== col)
  const next = cur === undefined ? col : o[0] === cur ? (cur.startsWith('-') ? col : `-${col}`) : cur
  return multi ? [next, ...rest] : [next]
}
