// The admin home (admin.dashboard / admin.widget): built-in widgets (traffic, logins, agents, top actions, top queries,
// KPIs) from the stats rollups, automatic model charts (charts.ts) when settings.admin.dashboard.autoCharts, and the
// app's admin.site.registerWidget() ones. settings.admin.dashboard.widgets puts ids first; each user's own layout
// (order / hidden / sizes) is the admin.prefs key 'dashboard.layout'.
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import { isStaff } from '../../security/permissions.js'
import { chartSpecs } from './charts.js'
import { AdminPref } from './models.js'
import { checkPerm, type Ctx } from './options.js'
import { site, type AdminWidget } from './sites.js'
import { AGENT_VIA, rangeOf, timeSeries, type ChartData, type Range } from './stats.js'
import { rangeParam } from './stats.js'
import { actionTables, loginChart, statRows, systemAgents, systemQueries, trafficCharts } from './system.js'

type Size = 'sm' | 'md' | 'lg' | 'xl'
type Spec = { id: string; title: string; size: Size; type: string; data?: { id: string; params?: Record<string, unknown> }; refreshMs?: number; component?: string; model?: string }
type Builtin = { title: string; size: Size; type: string; superuser?: boolean; run(ctx: Ctx, range: Range | undefined): Promise<unknown> }

const prevOf = (range: Range | undefined): Range => { const r = rangeOf(range); return { from: r.prevFrom.toISOString(), to: r.from.toISOString() } }
// a KPI: the total now, the total for the period before, and the series for its sparkline
async function kpi(range: Range | undefined, f: (range: Range | undefined) => Promise<{ total: number; series: ChartData }>, unit: ChartData['unit'], title: string): Promise<ChartData> {
  const [now, before] = await Promise.all([f(range), f(prevOf(range))])
  return { ...now.series, title, type: 'stat', unit, total: now.total, previous: before.total }
}

const BUILTIN: Record<string, Builtin> = {
  'kpi.requests': { title: 'Requests', size: 'sm', type: 'stat', run: (_c, range) => kpi(range, async (r) => { const t = await trafficCharts(r); return { total: t.total, series: { ...t.requests, series: [{ name: 'v', label: 'Requests' }], points: t.requests.points.map((p) => ({ x: p.x, values: [p.values.reduce((a, b) => a + b, 0)] })) } } }, 'count', 'Requests') },
  'kpi.errors': { title: 'Error rate', size: 'sm', type: 'stat', run: (_c, range) => kpi(range, async (r) => { const t = await trafficCharts(r); return { total: t.errorRate.total ?? 0, series: t.errorRate } }, 'percent', 'Error rate (5xx)') },
  'kpi.latency': { title: 'p95 latency', size: 'sm', type: 'stat', run: (_c, range) => kpi(range, async (r) => { const t = await trafficCharts(r); return { total: t.p95, series: { ...t.latency, series: [t.latency.series[1]!], points: t.latency.points.map((p) => ({ x: p.x, values: [p.values[1]!] })) } } }, 'ms', 'p95 latency') },
  'kpi.agents': { title: 'Agent actions', size: 'sm', type: 'stat', run: (_c, range) => kpi(range, async (r) => {
    const { rows, r: rr } = await statRows('action', r)
    const agent = rows.filter((x) => AGENT_VIA.has(x.dims.v ?? ''))
    return { total: agent.reduce((n, x) => n + x.count, 0), series: timeSeries(agent, rr.groupBy, rr.from, rr.to, [{ name: 'v', label: 'Agent actions' }], () => 'v') }
  }, 'count', 'Agent actions') },
  'traffic.requests': { title: 'Requests by transport', size: 'lg', type: 'area', run: async (_c, range) => ({ ...(await trafficCharts(range)).requests, title: 'Requests by transport', type: 'area' }) },
  'traffic.status': { title: 'Responses by status', size: 'md', type: 'stacked', run: async (_c, range) => ({ ...(await trafficCharts(range)).status, title: 'Responses by status', type: 'stacked' }) },
  'traffic.latency': { title: 'Latency p50 / p95', size: 'md', type: 'line', run: async (_c, range) => ({ ...(await trafficCharts(range)).latency, title: 'Latency p50 / p95', type: 'line' }) },
  'logins': { title: 'Sign-ins', size: 'md', type: 'stacked', superuser: true, run: (_c, range) => loginChart(range) },
  'agents.activity': { title: 'Human vs agent actions', size: 'md', type: 'stacked', run: async (c, range) => (await systemAgents.run({ range }, c) as { activity: ChartData }).activity },
  'agents.top': { title: 'Top agents', size: 'md', type: 'table', run: async (c, range) => (await systemAgents.run({ range }, c) as { topAgents: unknown }).topAgents },
  'actions.top': { title: 'Top actions', size: 'md', type: 'table', run: async (_c, range) => (await actionTables(range)).top },
  'actions.slowest': { title: 'Slowest actions', size: 'md', type: 'table', run: async (_c, range) => (await actionTables(range)).slowest },
  'queries.top': { title: 'Top queries', size: 'lg', type: 'table', run: async (c, range) => (await systemQueries.run({ range }, c) as { top: unknown }).top },
}
const readFn = (w: AdminWidget) => typeof w.data === 'function'

async function may(ctx: Ctx, p?: string): Promise<boolean> {
  const u = ctx.request.user
  return !p || !!u.isSuperuser || (!!u.hasPerm && (await u.hasPerm(p)))
}

export const dashboard = defineAction('dashboard', z.object({}), async (_p, ctx) => {
  const s = ctx.settings.admin, superuser = !!ctx.request.user.isSuperuser
  const out: Spec[] = []
  if (s.stats.enabled) for (const [id, b] of Object.entries(BUILTIN)) if (!b.superuser || superuser) out.push({ id, title: b.title, size: b.size, type: b.type, data: { id: 'admin.widget', params: { id } } })
  out.push({ id: 'activity', title: 'Recent actions', size: 'md', type: 'activity', data: { id: 'admin.recent', params: { limit: 8 } } })
  if (s.dashboard.autoCharts) {
    let n = 0
    for (const a of site.admins()) {
      if (n >= 16 || (a.agents === false && ctx.request.agent.is) || !(await checkPerm(a, ctx, 'view'))) continue
      for (const c of chartSpecs(a)) {
        if (c.dashboard === false || n >= 16) continue
        n++
        out.push({ id: `model:${a._key}:${c.id}`, title: c.title, model: a._key, type: c.type, size: c.size ?? (c.type === 'stat' || c.type === 'donut' ? 'sm' : 'md'), data: { id: 'admin.chart', params: { model: a._key, chart: c.id } } })
      }
    }
  }
  for (const w of site.widgets) {
    if (!(await may(ctx, w.permission))) continue
    const data = readFn(w) ? { id: 'admin.widget', params: { id: w.id } } : w.data ? { id: (w.data as { id: string }).id } : undefined
    out.push({ id: w.id, title: w.title, size: w.size, type: w.type ?? (w.component ? 'custom' : 'stat'), ...(data && { data }), ...(w.refreshMs && { refreshMs: w.refreshMs }), ...(w.component && { component: w.component }) })
  }
  // settings order first (Django-style project default), then the rest as built
  const first = s.dashboard.widgets
  out.sort((x, y) => (first.indexOf(x.id) < 0 ? 1e6 : first.indexOf(x.id)) - (first.indexOf(y.id) < 0 ? 1e6 : first.indexOf(y.id)))
  const pref = await AdminPref.objects.filter({ userId: String(ctx.request.user.id ?? ''), key: 'dashboard.layout' }).first()   // scope: ok (own prefs)
  return { widgets: out, layout: pref?.value ?? null, autoRefreshMs: 30_000 }
}, { permissions: [isStaff], readOnly: true })

export const widget = defineAction('widget', z.object({ id: z.string().max(200), range: rangeParam.optional() }), async ({ id, range }, ctx) => {
  if (range && typeof range === 'object') { try { rangeOf(range) } catch (e) { throw new DomainError('invalid_param', `range: ${(e as Error).message}`, 'range') } }
  const b = BUILTIN[id]
  if (b) {
    if (b.superuser && !ctx.request.user.isSuperuser) throw new DomainError('forbidden', 'forbidden: not allowed')
    return b.run(ctx, range)
  }
  const w = site.widgets.find((x) => x.id === id)
  if (!w || !readFn(w) || !(await may(ctx, w.permission))) throw new DomainError('not_found', `no widget ${id}`)
  return (w.data as (ctx: Ctx, p: { range?: Range }) => unknown)(ctx, { range })
}, { permissions: [isStaff], readOnly: true })

