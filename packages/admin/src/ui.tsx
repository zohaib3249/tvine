'use client'
import { createContext, createElement, useContext, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { useWidget } from '@tvine/weft'
import type { ApiResult } from '@tvine/weft/api'
import type { Call } from './data.js'
import type { Query, Route } from './routes.js'
import type { ModelMeta, Site, User } from './types.js'

// ---- customization (README §Customize): set once from a 'use client' module of the host app ----------------------
export type Slot = 'shell' | 'sidebar' | 'topbar' | 'main' | 'changelist' | 'table' | 'filters' | 'form' | 'dashboard'
export type CustomProps = { api: Call; site: Site; route: Route; query: Query; meta?: ModelMeta; navigate(href: string): void; base: string }
export type AdminConfig = {
  // custom pages / dashboard widgets / getUrls views: `component` string from the backend → lazy component
  components?: Record<string, ComponentType<CustomProps & { data?: unknown; args?: Record<string, string> }>>
  // field widget overrides (kind or 'app.model.field'), forwarded to the forms registry (forms-adapter.tsx)
  fieldWidgets?: Record<string, ComponentType<any>>
  classNames?: Partial<Record<Slot, string>>
  // replace whole regions; receives the default element
  slots?: Partial<Record<Slot, (def: ReactNode, p: CustomProps) => ReactNode>>
  // per-user prefs store (saved filters, column chooser); default localStorage keyed by user id
  prefs?: { get(key: string): unknown; set(key: string, value: unknown): void }
  brandLogo?: ReactNode
}
let config: AdminConfig = {}
export function configureAdmin(c: AdminConfig): void { config = { ...config, ...c, components: { ...config.components, ...c.components }, fieldWidgets: { ...config.fieldWidgets, ...c.fieldWidgets } } }
export const getConfig = () => config
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export const slotClass = (s: Slot) => config.classNames?.[s]

// ---- app context -------------------------------------------------------------------------------------------------
export type Ctx = {
  call: Call; site: Site; user: User | null; base: string; route: Route; query: Query
  navigate(href: string, o?: { replace?: boolean }): void
  setQuery(q: Query, o?: { replace?: boolean }): void
  setDirty(d: boolean): void
  prefs: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void }
  refresh(): void
}
export const AdminCtx = createContext<Ctx | null>(null)
export const useAdmin = () => useContext(AdminCtx)!
export const custom = (ctx: Ctx, meta?: ModelMeta): CustomProps => ({ api: ctx.call, site: ctx.site, route: ctx.route, query: ctx.query, meta, navigate: ctx.navigate, base: ctx.base })
export function Slotted({ slot, meta, children }: { slot: Slot; meta?: ModelMeta; children: ReactNode }) {
  const ctx = useAdmin()
  const f = config.slots?.[slot]
  return <>{f ? f(children, custom(ctx, meta)) : children}</>
}

// ---- agent regions: a scope with a stable id, so children read `admin:changelist > row:12 > checkbox:select` --------
export function Region({ id, label, as: Tag = 'div', className, state, children, ...rest }: {
  id: string; label: string; as?: 'div' | 'section' | 'aside' | 'header' | 'nav' | 'main' | 'tr' | 'form' | 'li'; className?: string
  state?: Record<string, string | number | boolean | null>; children?: ReactNode
} & Record<string, unknown>) {
  const w = useWidget({ id, kind: 'x-region' as `x-${string}`, label: label.slice(0, 40), state: state ?? null })
  const T = Tag as 'div'
  return <T ref={w.ref} {...w.props} className={className} {...rest}>{w.embed}<w.Scope>{children}</w.Scope></T>
}

// ---- small pieces -------------------------------------------------------------------------------------------------
const P: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16', search: 'M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', plus: 'M12 5v14M5 12h14',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', chevron: 'm9 6 6 6-6 6', down: 'm6 9 6 6 6-6', up: 'm18 15-6-6-6 6',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z', columns: 'M4 4h6v16H4zM14 4h6v16h-6z', sun: 'M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6 19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4 19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', x: 'M18 6 6 18M6 6l12 12', trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', check: 'm5 12 5 5L20 7', box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', logout: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  bookmark: 'M6 3h12v18l-6-4-6 4z', download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16', file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', ext: 'M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
}
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d={P[name] ?? P.box} /></svg>
}
export const Skeleton = ({ rows = 6 }: { rows?: number }) => (
  <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => <div key={i} className="tva-skel h-5" style={{ width: `${90 - (i * 13) % 40}%` }} />)}
  </div>
)
export function Empty({ title, children, icon = 'box' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-brand-soft text-brand"><Icon name={icon} size={22} /></div>
      <p className="text-base font-semibold">{title}</p>
      {children && <div className="max-w-sm text-muted">{children}</div>}
    </div>
  )
}
export function ErrorBox({ error }: { error: { code: string; message: string; reason?: string } }) {
  return <div role="alert" className="tva-card border-danger/40 p-4 text-danger"><strong className="font-semibold">{error.reason === 'not_found' ? 'Not found' : error.code === 'invalid_param' ? 'Invalid request' : 'Something went wrong'}</strong><p className="text-sm">{error.message}</p></div>
}
export const fmt = (r: ApiResult<unknown>) => (r.ok ? '' : r.message)

// A <form> that is NOT an agent scope (plain JSX <form> scopes its fields as `form:… > input:…`); its fields and
// buttons still register under the surrounding region.
export const PlainForm = (p: ComponentProps<'form'>) => createElement('form', p)
