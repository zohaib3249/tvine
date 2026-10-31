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
const READS = new Set(['admin.site', 'admin.list', 'admin.get', 'admin.deletePreview', 'admin.history', 'admin.autocomplete', 'admin.search', 'admin.recent', 'auth.me'])
export const caller = (api: unknown): Call => {
  const metas = new Map<string, Promise<ApiResult<any>>>()
  return (id, params) => {
    const i = id.indexOf('.')
    const go = () => (api as Record<string, Record<string, (p: unknown) => Promise<ApiResult>>>)[id.slice(0, i)][id.slice(i + 1)](params ?? {})
    if (id === 'admin.meta') {
      const k = JSON.stringify(params)
      let m = metas.get(k)
      if (!m) metas.set(k, (m = go().then((r) => { if (!r.ok) metas.delete(k); return r })))
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
    const ws = (site.widgets ?? []).filter((w) => w.data)
    const res = await Promise.all(ws.map((w) => typeof w.data === 'string' ? call(w.data) : call(w.data!.id, w.data!.params)))
    out.widgets = Object.fromEntries(ws.map((w, i) => [w.id, res[i].ok ? res[i].data : { error: (res[i] as { message: string }).message }]))
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
