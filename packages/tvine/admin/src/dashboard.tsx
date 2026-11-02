'use client'
// The dashboard home (admin.dashboard: auto charts + registered widgets, per-user layout in admin.prefs) and the
// changelist chart strip (admin.charts / admin.chart for one model, following the list's filters).
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { CustomComponent } from './app.js'
import { ChartCard, ChartSkeleton, ChartTable, DataTable, Stat, tableState, type StatTable, isChartData, statOf, type ChartData, type ChartType } from './charts.js'
import { DEFAULT_RANGE, RANGES, loadDashboard, loadWidgets, type DashboardData, type DashWidget, type Layout, type Range, type RouteData, type Size } from './data.js'
export { DEFAULT_RANGE, loadDashboard, loadWidgets, type DashboardData, type DashWidget, type Layout, type Range, type Size }
import { LivePill, useLive } from './live.js'
import { href } from './routes.js'
import type { LogEntry } from './types.js'
import { AppCard, WidgetData, changeText } from './pages.js'
import { Empty, Icon, Region, Slotted, cx, slotClass, useAdmin } from './ui.js'


const SIZES: Size[] = ['sm', 'md', 'lg', 'xl']

function arrange(ws: DashWidget[], l: Layout | null) {
  const by = new Map(ws.map((w) => [w.id, w]))
  const order = [...(l?.order ?? []).filter((id) => by.has(id)), ...ws.map((w) => w.id).filter((id) => !l?.order.includes(id))]
  const hidden = new Set((l?.hidden ?? []).filter((id) => by.has(id)))
  return { shown: order.filter((id) => !hidden.has(id)).map((id) => by.get(id)!), hidden: [...hidden].map((id) => by.get(id)!), order }
}

export function Dashboard({ data }: { data?: RouteData }) {
  const { site, call, prefs, user } = useAdmin()
  const [dash, setDash] = useState<DashboardData | undefined>(data?.dashboard as DashboardData | undefined)
  const [range, setRange] = useState<Range>(() => prefs.get<Range>('dashboard.range', DEFAULT_RANGE))
  const [vals, setVals] = useState<Record<string, unknown> | undefined>(data?.widgets)
  const [loading, setLoading] = useState(false)
  const [layout, setLayout] = useState<Layout | null>(dash?.layout ?? null)
  const [edit, setEdit] = useState(false)
  const [auto, setAuto] = useState(() => prefs.get('dashboard.auto', false))
  const [drag, setDrag] = useState<{ id: string; over?: string } | null>(null)
  const first = useRef(!!data?.widgets && JSON.stringify(range) === JSON.stringify(DEFAULT_RANGE))
  const laidOut = useRef(!!dash)
  const seq = useRef(0)
  // one admin.dashboard { range } call carries every built-in widget's result; only custom widgets call their own action
  const reload = async () => {
    const n = ++seq.current
    setLoading(true)
    const d = await loadDashboard(call, site, range)
    const v = await loadWidgets(call, d.widgets.filter((w) => !(layout ?? d.layout)?.hidden.includes(w.id)), range)
    if (n !== seq.current) return
    setDash(d); setVals(v); setLoading(false)
    if (!laidOut.current) { laidOut.current = true; setLayout(d.layout) }
  }
  const rkey = JSON.stringify(range)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    void reload()
  }, [rkey])   // eslint-disable-line react-hooks/exhaustive-deps
  const every = Math.max(10_000, dash?.autoRefreshMs || 60_000)   // one batched call per tick
  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => { if (!document.hidden) void reload() }, every)
    return () => clearInterval(t)
  })
  const tick = useRef(0)
  const live = useLive(auto && (user?.isStaff || user?.isSuperuser) ? 'admin:live' : null, (f) => {
    if (f.type === 'tick' || Date.now() - tick.current < 10_000) return
    tick.current = Date.now(); void reload()
  })

  const { shown, hidden, order } = useMemo(() => arrange(dash?.widgets ?? [], layout), [dash, layout])
  const save = (l: Layout | null) => {
    setLayout(l)
    void call('admin.prefs', { key: 'dashboard.layout', value: l })
  }
  const cur = (): Layout => ({ order, hidden: hidden.map((w) => w.id), sizes: layout?.sizes ?? {} })
  const move = (id: string, to: number) => {
    const o = order.filter((x) => x !== id)
    o.splice(Math.max(0, Math.min(o.length, to)), 0, id)
    save({ ...cur(), order: o })
  }
  const sizeOf = (w: DashWidget) => layout?.sizes?.[w.id] ?? w.size
  const pickRange = (r: Range) => { setRange(r); prefs.set('dashboard.range', r) }
  const dnd = (w: DashWidget) => !edit ? {} : {
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); setDrag({ id: w.id }) },
    onDragOver: (e: DragEvent) => { e.preventDefault(); if (drag && drag.over !== w.id) setDrag({ ...drag, over: w.id }) },
    onDrop: (e: DragEvent) => { e.preventDefault(); if (drag && drag.id !== w.id) move(drag.id, order.filter((x) => x !== drag.id).indexOf(w.id)); setDrag(null) },
    onDragEnd: () => setDrag(null),
  }
  const custom = typeof range === 'object'

  return (
    <Slotted slot="dashboard">
      <Region id="admin:dashboard" label={site.indexTitle} state={{ range: typeof range === 'string' ? range : `${range.from}..${range.to}`, widgets: shown.length, editing: edit }} className={slotClass('dashboard')}>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{site.indexTitle}</h1>
            {user && <p className="text-sm text-muted">Welcome back, {user.username}</p>}
          </div>
          <div className="tva-seg" role="group" aria-label="Time range">
            {RANGES.map((r) => <button key={r} type="button" agentId={`range-${r}`} aria-pressed={range === r} onClick={() => pickRange(r)}>{r}</button>)}
            <button type="button" agentId="range-custom" aria-pressed={custom} onClick={() => !custom && pickRange({ from: new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) })}>Custom</button>
          </div>
          {custom && (
            <div className="flex items-center gap-1">
              <input type="date" agentId="from" aria-label="From" className="tva-input h-9 w-36" value={range.from} max={range.to} onChange={(e) => e.target.value && pickRange({ ...range, from: e.target.value })} />
              <span className="text-muted">–</span>
              <input type="date" agentId="to" aria-label="To" className="tva-input h-9 w-36" value={range.to} min={range.from} onChange={(e) => e.target.value && pickRange({ ...range, to: e.target.value })} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" agentId="auto-refresh" className="tva-check" checked={auto} onChange={(e) => { setAuto(e.target.checked); prefs.set('dashboard.auto', e.target.checked) }} />Auto-refresh
          </label>
          {auto && <LivePill state={live} />}
          <button type="button" agentId="refresh" aria-label="Refresh" className="tva-btn tva-btn-ghost tva-btn-icon" onClick={() => void reload()} disabled={loading}><Icon name="refresh" className={cx(loading && 'animate-spin')} /></button>
          <button type="button" agentId="customize" aria-pressed={edit} className={cx('tva-btn', edit && 'tva-btn-primary')} onClick={() => setEdit((x) => !x)}><Icon name="sliders" size={14} />{edit ? 'Done' : 'Customize'}</button>
        </div>

        {edit && (
          <Region id="dashboard:customize" label="Customize dashboard" className="tva-card tva-page-enter mb-4 flex flex-wrap items-center gap-2 p-3 text-sm">
            <Icon name="drag" className="text-muted" /><span className="text-muted">Drag cards to reorder, or use the arrows. Resize and hide from each card.</span>
            <div className="flex-1" />
            {hidden.map((w) => (
              <button key={w.id} type="button" agentId={`show-${w.id}`} className="tva-chip h-7 hover:opacity-80" onClick={() => save({ ...cur(), hidden: cur().hidden.filter((x) => x !== w.id) })}>
                <Icon name="eye" size={12} />{w.title}
              </button>
            ))}
            <button type="button" agentId="reset-layout" className="tva-btn tva-btn-ghost h-8" onClick={() => save(null)}>Reset layout</button>
          </Region>
        )}

        {!dash ? (
          <div className="tva-dash mb-6">{['sm', 'sm', 'sm', 'sm', 'lg', 'sm'].map((s, i) => <div key={i} data-size={s} className="tva-card p-4"><ChartSkeleton type={s === 'sm' ? 'stat' : 'line'} height={180} /></div>)}</div>
        ) : shown.length === 0 && !hidden.length ? null : (
          <div className="tva-dash mb-8" data-editing={edit || undefined}>
            {shown.map((w, i) => (
              <div key={w.id} data-size={sizeOf(w)} className="tva-enter min-w-0" style={{ animationDelay: `${i * 40}ms` }}
                data-dragging={drag?.id === w.id || undefined} data-over={(drag && drag.over === w.id && drag.id !== w.id) || undefined} {...dnd(w)}>
                <WidgetCard w={w} v={vals?.[w.id]} loading={loading || !vals} edit={edit && (
                  <span className="flex items-center">
                    <button type="button" agentId={`move-up-${w.id}`} aria-label={`Move ${w.title} earlier`} className="tva-btn tva-btn-ghost h-7 w-7 px-0" onClick={() => move(w.id, i - 1)} disabled={i === 0}><Icon name="up" size={14} /></button>
                    <button type="button" agentId={`move-down-${w.id}`} aria-label={`Move ${w.title} later`} className="tva-btn tva-btn-ghost h-7 w-7 px-0" onClick={() => move(w.id, i + 1)} disabled={i === shown.length - 1}><Icon name="down" size={14} /></button>
                    <button type="button" agentId={`size-${w.id}`} aria-label={`Resize ${w.title} (now ${sizeOf(w)})`} className="tva-btn tva-btn-ghost h-7 px-1.5 text-xs uppercase" onClick={() => save({ ...cur(), sizes: { ...cur().sizes, [w.id]: SIZES[(SIZES.indexOf(sizeOf(w)) + 1) % SIZES.length]! } })}><Icon name="resize" size={12} />{sizeOf(w)}</button>
                    <button type="button" agentId={`hide-${w.id}`} aria-label={`Hide ${w.title}`} className="tva-btn tva-btn-ghost h-7 w-7 px-0" onClick={() => save({ ...cur(), hidden: [...cur().hidden, w.id] })}><Icon name="eyeOff" size={14} /></button>
                  </span>
                )} />
              </div>
            ))}
          </div>
        )}

        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Models</h2>
        {site.apps.length === 0
          ? <Empty title="Nothing to manage yet">You don’t have permission to view any models, or none are registered.</Empty>
          : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{site.apps.map((a) => <AppCard key={a.label} a={a} />)}</div>}
      </Region>
    </Slotted>
  )
}

function WidgetCard({ w, v, loading, edit }: { w: DashWidget; v: unknown; loading: boolean; edit?: React.ReactNode }) {
  const err = v && typeof v === 'object' && 'error' in v ? String((v as { error: unknown }).error) : undefined
  const chart = isChartData(v) ? v : undefined
  const height = w.size === 'sm' ? 140 : 220
  if (['line', 'area', 'bar', 'stacked', 'donut'].includes(w.type) || (w.type === 'table' && (chart || v === undefined))) {
    return <ChartCard id={w.id} title={w.title} type={w.type as ChartType} data={chart} loading={loading} error={err ?? (v !== undefined && !chart ? 'No chart data' : undefined)} height={height} actions={edit} className="h-full tva-lift" />
  }
  const s = w.type === 'stat' ? statOf(v) : undefined
  return (
    <Region id={`widget:${w.id}`} label={w.title} state={s ? { value: s.value, previous: s.previous ?? null } : tableOf(v) ? tableState(tableOf(v)) : { loading: v === undefined }} className="tva-card tva-lift flex h-full min-w-0 flex-col p-4">
      <div className="mb-2 flex items-start gap-2"><h2 className="flex-1 truncate text-[13px] font-semibold text-muted">{w.title}</h2>{edit}</div>
      <div className={cx('min-h-0 flex-1 transition-opacity', loading && v !== undefined && 'opacity-60')}>
        {err ? <p role="alert" className="text-sm text-danger">{err}</p>
          : w.type === 'custom' && w.component ? <CustomComponent name={w.component} data={v} />
          : v === undefined ? <ChartSkeleton type="stat" />
          : s ? <Stat s={s} label={w.title} />
          : w.type === 'activity' ? <Activity rows={(Array.isArray(v) ? v : []) as Recent[]} />
          : w.type === 'table' && v && typeof v === 'object' && 'columns' in v ? <PlainTable t={v as StatTable} />
          : chart ? <ChartTable d={chart} /> : <WidgetData v={v} />}
      </div>
    </Region>
  )
}

const tableOf = (v: unknown) => (v && typeof v === 'object' && 'columns' in v && 'rows' in v ? v as StatTable : undefined)
function PlainTable({ t }: { t: StatTable }) {
  if (!t.rows.length) return <p className="text-sm text-muted">Nothing yet.</p>
  return <div className="overflow-x-auto"><DataTable t={t} /></div>
}

type Recent = Pick<LogEntry, 'id' | 'actionTime' | 'actionFlag' | 'action' | 'objectRepr' | 'changeMessage'> & { model: string; pk: string }
const FLAG_ICON: Record<string, string> = { add: 'plus', change: 'check', delete: 'trash' }
function Activity({ rows }: { rows: Recent[] }) {
  const { base, navigate } = useAdmin()
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">No recent actions.</p>
  return (
    <ol className="space-y-1">
      {rows.map((r) => {
        const to = r.action === 'delete' ? undefined : href(base, { name: 'change', model: r.model, pk: r.pk })
        return (
          <li key={r.id} className="flex items-center gap-3 rounded-md px-1 py-1.5">
            <span className={cx('grid size-7 shrink-0 place-items-center rounded-full', r.action === 'delete' ? 'bg-sunken text-danger' : 'bg-brand-soft text-accent')}><Icon name={FLAG_ICON[r.action] ?? 'clock'} size={13} /></span>
            <div className="min-w-0 flex-1">
              {to ? <a href={to} agentId={`recent-${r.id}`} className="block truncate font-medium hover:text-accent" onClick={(e) => { e.preventDefault(); navigate(to) }}>{r.objectRepr}</a> : <span className="block truncate font-medium">{r.objectRepr}</span>}
              <p className="truncate text-xs text-muted">{changeText(r.changeMessage, r.action)} · {r.model}</p>
            </div>
            <time className="shrink-0 text-xs text-muted" dateTime={r.actionTime}>{new Date(r.actionTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
          </li>
        )
      })}
    </ol>
  )
}

// ---- changelist chart strip ---------------------------------------------------------------------------------------
type ChartDef = { id: string; title: string; type: ChartType; aggregate: string; field?: string; by?: string }
export function ChartStrip({ model, filters }: { model: string; filters?: Record<string, string> }) {
  const { call, prefs } = useAdmin()
  const [defs, setDefs] = useState<ChartDef[]>()
  const [open, setOpen] = useState(() => !prefs.get(`charts:${model}:collapsed`, false))
  const [range, setRange] = useState<Range>(DEFAULT_RANGE)
  const [vals, setVals] = useState<Record<string, ChartData | { error: string }>>({})
  const [loading, setLoading] = useState(false)
  const fkey = JSON.stringify(filters ?? {}) + JSON.stringify(range)
  // one admin.charts call returns the definitions and (data: true) every chart's result for this range + filters
  useEffect(() => {
    let live = true
    setLoading(true)
    void call('admin.charts', { model, range, ...(filters && { filters }), data: open }).then((r) => {
      if (!live) return
      setLoading(false)
      if (!r.ok) { setDefs([]); return }
      const cs = (r.data as { charts: (ChartDef & { result?: ChartData | { error: string } })[] }).charts
      setDefs(cs)
      if (open) setVals(Object.fromEntries(cs.filter((c) => c.result).map((c) => [c.id, c.result!])))
    })
    return () => { live = false }
  }, [model, call, fkey, open])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!defs?.length) return null
  const toggle = () => { setOpen((o) => { prefs.set(`charts:${model}:collapsed`, o); return !o }) }
  return (
    <Region id="admin:charts" label="Charts" state={{ open, charts: defs.length, filtered: !!filters && Object.keys(filters).length > 0 }} className="mb-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" agentId="toggle" aria-expanded={open} onClick={toggle} className="flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg">
          <Icon name={open ? 'down' : 'chevron'} size={14} /><Icon name="chart" size={14} />Charts{filters && Object.keys(filters).length > 0 && <span className="tva-chip">filtered</span>}
        </button>
        <div className="flex-1" />
        {open && <div className="tva-seg" role="group" aria-label="Chart range">{RANGES.map((r) => <button key={r} type="button" agentId={`range-${r}`} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}</div>}
      </div>
      {open && (
        <div className="tva-page-enter grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {defs.slice(0, 6).map((d) => {
            const v = vals[d.id]
            const err = v && 'error' in v ? v.error : undefined
            return <ChartCard key={d.id} id={`${model}:${d.id}`} title={d.title} type={d.type} height={150} loading={loading} data={v && !err ? v as ChartData : undefined} error={err} className={d.type === 'stat' ? '' : 'tva-lift'} />
          })}
        </div>
      )}
    </Region>
  )
}
