// Django URLs (docs/design/conventions/urls.md): path / re_path / include / reverse, DRF routers. Every
// route names an action the manifest already holds; transport/urls dispatches it like POST /tvine/api/<id>.
// The project's urls.ts (next to settings.ts) is the ROOT_URLCONF; without one there are no URL routes.
import { dirname } from 'node:path'
import { appModule, importApp, isActionDef } from './core/actions.js'
import { installedApps } from './core/apps.js'
import type { ActionDef } from './core/types.js'
import { isViewClass, viewRoutes } from './views/generic.js'

type ViewClass = new () => object
export interface PathOpts { name?: string; methods?: string[] }
export interface UrlPattern { kind: 'path'; route: string; regex: boolean; view: ActionDef | ViewClass; name?: string; methods?: string[] }
export interface UrlInclude { kind: 'include'; route: string; module: string | UrlEntry[]; namespace?: string }
export type UrlEntry = UrlPattern | UrlInclude

// Django's default converters: regex + to_python. path matches across '/'.
const CONVERTERS: Record<string, { re: string; parse?: (s: string) => unknown }> = {
  int: { re: '[0-9]+', parse: Number },
  str: { re: '[^/]+' },
  slug: { re: '[-a-zA-Z0-9_]+' },
  uuid: { re: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' },
  path: { re: '.+' },
}
const DRF_LOOKUP = '[^/.]+'   // DRF lookup_value_regex default

export class NoReverseMatch extends Error { name = 'NoReverseMatch' }
export class ImproperlyConfigured extends Error { name = 'ImproperlyConfigured' }

type Part = string | { name: string; conv: string }
// '<int:id>/' → parts; an unknown converter or a bad group name throws now (Django: at path() time)
function parse(route: string): Part[] {
  const parts: Part[] = []
  let at = 0
  for (const m of route.matchAll(/<(?:([^>:]+):)?([^>]+)>/g)) {
    if (m.index > at) parts.push(route.slice(at, m.index))
    const conv = m[1] ?? 'str', name = m[2]!
    if (!CONVERTERS[conv] && conv !== 'lookup') throw new ImproperlyConfigured(`URL route '${route}' uses invalid converter '${conv}'.`)
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new ImproperlyConfigured(`URL route '${route}' uses parameter name '${name}' which isn't a valid identifier.`)
    parts.push({ name, conv })
    at = m.index + m[0].length
  }
  if (at < route.length) parts.push(route.slice(at))
  if (route.startsWith('/')) throw new ImproperlyConfigured(`URL route '${route}' has a route beginning with a '/'. Remove this slash.`)
  return parts
}

const isInclude = (v: unknown): v is Omit<UrlInclude, 'route'> => typeof v === 'object' && v !== null && (v as UrlInclude).kind === 'include'

export function path(route: string, view: ActionDef | ViewClass | Omit<UrlInclude, 'route'>, opts: PathOpts = {}): UrlEntry {
  parse(route)
  if (isInclude(view)) return { ...view, route } as UrlInclude
  if (!isActionDef(view) && !isViewClass(view)) throw new ImproperlyConfigured(`path('${route}'): the view must be an action, View.action('name') or a View class`)
  return { kind: 'path', route, regex: false, view, ...opts }
}

// Python (?P<name>…) groups are accepted; values arrive as strings; re_path routes are not reversible here.
export function re_path(route: string, view: ActionDef | ViewClass | Omit<UrlInclude, 'route'>, opts: PathOpts = {}): UrlEntry {
  const src = route.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P</g, '(?<')
  try { new RegExp(src) } catch (e) { throw new ImproperlyConfigured(`re_path '${route}': ${(e as Error).message}`) }
  if (isInclude(view)) return { ...view, route: src, regex: true } as UrlInclude & { regex: true }
  return { kind: 'path', route: src, regex: true, view, ...opts }
}

// 'catalog.urls' | 'tvine.auth.urls' | an urlpatterns array. namespace defaults to the module's appName.
export function include(module: string | UrlEntry[], opts: { namespace?: string } = {}): Omit<UrlInclude, 'route'> {
  return { kind: 'include', module, ...opts }
}

// ---- DRF routers -----------------------------------------------------------------------------------
export class SimpleRouter {
  protected registry: { prefix: string; view: ViewClass; basename: string }[] = []
  constructor(protected opts: { trailingSlash?: boolean } = {}) {}
  register(prefix: string, view: ViewClass, opts: { basename?: string } = {}): this {
    const basename = opts.basename ?? (new view() as { model?: { name?: string } }).model?.name?.toLowerCase()
    if (!basename) throw new ImproperlyConfigured(`router.register('${prefix}', ${view.name}): no model to derive a basename from; pass { basename }`)
    this.registry.push({ prefix, view, basename })
    return this
  }
  // read at boot (after discovery), like Django evaluating urlpatterns
  get urls(): UrlEntry[] {
    const slash = this.opts.trailingSlash === false ? '' : '/'
    const out: UrlEntry[] = []
    for (const { prefix, view, basename } of this.registry) {
      const { routes, lookup } = viewRoutes(view)
      const base = prefix ? `${prefix}${slash}` : ''
      const one = `${prefix ? `${prefix}/` : ''}<${lookup.int ? 'int' : 'lookup'}:${lookup.param}>${slash}`
      const add = (route: string, name: string, list: typeof routes) => {
        for (const r of list) out.push({ kind: 'path', route, regex: false, view: r.def, name, methods: r.methods })
      }
      add(base, `${basename}-list`, routes.filter((r) => !r.detail && ['list', 'create'].includes(r.name)))
      add(one, `${basename}-detail`, routes.filter((r) => r.detail && ['get', 'update', 'delete'].includes(r.name)))
      for (const r of routes.filter((x) => !['list', 'create', 'get', 'update', 'delete'].includes(x.name))) {
        add(r.detail ? `${one}${r.name}${slash}` : `${prefix ? `${prefix}/` : ''}${r.name}${slash}`, `${basename}-${r.name}`, [r])
      }
    }
    return out
  }
}
// ponytail: no API root view (DRF's DefaultRouter adds one at ''); add when a client needs the index.
export class DefaultRouter extends SimpleRouter {}

// ---- the resolved table -----------------------------------------------------------------------------
export interface Route {
  pattern: string                       // '/api/products/<int:id>/'
  re: RegExp
  parts?: Part[]                        // undefined: re_path (not reversible)
  convs: Record<string, string>
  methods: Map<string, ActionDef>
  name?: string                         // 'catalog:product-detail'
  file: string
}
export interface UrlTable { routes: Route[]; match(path: string): { route: Route; params: Record<string, unknown> }[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const reOf = (p: Part) => typeof p === 'string' ? esc(p) : `(?<${p.name}>${p.conv === 'lookup' ? DRF_LOOKUP : CONVERTERS[p.conv]!.re})`
const shown = (p: Part) => typeof p === 'string' ? p : `<${p.conv === 'lookup' ? 'str' : p.conv}:${p.name}>`

function methodsOf(e: UrlPattern, parts: Part[] | undefined): Map<string, ActionDef> {
  const m = new Map<string, ActionDef>()
  if (isActionDef(e.view)) {
    for (const x of e.methods?.map((s) => s.toUpperCase()) ?? [e.view.rules?.readOnly ? 'GET' : 'POST']) m.set(x, e.view)
    return m
  }
  // a View class: Django as_view() — GET list/retrieve, POST create, PUT/PATCH update, DELETE destroy;
  // detail when the route carries the view's lookup param
  const { routes, lookup } = viewRoutes(e.view)
  const detail = parts ? parts.some((p) => typeof p !== 'string' && p.name === lookup.param) : e.route.includes(`(?<${lookup.param}>`)
  for (const r of routes) if (r.detail === detail && ['list', 'create', 'get', 'update', 'delete'].includes(r.name)) for (const x of r.methods) m.set(x, r.def)
  return m
}

// Boot: the root urls.ts (dirname(appsDir)/urls) → a flat table. Every problem names its file.
export async function loadUrls(appsDir: string, installed: readonly string[] = []): Promise<UrlTable | undefined> {
  const root = appModule(dirname(appsDir), 'urls')
  if (!root) return undefined
  const apps = new Map(installedApps(appsDir, installed).map((a) => [a.contrib ? `tvine.${a.label}` : a.label, a.dir]))
  const routes: Route[] = []
  const load = async (file: string) => {
    try { return await importApp(file) } catch (e) { throw new ImproperlyConfigured(`${file}: ${(e as Error).message}`, { cause: e }) }
  }
  // prefix: Django parts while every route so far is a path(); a regex source once a re_path is involved
  const walk = async (entries: unknown, file: string, prefix: { src?: string; parts?: Part[] }, ns: string[]) => {
    if (!Array.isArray(entries)) throw new ImproperlyConfigured(`${file}: urlpatterns must be an array`)
    for (const e of entries as UrlEntry[]) {
      const isRe = !!(e as { regex?: boolean }).regex
      let parts: Part[] | undefined, src: string | undefined
      try {
        if (prefix.parts && !isRe) parts = [...prefix.parts, ...parse(e.route)]
        else src = (prefix.parts ? prefix.parts.map(reOf).join('') : prefix.src!) + (isRe ? e.route : parse(e.route).map(reOf).join(''))
      } catch (x) { throw new ImproperlyConfigured(`${file}: ${(x as Error).message}`) }
      if (e.kind === 'include') {
        let list = e.module, at = file, appName: string | undefined
        if (typeof list === 'string') {
          const spec = list
          const m = /^(.+)\.urls$/.exec(spec)
          const dir = m ? apps.get(m[1]!) : undefined
          const f = dir ? appModule(dir, 'urls') : undefined
          if (!f) throw new ImproperlyConfigured(`${file}: include('${spec}'): ${dir ? 'the app has no urls.ts' : m ? `no installed app '${m[1]}'` : "expected '<app>.urls'"}`)
          const mod = await load(f)
          list = mod.urlpatterns as UrlEntry[]
          appName = mod.appName as string | undefined
          at = f
        }
        const space = e.namespace ?? appName
        await walk(list, at, { src, parts }, space ? [...ns, space] : ns)
        continue
      }
      const shownAt = '/' + (parts ? parts.map(shown).join('') : src)
      const name = e.name && [...ns, e.name].join(':')
      const methods = methodsOf(e, parts)
      if (!methods.size) throw new ImproperlyConfigured(`${file}: '${shownAt}' maps no HTTP method`)
      for (const [m, d] of methods) if (m === 'GET' && !d.rules?.readOnly) throw new ImproperlyConfigured(`${file}: GET ${shownAt} → ${d.id} changes data; GET only reaches readOnly actions`)
      let re: RegExp
      try { re = new RegExp(`^/${parts ? parts.map(reOf).join('') : src}$`) } catch (x) { throw new ImproperlyConfigured(`${file}: ${shownAt}: ${(x as Error).message}`) }
      const convs = Object.fromEntries((parts ?? []).filter((p) => typeof p !== 'string').map((p) => [p.name, p.conv]))
      // one pattern + name written as several entries (a router's list + create) is one route with more methods
      const same = routes.find((r) => r.name === name && keyOf(r.re) === keyOf(re))
      if (!same) { routes.push({ pattern: shownAt, re, parts, convs, methods, name, file }); continue }
      for (const [m, d] of methods) {
        if (same.methods.has(m)) throw new ImproperlyConfigured(`${file}: ${m} ${shownAt} is already routed (${same.file})`)
        same.methods.set(m, d)
      }
    }
  }
  const mod = await load(root)
  await walk(mod.urlpatterns, root, { parts: [] }, [])
  check(routes)
  return table(routes)
}

const keyOf = (re: RegExp) => re.source.replace(/\(\?<\w+>/g, '(')

// two routes to the same pattern + method, or one name on two patterns → boot error
function check(routes: Route[]): void {
  const key = (r: Route) => keyOf(r.re)
  const seen = new Map<string, Route>(), names = new Map<string, Route>()
  for (const r of routes) {
    for (const m of r.methods.keys()) {
      const k = `${m} ${key(r)}`, o = seen.get(k)
      if (o) throw new ImproperlyConfigured(`${r.file}: ${m} ${r.pattern} is already routed (${o.file})`)
      seen.set(k, r)
    }
    if (!r.name) continue
    const o = names.get(r.name)
    if (o && key(o) !== key(r)) throw new ImproperlyConfigured(`${r.file}: URL name '${r.name}' is already used for ${o.pattern} (${o.file})`)
    names.set(r.name, r)
  }
}

const LIVE = Symbol.for('tvine.urls')   // like the live manifest: page bundles reverse() through the booted table
const g = globalThis as { [LIVE]?: UrlTable }
export const setLiveUrls = (t: UrlTable | undefined) => { g[LIVE] = t }

function table(routes: Route[]): UrlTable {
  return {
    routes,
    match(path) {
      const out: { route: Route; params: Record<string, unknown> }[] = []
      for (const route of routes) {
        const m = route.re.exec(path)
        if (!m) continue
        const params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, CONVERTERS[route.convs[k]!]?.parse?.(v) ?? v]))
        out.push({ route, params })
      }
      return out
    },
  }
}

// Django reverse('ns:name', kwargs): the first pattern of that name whose params are exactly the kwargs
// and whose converters accept them. Values are URL-quoted (path keeps its '/').
export function reverse(name: string, kwargs: Record<string, string | number> = {}, urls: UrlTable | undefined = g[LIVE]): string {
  const all = urls?.routes ?? []
  const same = all.filter((r) => r.name === name && r.parts)
  if (!same.length) {
    const ns = name.split(':').slice(0, -1)
    for (let i = 1; i <= ns.length; i++) {
      const p = ns.slice(0, i).join(':') + ':'
      if (!all.some((r) => r.name?.startsWith(p))) throw new NoReverseMatch(`'${ns.slice(0, i).join(':')}' is not a registered namespace`)
    }
    throw new NoReverseMatch(`Reverse for '${name}' not found. '${name}' is not a valid view function or pattern name.`)
  }
  const keys = Object.keys(kwargs).sort().join(',')
  for (const r of same) {
    const params = r.parts!.filter((p): p is Exclude<Part, string> => typeof p !== 'string')
    if (params.map((p) => p.name).sort().join(',') !== keys) continue
    const ok = params.every((p) => new RegExp(`^(?:${reOf({ ...p, name: 'x' })})$`).test(String(kwargs[p.name])))
    if (!ok) continue
    return '/' + r.parts!.map((p) => typeof p === 'string' ? p
      : String(kwargs[p.name]).split(p.conv === 'path' ? '/' : '\0').map(encodeURIComponent).join('/')).join('')
  }
  throw new NoReverseMatch(`Reverse for '${name}' with keyword arguments '${JSON.stringify(kwargs)}' not found. ${same.length} pattern(s) tried: ${JSON.stringify(same.map((r) => r.pattern))}`)
}
