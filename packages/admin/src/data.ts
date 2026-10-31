// One loader for both sides: the server page calls it for the first paint, the client after each navigation.
// Every read goes through api.* (admin.md §2); nothing here knows about models or the ORM.
import type { ApiResult } from '@tvine/weft/api'
import { listParams, type Query, type Route } from './routes.js'
import type { DeletePreview, ListResult, LogEntry, ModelMeta, ObjectData, Site, User } from './types.js'

export type Call = (id: string, params?: unknown) => Promise<ApiResult<any>>
// api.<app>.<name> by full id ("admin.list"), so action ids from the backend (widgets' data) work too.
// admin.meta is cached per model for the life of this caller (one browser page, or one server render — never shared
// between users). Any call that is not a read may change perms or filter choices, so it drops the cache; a schema change
// means a server restart, which the next page load picks up.
const READS = new Set(['admin.site', 'admin.list', 'admin.get', 'admin.deletePreview', 'admin.history', 'admin.autocomplete', 'admin.search', 'admin.recent', 'auth.me', 'admin.dashboard', 'admin.chart', 'admin.charts', 'admin.widget', 'admin.prefs',
  'admin.system.health', 'admin.system.logs', 'admin.system.agents', 'admin.system.metrics', 'admin.system.jobs', 'admin.system.security', 'admin.system.traffic', 'admin.system.queries'])
export const caller = (api: unknown): Call => {
  const metas = new Map<string, Promise<ApiResult<any>>>()
  return (id, params) => {
    const i = id.indexOf('.')
    const go = () => (api as Record<string, Record<string, (p: unknown) => Promise<ApiResult>>>)[id.slice(0, i)][id.slice(i + 1)](params ?? {})
    if (id === 'admin.meta' || id === 'admin.charts') {   // charts: the chart list per model is as static as meta
      const k = id + JSON.stringify(params)
      let m = metas.get(k)
      if (!m) metas.set(k, (m = go().then((r) => { if (!r.ok && id === 'admin.meta') metas.delete(k); return r })))
      return m
    }
    if (!READS.has(id)) metas.clear()
    return go()
  }
}

export type RouteData = {
  key: string
  meta?: ModelMeta; list?: ListResult; obj?: ObjectData; preview?: DeletePreview; history?: LogEntry[]
  widgets?: Record<string, unknown>
  dashboard?: DashboardData   // admin.dashboard
  error?: { code: string; message: string; reason?: string }
}
export const keyOf = (r: Route, q: Query) => JSON.stringify([r, r.name === 'changelist' ? q : {}])

export async function loadSite(call: Call): Promise<{ site?: Site; user?: User | null; error?: RouteData['error'] }> {
  const [s, u] = await Promise.all([call('admin.site'), call('auth.me')])
  const user = u.ok ? (u.data as User | null) : null
  return s.ok ? { site: s.data as Site, user } : { user, error: { code: s.code, message: s.message, reason: s.reason } }
}

export async function loadRoute(call: Call, site: Site, r: Route, q: Query): Promise<RouteData> {
  const key = keyOf(r, q)
  const out: RouteData = { key }
  const take = <T>(res: ApiResult<any>): T | undefined => {
    if (res.ok) return res.data as T
    out.error ??= { code: res.code, message: res.message, reason: res.reason }
    return undefined
  }
  if (r.name === 'index') {
    const d = await loadDashboard(call, site)
    out.dashboard = d
    out.widgets = await loadWidgets(call, d.widgets.filter((w) => !d.layout?.hidden.includes(w.id)), DEFAULT_RANGE)
    return out
  }
  if (!('model' in r)) return out
  const pk = 'pk' in r ? r.pk : r.name === 'url' ? r.args.id ?? r.args.pk : undefined
  const [m, a, b] = await Promise.all([
    call('admin.meta', { model: r.model }),
    r.name === 'changelist' ? call('admin.list', listParams(r.model, q)) : pk !== undefined && r.name !== 'add' ? call('admin.get', { model: r.model, pk }) : null,
    r.name === 'delete' ? call('admin.deletePreview', { model: r.model, pks: [r.pk] })
      : r.name === 'history' ? call('admin.history', { model: r.model, pk: r.pk }) : null,
  ])
  out.meta = take<ModelMeta>(m)
  if (a) r.name === 'changelist' ? (out.list = take<ListResult>(a)) : (out.obj = take<ObjectData>(a))
  if (b) r.name === 'delete' ? (out.preview = take<DeletePreview>(b)) : (out.history = take<LogEntry[]>(b))
  return out
}

// ---- dashboard (dashboard.tsx renders it) ----------------------------------------------------------------------
export type Size = 'sm' | 'md' | 'lg' | 'xl'
export type DashWidget = {
  id: string; title: string; size: Size; type: 'line' | 'area' | 'bar' | 'stacked' | 'donut' | 'stat' | 'table' | 'activity' | 'custom' | 'value'
  data?: { id: string; params?: Record<string, unknown> }; refreshMs?: number; component?: string; model?: string
}
export type Layout = { order: string[]; hidden: string[]; sizes: Record<string, Size> }
export type DashboardData = { widgets: DashWidget[]; layout: Layout | null; autoRefreshMs: number }
export type Range = '1h' | '24h' | '7d' | '30d' | '90d' | { from: string; to: string }
export const DEFAULT_RANGE: Range = '30d'

// only the chart actions take a range; anything else gets its own params untouched
const paramsOf = (w: DashWidget, range: Range) => ({ ...w.data!.params, ...(['admin.chart', 'admin.widget'].includes(w.data!.id) && { range }) })
export async function loadWidgets(call: Call, ws: DashWidget[], range: Range): Promise<Record<string, unknown>> {
  const live = ws.filter((w) => w.data)
  const res = await Promise.all(live.map((w) => call(w.data!.id, paramsOf(w, range))))
  return Object.fromEntries(live.map((w, i) => [w.id, res[i]!.ok ? res[i]!.data : { error: (res[i] as { message: string }).message }]))
}
// admin.dashboard, or (an older backend / a test) the site's registered widgets
export async function loadDashboard(call: Call, site: { widgets?: { id: string; title: string; size?: string; data?: { id: string; params?: Record<string, unknown> } | string; component?: string }[] }): Promise<DashboardData> {
  const r = await call('admin.dashboard')
  if (r.ok) return r.data as DashboardData
  return {
    autoRefreshMs: 60_000, layout: null,
    widgets: (site.widgets ?? []).map((w) => ({ id: w.id, title: w.title, size: (w.size ?? 'sm') as Size, type: w.component ? 'custom' : 'value', component: w.component,
      data: typeof w.data === 'string' ? { id: w.data } : w.data })),
  }
}

