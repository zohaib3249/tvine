'use client'
// The Shield panel (tvine.shield): its own app at settings.shield.panel.path (default /shield), built from the admin's
// sources (theme, charts, live hook, login, widgets). Gate: not signed in → the panel login; signed in but the panel
// access condition says no → a 403 page; else the pages. Every shield.* action re-checks access on the server.
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api as browserApi } from '../../../weft/dist/api/client.js'
import { Drawer, Menu, Toaster } from '../../../weft/dist/widgets/index.js'
import { caller, type Call } from '../data.js'
import { Login } from '../login.js'
import type { User } from '../types.js'
import { Icon, Region, cx, useTheme } from '../ui.js'
import { retryable } from '../data.js'
import { Ctx, useShield, type Query, type ShieldCtx } from './ctx.js'
import { Overview } from './overview.js'
import { RuleEditor, Rules } from './rules.js'
import { Bots, Denied, Lists, Settings, TestRequest } from './pages.js'
import { Events, IpProfile } from './events.js'
import type { ShieldSettings } from './types.js'

export type ShieldAppProps = { base?: string; segments: string[]; query?: Query; api?: unknown }
export const PAGES = [
  { page: '', title: 'Analytics', icon: 'chart', section: 'Monitor' }, { page: 'events', title: 'Events', icon: 'table', section: 'Monitor' },
  { page: 'rules', title: 'Rules', icon: 'sliders', section: 'Protect' }, { page: 'bots', title: 'Bots & AI', icon: 'bot', section: 'Protect' },
  { page: 'lists', title: 'Lists', icon: 'logs', section: 'Protect' },
  { page: 'test', title: 'Test a request', icon: 'play', section: 'Tools' }, { page: 'settings', title: 'Settings', icon: 'shield', section: 'Tools' },
] as const

export const ShieldMark = ({ size = 32 }: { size?: number }) => (
  <span className="tvs-mark grid place-items-center rounded-lg" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.8 4.5 5.6v6c0 4.9 3.2 8.4 7.5 9.6 4.3-1.2 7.5-4.7 7.5-9.6v-6z" fill="currentColor" fillOpacity=".18" /><path d="m8.6 12.2 2.4 2.4 4.6-4.8" />
    </svg>
  </span>
)

type Gate = { state: 'loading' } | { state: 'login'; user: User | null; error?: { code: string; message: string; reason?: string } } | { state: 'denied'; user: User } | { state: 'retry'; message: string } | { state: 'ok'; user: User; settings: ShieldSettings }

export function ShieldApp(p: ShieldAppProps) {
  const call = useMemo<Call>(() => caller(p.api ?? browserApi), [p.api])
  const base = (p.base ?? '/shield').replace(/\/$/, '')
  const [gate, setGate] = useState<Gate>({ state: 'loading' })
  const [theme, toggleTheme] = useTheme()
  const [loc, setLoc] = useState({ segments: p.segments, query: p.query ?? {} })

  const check = useCallback(async () => {
    const me = await call('auth.me')
    const user = me.ok ? (me.data as User | null) : null
    if (!user) return setGate(!me.ok && retryable(me) ? { state: 'retry', message: me.message } : { state: 'login', user: null })
    const s = await call('shield.settings.get')   // the access probe: the server applies the panel access condition
    if (s.ok) return setGate({ state: 'ok', user, settings: s.data as ShieldSettings })
    if (s.reason === 'forbidden' || s.code === 'domain' && /forbidden|permission/i.test(s.message)) return setGate({ state: 'denied', user })
    if (retryable(s)) return setGate({ state: 'retry', message: s.message })
    setGate({ state: 'login', user, error: { code: s.code, message: s.message, reason: s.reason } })
  }, [call])
  useEffect(() => { void check() }, [check])
  useEffect(() => {   // a rate limit / outage: try again, never a login screen
    if (gate.state !== 'retry') return
    const t = setTimeout(() => void check(), 3000)
    return () => clearTimeout(t)
  }, [gate, check])

  const go = useCallback((to: string, replace = false) => {
    const u = new URL(to, location.href)
    if (u.origin !== location.origin || !(u.pathname + '/').startsWith(base + '/')) { location.assign(u.href); return }
    history[replace ? 'replaceState' : 'pushState'](null, '', u.pathname + u.search)
    setLoc({ segments: u.pathname.slice(base.length).split('/').filter(Boolean), query: Object.fromEntries(u.searchParams) })
    if (!replace) document.getElementById('tvs-main')?.scrollTo?.(0, 0)
  }, [base])
  useEffect(() => {
    const pop = () => setLoc({ segments: location.pathname.slice(base.length).split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(location.search)) })
    addEventListener('popstate', pop)
    return () => removeEventListener('popstate', pop)
  }, [base])

  const root = (body: ReactNode) => <div className="tva tvs" data-theme={theme}>{body}<Toaster name="toasts" label="Notifications" /></div>
  if (gate.state === 'loading') return root(<div className="grid h-full place-items-center" aria-busy="true"><ShieldMark size={44} /></div>)
  if (gate.state === 'retry') return root(<div role="status" className="grid h-full place-items-center p-6"><div className="tva-card max-w-sm p-6 text-center"><p className="font-semibold">The server did not answer</p><p className="mt-1 text-muted">Trying again automatically…</p></div></div>)
  if (gate.state === 'login') return root(<Login id="shield:login" title="Shield" mark={<ShieldMark size={36} />} user={gate.user} error={gate.error} call={call} onDone={() => void check()}
    note="Sign in to manage bot protection. Who may open this panel is set by the panel access condition (Settings)." />)
  if (gate.state === 'denied') return root(<Denied user={gate.user} call={call} onTheme={toggleTheme} />)

  const ctx: ShieldCtx = {
    call, base, user: gate.user, query: loc.query, settings: gate.settings,
    setSettings: (settings) => setGate({ ...gate, settings }),
    navigate: (to) => go(to),
    setQuery: (q) => { const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined)).toString(); go(location.pathname + (s ? `?${s}` : ''), true) },
  }
  const [page = '', sub] = loc.segments
  return (
    <Ctx.Provider value={ctx}>
      {root(
        <div className="flex h-full">
          <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex"><Brand /><Nav id="shield:nav" page={page} /></aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar page={page} onTheme={toggleTheme} theme={theme} />
            <main id="tvs-main" className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
                <div key={page + (sub ? '/edit' : '')} className="tva-page-enter"><View page={page} sub={sub} /></div>
              </div>
            </main>
          </div>
        </div>,
      )}
    </Ctx.Provider>
  )
}

function View({ page, sub }: { page: string; sub?: string }) {
  switch (page) {
    case '': return <Overview />
    case 'rules': return sub ? <RuleEditor id={sub} /> : <Rules />
    case 'bots': return <Bots />
    case 'lists': return <Lists />
    case 'events': return <Events />
    case 'ip': return sub ? <IpProfile ip={decodeURIComponent(sub)} /> : <Events />
    case 'test': return <TestRequest />
    case 'settings': return <Settings />
    default: return <div className="tva-card p-8 text-center text-muted">This Shield page does not exist.</div>
  }
}

function Brand() {
  const { base, navigate } = useShield()
  return (
    <a href={`${base}/`} agentId="home" onClick={(e) => { e.preventDefault(); navigate(`${base}/`) }} className="flex h-14 items-center gap-2.5 border-b border-line px-4">
      <ShieldMark /><span className="flex flex-col leading-tight"><span className="font-semibold">Shield</span><span className="text-[11px] text-muted">Security · bot protection</span></span>
    </a>
  )
}

function Nav({ id, page, onPick }: { id: string; page: string; onPick?(): void }) {
  const { base, navigate } = useShield()
  return (
    <Region id={id} as="nav" label="Shield navigation" aria-label="Shield" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3">
      {PAGES.map((x, i) => {
        const to = `${base}/${x.page ? `${x.page}/` : ''}`
        const on = page === x.page || (x.page === 'events' && page === 'ip')
        return (
          <Fragment key={x.page}>
            {PAGES[i - 1]?.section !== x.section && <p className={cx('tvs-nav-h', i > 0 && 'mt-3')}>{x.section}</p>}
            <a href={to} agentId={x.page || 'analytics'} aria-current={on ? 'page' : undefined} className="tva-nav-link"
              onClick={(e) => { e.preventDefault(); onPick?.(); navigate(to) }}><Icon name={x.icon} /><span className="truncate">{x.title}</span></a>
          </Fragment>
        )
      })}
      <div className="flex-1" />
      <a href="/admin/" agentId="open-admin" className="tva-nav-link text-[13px]"><Icon name="ext" />Admin</a>
    </Region>
  )
}

export const MODE_TEXT = { off: 'Off', log: 'Log', enforce: 'Enforce' } as const
function Topbar({ page, onTheme, theme }: { page: string; onTheme(): void; theme: string }) {
  const { user, call, settings, base, navigate } = useShield()
  const [menu, setMenu] = useState(false)
  const mode = settings?.mode ?? 'log'
  return (
    <Region id="shield:topbar" as="header" label="Top bar" className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:px-4">
      <Drawer name="menu" label="Menu" side="left" open={menu} onOpenChange={setMenu}
        trigger={<><Icon name="menu" size={18} /><span className="sr-only">Open menu</span></>} slots={{ trigger: { className: 'tva-btn tva-btn-ghost tva-btn-icon lg:hidden' } }}>
        <div className="flex h-full flex-col"><Brand /><Nav id="shield:menu" page={page} onPick={() => setMenu(false)} /></div>
      </Drawer>
      <span className="flex items-center gap-2 lg:hidden"><ShieldMark size={26} /><span className="font-semibold">Shield</span></span>
      <span className="hidden truncate font-semibold lg:inline">{page === 'ip' ? 'IP profile' : PAGES.find((x) => x.page === page)?.title}</span>
      <div className="flex-1" />
      <button type="button" agentId="mode" className="tvs-mode" data-mode={mode} title={`Protection mode: ${MODE_TEXT[mode]} (change in Settings)`} onClick={() => navigate(`${base}/settings/`)}><span className="hidden text-muted sm:inline">Mode</span>{MODE_TEXT[mode]}</button>
      <button type="button" agentId="theme" aria-label="Toggle dark mode" onClick={onTheme} className="tva-btn tva-btn-ghost tva-btn-icon"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      <Menu name="user" label="Account"
        trigger={<span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-accent">{user.username.slice(0, 1).toUpperCase()}</span><span className={cx('hidden max-w-32 truncate sm:inline')}>{user.username}</span></span>}
        slots={{ trigger: { className: 'tva-btn tva-btn-ghost px-2' } }}
        items={[
          { id: 'admin', label: 'Open admin', onSelect: () => location.assign('/admin/') },
          { id: 'theme', label: 'Toggle dark mode', onSelect: onTheme },
          { id: 'logout', label: 'Log out', onSelect: () => void call('auth.logout').then(() => location.reload()) },
        ]} />
    </Region>
  )
}
