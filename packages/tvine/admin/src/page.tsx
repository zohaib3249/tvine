// Server entry. Mount: app/admin/[[...path]]/page.tsx → `export { default, generateMetadata } from 'tvine/admin/page'`.
// First paint is server-rendered from api.* (in-process dispatch as the signed-in user); the client then navigates itself.
import { api } from '../../weft/dist/api/server.js'
import { AdminApp } from './app.js'
import { caller, loadRoute, loadSite } from './data.js'
import { parse, type Query } from './routes.js'

type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }
const flat = (sp: Record<string, string | string[] | undefined>): Query =>
  Object.fromEntries(Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v[0] : v]])))

export function adminPage(o: { base?: string } = {}) {
  const base = o.base ?? '/admin'
  return async function AdminPage({ params, searchParams }: Props) {
    const [{ path = [] }, sp] = await Promise.all([params, searchParams])
    const call = caller(api)
    const query = flat(sp)
    const { site, user, error } = await loadSite(call)
    if (!site) return <AdminApp base={base} segments={path} query={query} user={user} error={error} />
    let route = parse(path, { pages: site.pages })
    if (route.name === 'notFound' && path.length >= 3) {   // a getUrls view? needs the model's urls
      const m = await call('admin.meta', { model: `${path[0]}.${path[1]}` })
      if (m.ok) route = parse(path, { pages: site.pages, urls: () => (m.data as { urls?: { name: string; path: string }[] }).urls })
    }
    const initial = await loadRoute(call, site, route, query)
    return <AdminApp base={base} site={site} user={user} segments={path} query={query} initial={initial} />
  }
}

export default adminPage()

export async function generateMetadata() {
  const r = await api.admin.site({})
  const s = r.ok ? (r.data as { title?: string; header?: string }) : undefined
  return { title: s?.title ?? s?.header ?? 'Administration', robots: { index: false, follow: false } }
}
