'use client'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api as browserApi } from '../../weft/dist/api/client.js'
import { Dialog, Drawer, Menu, Toaster, toast } from '../../weft/dist/widgets/index.js'
import { caller, keyOf, loadRoute, loadSite, retryable, type Call, type RouteData } from './data.js'
import { href, parse, type Query, type Route } from './routes.js'
import type { ModelMeta, Site, User } from './types.js'
import { AdminCtx, useTheme, cap, Empty, ErrorBox, Icon, Region, Skeleton, Slotted, custom, cx, getConfig, slotClass, useAdmin, type Ctx } from './ui.js'
import { Changelist } from './changelist.js'
import { ChangeForm } from './form.js'
import { AppIndex, DeleteView, HistoryView, Login, PasswordChange } from './pages.js'
import { Dashboard } from './dashboard.js'
import { SystemView, systemPagesFor } from './system.js'

export type AdminAppProps = {
  base?: string; site?: Site; user?: User | null; segments: string[]; query: Query
  initial?: RouteData; error?: { code: string; message: string; reason?: string }
  api?: unknown   // tests / custom transports; default = the browser api.* client
}

const modelOf = (site: Site, key: string) => site.apps.flatMap((a) => a.models).find((m) => m.key === key)

export function AdminApp(p: AdminAppProps) {
  const call = useMemo<Call>(() => caller(p.api ?? browserApi), [p.api])
  const base = (p.base ?? '/admin').replace(/\/$/, '')
  const [site, setSite] = useState(p.site)
  const [siteError, setSiteError] = useState(p.error)
  const tries = useRef(0)
  const [user, setUser] = useState(p.user ?? null)
  useEffect(() => {
    if (site || !retryable(siteError)) return
    const wait = Math.min(30_000, Math.max((siteError as { retryAfterMs?: number }).retryAfterMs ?? 0, 2000 * 2 ** tries.current++)) + 250   // back-off
    toast({ title: 'The server is busy', description: `Retrying in ${Math.ceil(wait / 1000)} s…` })
    const t = setTimeout(() => { void loadSite(call).then((r) => { if (r.site) { setSite(r.site); setUser(r.user ?? null) } setSiteError(r.error) }) }, wait)
    return () => clearTimeout(t)
  }, [site, siteError, call])
  // auth.me can fail on its own (a rate limit) while admin.site answered: retry once
  useEffect(() => {
    if (!site || user) return
    const t = setTimeout(() => void call('auth.me').then((r) => { if (r.ok && r.data) setUser(r.data as User) }), 2000)
    return () => clearTimeout(t)
  }, [site])   // eslint-disable-line react-hooks/exhaustive-deps
  const [loc, setLoc] = useState({ segments: p.segments, query: p.query })
  const [data, setData] = useState<RouteData | undefined>(p.initial)
  const [tick, setTick] = useState(0)
  const urls = useRef(new Map<string, ModelMeta['urls']>())
  if (data?.meta) urls.current.set(data.meta.key, data.meta.urls)
  const route = useMemo(() => parse(loc.segments, { pages: site?.pages, urls: (m) => urls.current.get(m) }), [loc, site, data?.meta])
  const dirty = useRef(false)
  const [guard, setGuard] = useState<string | null>(null)

  // ---- navigation: client-side, history API (Next's App Router keeps usePathname in sync with pushState) --------------
  const go = useCallback((to: string, replace = false) => {
    const u = new URL(to, location.href)
    if (u.origin !== location.origin || !(u.pathname + '/').startsWith(base + '/')) { location.assign(u.href); return }
    history[replace ? 'replaceState' : 'pushState'](null, '', u.pathname + u.search)
    const segments = u.pathname.slice(base.length).split('/').filter(Boolean)
    setLoc({ segments, query: Object.fromEntries(u.searchParams) })
    if (!replace) document.querySelector('.tva main')?.scrollTo?.(0, 0)
  }, [base])
  const navigate = useCallback((to: string, o?: { replace?: boolean }) => {
    if (dirty.current) { setGuard(to); return }
    go(to, o?.replace)
  }, [go])
  useEffect(() => {
    const pop = () => setLoc({ segments: location.pathname.slice(base.length).split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(location.search)) })
    const unload = (e: BeforeUnloadEvent) => { if (dirty.current) e.preventDefault() }
    addEventListener('popstate', pop); addEventListener('beforeunload', unload)
    return () => { removeEventListener('popstate', pop); removeEventListener('beforeunload', unload) }
  }, [base])

  // ---- data: reuse the server's first paint, else load through api.* --------------------------------------------------
  const key = keyOf(route, loc.query) + ':' + tick
  useEffect(() => {
    if (!site) return
    if (data && data.key === keyOf(route, loc.query) && tick === 0 && data === p.initial) return
    let live = true
    void (async () => {
      if (route.name === 'notFound' && loc.segments.length >= 3) {   // maybe a getUrls view: learn the model's urls first
        const m = await call('admin.meta', { model: `${loc.segments[0]}.${loc.segments[1]}` })
        if (m.ok && live) { urls.current.set((m.data as ModelMeta).key, (m.data as ModelMeta).urls); setLoc((l) => ({ ...l })); return }
      }
      const d = await loadRoute(call, site, route, loc.query)
      if (live) setData(d)
    })()
    return () => { live = false }
  }, [key, site])   // eslint-disable-line react-hooks/exhaustive-deps

  const prefs = useMemo(() => {
    const store = getConfig().prefs
    const k = (n: string) => `tva:${p.user?.id ?? 'anon'}:${n}`
    return {
      get<T>(n: string, d: T): T {
        try { const v = store ? store.get(k(n)) : JSON.parse(localStorage.getItem(k(n)) ?? 'null'); return (v ?? d) as T } catch { return d }
      },
      set(n: string, v: unknown) { try { store ? store.set(k(n), v) : localStorage.setItem(k(n), JSON.stringify(v)) } catch { /* private mode */ } },
    }
  }, [p.user?.id])

  const ctx: Ctx = {
    call, site: site!, user, base, route, query: loc.query, navigate, prefs,
    setQuery: (q, o) => navigate(href(base, route, q), o),
    setDirty: (d) => { dirty.current = d },
    refresh: () => setTick((t) => t + 1),
  }

  // ---- theme ------------------------------------------------------------------------------------------------------
  const [theme, toggleTheme] = useTheme(site?.theme?.dark)
  const t = site?.theme
  const style = { ...(t?.brand && { '--tva-brand': t.brand }), ...(t?.radius !== undefined && { '--tva-radius': typeof t.radius === 'number' ? `${t.radius}px` : t.radius }) } as React.CSSProperties
  const root = (body: ReactNode) => <div className={cx('tva', slotClass('shell'))} data-theme={theme} style={style}>{body}<Toaster name="toasts" label="Notifications" /></div>

  if (!site) {
    // Login only when the API says who you are is the problem; a rate limit or an outage retries with back-off
    if (retryable(siteError)) return root(<Retrying error={siteError!} />)
    return root(<Login error={siteError} user={user ?? null} call={call} onDone={() => location.reload()} />)
  }

  return (
    <AdminCtx.Provider value={ctx}>
      {root(<>
        <div className="flex h-full">
          <Slotted slot="sidebar">
            <aside className={cx('hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex', slotClass('sidebar'))}>
              <Brand />
              <Nav id="admin:nav" />
            </aside>
          </Slotted>
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onTheme={toggleTheme} theme={theme} />
            <main id="tva-main" className={cx('min-h-0 flex-1 overflow-auto', slotClass('main'))}>
              <div className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
                <Crumbs meta={data?.meta} obj={data?.obj?.display} />
                <div key={JSON.stringify(route)} className="tva-page-enter"><View route={route} data={data?.key === keyOf(route, loc.query) ? data : undefined} /></div>
              </div>
            </main>
          </div>
        </div>
        <Palette onTheme={toggleTheme} />
        <Shortcuts />
        <Dialog name="unsaved" label="Unsaved changes" open={guard !== null} onOpenChange={(o) => { if (!o) setGuard(null) }} slots={{ trigger: { className: 'hidden' } }}>
          <h2 className="text-lg font-semibold">Discard unsaved changes?</h2>
          <p className="mt-1 text-muted">You have edits on this page that are not saved.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" agentId="stay" className="tva-btn" onClick={() => setGuard(null)}>Keep editing</button>
            <button type="button" agentId="discard" className="tva-btn tva-btn-danger-solid" onClick={() => { const to = guard!; dirty.current = false; setGuard(null); go(to) }}>Discard</button>
          </div>
        </Dialog>
      </>)}
    </AdminCtx.Provider>
  )
}

function Brand() {
  const { site, base, navigate } = useAdmin()
  return (
    <a href={`${base}/`} agentId="home" onClick={(e) => { e.preventDefault(); navigate(`${base}/`) }} className="flex h-14 items-center gap-2.5 border-b border-line px-4">
      {getConfig().brandLogo ?? <span className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-fg">{site.header.slice(0, 1)}</span>}
      <span className="truncate font-semibold">{site.header}</span>
    </a>
  )
}

export function Nav({ id, onPick }: { id: string; onPick?: () => void }) {
  const { site, base, route, navigate, user } = useAdmin()
  const [q, setQ] = useState('')
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase())
  const cur = 'model' in route ? route.model : route.name === 'page' ? `page:${route.path}` : route.name === 'app' ? `app:${route.app}` : route.name === 'system' ? `system:${route.page}` : 'home'
  const sys = systemPagesFor(user).filter((x) => match(x.title))
  const link = (to: string, label: string, agentId: string, active: boolean, icon: string) => (
    <a href={to} agentId={agentId} aria-current={active ? 'page' : undefined} className="tva-nav-link" onClick={(e) => { e.preventDefault(); onPick?.(); navigate(to) }}>
      <Icon name={icon} /><span className="truncate">{label}</span>
    </a>
  )
  const sections = new Map<string, NonNullable<Site['pages']>>()
  for (const pg of site.pages ?? []) sections.set(pg.section ?? 'Pages', [...(sections.get(pg.section ?? 'Pages') ?? []), pg])
  return (
    <Region id={id} as="nav" label="Admin navigation" aria-label="Admin" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <input type="search" agentId="filter" aria-label="Filter models" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="tva-input h-8 text-[13px]" />
      <div>{link(`${base}/`, 'Dashboard', 'dashboard', cur === 'home', 'home')}</div>
      {site.apps.map((a) => {
        const models = a.models.filter((m) => m.perms.view && (match(m.namePlural) || match(a.name)))
        if (!models.length) return null
        return (
          <div key={a.label}>
            <a href={href(base, { name: 'app', app: a.label })} agentId={`app-${a.label}`} onClick={(e) => { e.preventDefault(); onPick?.(); navigate(href(base, { name: 'app', app: a.label })) }}
              className="mb-1 block px-2 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-fg">{a.name}</a>
            {models.map((m) => <div key={m.key}>{link(href(base, { name: 'changelist', model: m.key }), cap(m.namePlural), m.key, cur === m.key, 'grid')}</div>)}
          </div>
        )
      })}
      {[...sections].map(([s, pages]) => (
        <div key={s}>
          <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{s}</p>
          {pages.filter((pg) => match(pg.title)).map((pg) => <div key={pg.path}>{link(href(base, { name: 'page', path: pg.path }), pg.title, `page-${pg.path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}`, cur === `page:${pg.path}`, pg.icon ?? 'file')}</div>)}
        </div>
      ))}
      {sys.length > 0 && (
        <div>
          <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">System</p>
          {sys.map((x) => <div key={x.page}>{link(href(base, { name: 'system', page: x.page }), x.title, `system-${x.page}`, cur === `system:${x.page}`, x.icon)}</div>)}
        </div>
      )}
    </Region>
  )
}

function Topbar({ onTheme, theme }: { onTheme(): void; theme: string }) {
  const { site, user, call } = useAdmin()
  const [menu, setMenu] = useState(false)
  const logout = async () => { await call('auth.logout'); location.assign(site.siteUrl ?? '/') }
  return (
    <Slotted slot="topbar">
      <Region id="admin:topbar" as="header" label="Top bar" className={cx('sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:px-4', slotClass('topbar'))}>
        <Drawer name="menu" label="Menu" side="left" open={menu} onOpenChange={setMenu}
          trigger={<><Icon name="menu" size={18} /><span className="sr-only">Open menu</span></>} slots={{ trigger: { className: 'tva-btn tva-btn-ghost tva-btn-icon lg:hidden' } }}>
          <div className="flex h-full flex-col"><Brand /><Nav id="admin:menu" onPick={() => setMenu(false)} /></div>
        </Drawer>
        <span className="truncate font-semibold lg:hidden">{site.header}</span>
        <div className="flex-1" />
        <button type="button" agentId="palette" onClick={() => dispatchEvent(new CustomEvent('tva:palette'))}
          className="tva-btn h-9 w-9 justify-start px-0 text-muted sm:w-64 sm:px-3" aria-label="Search and commands">
          <Icon name="search" className="mx-auto sm:mx-0" /><span className="hidden flex-1 text-left sm:inline">Jump to…</span><kbd className="tva-kbd hidden sm:inline">⌘K</kbd>
        </button>
        <button type="button" agentId="theme" aria-label="Toggle dark mode" onClick={onTheme} className="tva-btn tva-btn-ghost tva-btn-icon">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        {site.siteUrl && <a href={site.siteUrl} agentId="view-site" className="tva-btn tva-btn-ghost hidden md:inline-flex"><Icon name="ext" />View site</a>}
        <Menu name="user" label="Account"
          trigger={<span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-accent">{(user?.username ?? '?').slice(0, 1).toUpperCase()}</span><span className="hidden max-w-32 truncate sm:inline">{user?.username}</span></span>}
          slots={{ trigger: { className: 'tva-btn tva-btn-ghost px-2' } }}
          items={[
            ...(site.siteUrl ? [{ id: 'site', label: 'View site', onSelect: () => location.assign(site.siteUrl!) }] : []),
            { id: 'theme', label: 'Toggle dark mode', onSelect: onTheme },
            { id: 'logout', label: 'Log out', onSelect: () => void logout() },
          ]} />
      </Region>
    </Slotted>
  )
}

function Crumbs({ meta, obj }: { meta?: ModelMeta; obj?: string }) {
  const { route, base, site, navigate } = useAdmin()
  if (route.name === 'index') return null
  const items: [string, string?][] = [['Home', `${base}/`]]
  if ('model' in route) {
    const [app] = route.model.split('.')
    items.push([site.apps.find((a) => a.label === app)?.name ?? app, href(base, { name: 'app', app })])
    items.push([cap(meta?.namePlural ?? modelOf(site, route.model)?.namePlural ?? route.model.split('.')[1]), route.name === 'changelist' ? undefined : href(base, { name: 'changelist', model: route.model })])
    if (route.name === 'add') items.push([`Add ${meta?.name ?? ''}`])
    if ('pk' in route) items.push([obj ?? route.pk, route.name === 'change' ? undefined : href(base, { name: 'change', model: route.model, pk: route.pk })])
    if (route.name === 'delete' || route.name === 'history') items.push([route.name === 'delete' ? 'Delete' : 'History'])
    if (route.name === 'url') items.push([meta?.urls?.find((u) => u.name === route.url)?.title ?? route.url])
  } else if (route.name === 'app') items.push([site.apps.find((a) => a.label === route.app)?.name ?? route.app])
  else if (route.name === 'page') items.push([site.pages?.find((pg) => pg.path === route.path)?.title ?? route.path])
  else if (route.name === 'system') items.push(['System'], [route.page.charAt(0).toUpperCase() + route.page.slice(1)])
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-[13px] text-muted">
      {items.map(([label, to], i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <Icon name="chevron" size={12} />}
          {to ? <a href={to} agentId={`crumb-${i}`} className="hover:text-fg hover:underline" onClick={(e) => { e.preventDefault(); navigate(to) }}>{label}</a> : <span aria-current="page" className="text-fg">{label}</span>}
        </span>
      ))}
    </nav>
  )
}

const lazyCache = new Map<string, ReturnType<typeof lazy>>()
// screens for the contrib admins' getUrls views, so the Warp-served panel needs no configureAdmin (an app's own wins)
const BUILTIN: Record<string, React.ComponentType<any>> = { 'auth.user:password_change': PasswordChange }
export function CustomComponent({ name, data, args, meta }: { name: string; data?: unknown; args?: Record<string, string>; meta?: ModelMeta }) {
  const ctx = useAdmin()
  const C = getConfig().components?.[name] ?? BUILTIN[name]
  if (!C) return <Empty title="No component registered" icon="file">Register <code className="tva-kbd">{name}</code> with <code className="tva-kbd">configureAdmin({'{ components }'})</code>.</Empty>
  return <Suspense fallback={<Skeleton rows={4} />}><C {...custom(ctx, meta)} data={data} args={args} /></Suspense>
}
// Accept lazy loaders too: configureAdmin({ components: { 'reports#Export': lazyComponent(() => import('./reports')) } })
export function lazyComponent<P>(load: () => Promise<{ default: React.ComponentType<P> }>) {
  const k = load.toString()
  if (!lazyCache.has(k)) lazyCache.set(k, lazy(load as () => Promise<{ default: React.ComponentType<any> }>))
  return lazyCache.get(k)! as unknown as React.ComponentType<P>
}

function View({ route, data }: { route: Route; data?: RouteData }) {
  const { site } = useAdmin()
  if (route.name === 'page') {
    const pg = site.pages?.find((x) => x.path === route.path)!
    return <Region id={`admin:page:${pg.path.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '')}`} label={pg.title}><h1 className="mb-4 text-xl font-semibold">{pg.title}</h1><CustomComponent name={pg.component} /></Region>
  }
  if (route.name === 'notFound') return <Empty title="Page not found" icon="search">This admin page does not exist.</Empty>
  if (route.name === 'index') return <Dashboard data={data} />
  if (route.name === 'system') return <SystemView page={route.page} />
  if (route.name === 'app') return <AppIndex app={route.app} />
  if (!data) return <div className="tva-card"><Skeleton rows={8} /></div>
  if (!data.meta) return data.error ? <ErrorBox error={data.error} /> : <Skeleton />
  switch (route.name) {
    case 'changelist': return <Changelist meta={data.meta} list={data.list} error={data.error} />
    case 'add': case 'change': return data.error && !data.obj && route.name === 'change' ? <ErrorBox error={data.error} /> : <ChangeForm key={JSON.stringify(route)} meta={data.meta} obj={data.obj} />
    case 'delete': return <DeleteView meta={data.meta} obj={data.obj} preview={data.preview} error={data.error} pk={route.pk} />
    case 'history': return <HistoryView meta={data.meta} obj={data.obj} rows={data.history} pk={route.pk} />
    case 'url': {
      const u = data.meta.urls?.find((x) => x.name === route.url)
      return <Region id={`admin:view:${route.url}`} label={u?.title ?? route.url}><h1 className="mb-4 text-xl font-semibold">{u?.title}</h1><CustomComponent name={`${data.meta.key}:${route.url}`} args={route.args} meta={data.meta} data={data.obj} /></Region>
    }
  }
}

// ---- ⌘K command palette -------------------------------------------------------------------------------------------
type Cmd = { id: string; label: string; hint: string; icon: string; run(): void }
function Palette({ onTheme }: { onTheme(): void }) {
  const { site, base, navigate, prefs, call, user } = useAdmin()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  useEffect(() => {
    const f = () => { setQ(''); setHi(0); setOpen(true) }
    addEventListener('tva:palette', f)
    return () => removeEventListener('tva:palette', f)
  }, [])
  const go = (to: string) => () => { setOpen(false); navigate(to) }
  const cmds: Cmd[] = useMemo(() => {
    if (!open) return []
    const out: Cmd[] = []
    for (const a of site.apps) for (const m of a.models) {
      if (m.perms.view) out.push({ id: `model:${m.key}`, label: cap(m.namePlural), hint: a.name, icon: 'grid', run: go(href(base, { name: 'changelist', model: m.key })) })
      if (m.perms.add) out.push({ id: `add:${m.key}`, label: `Add ${m.name}`, hint: 'Action', icon: 'plus', run: go(href(base, { name: 'add', model: m.key })) })
    }
    for (const pg of site.pages ?? []) out.push({ id: `page:${pg.path}`, label: pg.title, hint: pg.section ?? 'Page', icon: pg.icon ?? 'file', run: go(href(base, { name: 'page', path: pg.path })) })
    for (const x of systemPagesFor(user)) out.push({ id: `system:${x.page}`, label: x.title, hint: 'System', icon: x.icon, run: go(href(base, { name: 'system', page: x.page })) })
    for (const r of prefs.get<{ model: string; pk: string; display: string }[]>('recent', [])) {
      out.push({ id: `recent:${r.model}:${r.pk}`, label: r.display, hint: `Recent · ${r.model}`, icon: 'clock', run: go(href(base, { name: 'change', model: r.model, pk: r.pk })) })
    }
    out.push({ id: 'theme', label: 'Toggle dark mode', hint: 'Action', icon: 'moon', run: () => { setOpen(false); onTheme() } })
    out.push({ id: 'logout', label: 'Log out', hint: 'Action', icon: 'logout', run: () => { void call('auth.logout').then(() => location.assign(site.siteUrl ?? '/')) } })
    return out
  }, [open, site])   // eslint-disable-line react-hooks/exhaustive-deps
  const shown = cmds.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30)
  return (
    <Dialog name="palette" label="Command palette" open={open} onOpenChange={setOpen} slots={{ trigger: { className: 'hidden' }, content: { className: 'tva-palette' } }}>
      <div className="flex items-center gap-2 border-b border-line px-4">
        <Icon name="search" className="text-muted" />
        <input autoFocus agentId="query" aria-label="Search commands" placeholder="Jump to a model, object or action…" value={q}
          onChange={(e) => { setQ(e.target.value); setHi(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
            if (e.key === 'Enter') shown[hi]?.run()
          }}
          className="h-12 flex-1 bg-transparent text-[15px] outline-none" />
      </div>
      <ul role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-2">
        {shown.length === 0 && <li className="p-6 text-center text-muted">No matches</li>}
        {shown.map((c, i) => (
          <li key={c.id}>
            <button type="button" role="option" agentId={c.id} aria-selected={i === hi} onMouseEnter={() => setHi(i)} onClick={c.run}
              className={cx('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', i === hi && 'bg-brand-soft text-accent')}>
              <Icon name={c.icon} /><span className="flex-1 truncate">{c.label}</span><span className="text-xs text-muted">{c.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-3 border-t border-line px-4 py-2 text-xs text-muted"><span><kbd className="tva-kbd">↑↓</kbd> move</span><span><kbd className="tva-kbd">↵</kbd> open</span><span><kbd className="tva-kbd">esc</kbd> close</span></div>
    </Dialog>
  )
}

// ⌘K palette · / search · n new (changelist) · ⌘S save (form) · g d dashboard
function Shortcuts() {
  const { route, base, navigate } = useAdmin()
  const last = useRef('')
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable=true]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dispatchEvent(new CustomEvent('tva:palette')); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        const b = document.getElementById('tva-save-continue')
        if (b) { e.preventDefault(); b.click() }
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') { const s = document.getElementById('tva-search'); if (s) { e.preventDefault(); s.focus() } }
      if (e.key === 'n' && route.name === 'changelist') navigate(href(base, { name: 'add', model: route.model }))
      if (last.current === 'g' && e.key === 'd') navigate(`${base}/`)
      last.current = e.key
    }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [route, base, navigate])
  return null
}

export { toast }

export { retryable }
function Retrying({ error }: { error: { code: string; message: string } }) {
  return (
    <div role="status" className="grid h-full place-items-center p-6">
      <div className="tva-card max-w-sm p-6 text-center">
        <p className="font-semibold">{error.code === 'rate_limited' ? 'Too many requests right now' : 'The server did not answer'}</p>
        <p className="mt-1 text-muted">Trying again automatically…</p>
      </div>
    </div>
  )
}
