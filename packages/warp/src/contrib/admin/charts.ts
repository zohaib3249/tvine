// Model charts (admin.charts / admin.chart): automatic ones from the ModelAdmin's fields, or ModelAdmin.charts.
//  - a time series of count / sum / avg / min / max on the date field (dateHierarchy, else the first date field),
//    grouped per day in SQL (TruncDay, GROUP BY; parameterized like every ORM query) and re-binned per week here;
//  - a breakdown by a choice / boolean / foreign-key field (top 8 + "Other");
//  - a stat: the total over the range and over the period before it.
// Rows come from the changelist queryset (getQueryset/scoped + the list filters), so a chart never shows a row the
// list would not. Results are cached 60 s per user (the cache framework, default alias).
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import { cache } from '../../cache/index.js'
import { Avg, Count, Max, Min, Sum, TruncDay, type Expression } from '../../data/expressions.js'
import type { Field } from '../../data/fields/index.js'
import type { QuerySet } from '../../data/queryset.js'
import { isStaff } from '../../security/permissions.js'
import { labelOf } from './meta.js'
import { checkPerm, type ChartSpec, type Ctx, type ModelAdmin } from './options.js'
import { site } from './sites.js'
import { bucketsOf, floorTo, rangeOf, rangeParam, round, type ChartData, type Range } from './stats.js'
import { changelistQs, choicesOf, filterSpecs } from './views.js'

type Spec = ChartSpec & { id: string; title: string; aggregate: NonNullable<ChartSpec['aggregate']> }
const NUMERIC = new Set(['money', 'decimal', 'float', 'int'])
const CACHE_S = 60, TOP = 8, MAX_ROWS = 5000

const bad = (field: string, msg: string) => new DomainError('invalid_param', `${field}: ${msg}`, field)

export function dateFieldOf(a: ModelAdmin): string | undefined {
  if (a.dateHierarchy) return a.dateHierarchy
  return (Object.entries(a.model.fields) as [string, Field][]).find(([, f]) => f.kind === 'datetime' || f.kind === 'date')?.[0]
}
const plural = (a: ModelAdmin) => a.verboseNamePlural ?? `${a.verboseName ?? labelOf(a._key.split('.')[1]!)}s`

// the charts of one model: ModelAdmin.charts (false = none), else automatic ones from its fields
export function chartSpecs(a: ModelAdmin): Spec[] {
  if (a.charts === false) return []
  const name = plural(a), fields = a.model.fields
  if (a.charts) return a.charts.map((c, i) => ({
    ...c, id: c.id ?? `c${i}`, aggregate: c.aggregate ?? 'count',
    title: c.title ?? (c.by ? `${name} by ${labelOf(c.by).toLowerCase()}` : c.field ? `${labelOf(c.field)} (${c.aggregate ?? 'count'})` : name),
  }))
  const out: Spec[] = []
  const d = dateFieldOf(a)
  const num = (Object.entries(fields) as [string, Field][]).find(([n, f]) => n !== 'id' && (f.kind === 'money' || f.kind === 'decimal'))?.[0]
  if (d) {
    out.push({ id: 'total', type: 'stat', aggregate: 'count', title: `New ${name.toLowerCase()}` })
    if (num) out.push({ id: `sum_${num}`, type: 'stat', aggregate: 'sum', field: num, title: `${labelOf(num)} (total)` })
    out.push({ id: 'count', type: 'area', aggregate: 'count', title: `${name} over time` })
    if (num) out.push({ id: `sum_${num}_time`, type: 'bar', aggregate: 'sum', field: num, title: `${labelOf(num)} per period` })
  }
  // breakdowns: list filters first (the admin already said they matter), then any choice / boolean field
  const listed = a.listFilter.filter((f): f is string => typeof f === 'string')
  const cands = [...listed, ...Object.keys(fields)].filter((n, i, all) => all.indexOf(n) === i && ['enum', 'bool', 'fk'].includes(fields[n]?.kind ?? ''))
  for (const by of cands.slice(0, 2)) out.push({ id: `by_${by}`, type: 'donut', aggregate: 'count', by, title: `${name} by ${labelOf(by).toLowerCase()}` })
  return out
}

function aggOf(a: ModelAdmin, s: Spec): { expr: Expression; money: boolean } {
  if (s.aggregate === 'count') return { expr: Count('*'), money: false }
  const f = s.field && a.model.fields[s.field]
  if (!f || !NUMERIC.has(f.kind)) throw bad('chart', `${s.id}: "${s.field}" is not a number field`)
  const col = f.key(s.field!)
  const fn = { sum: Sum, avg: Avg, min: Min, max: Max }[s.aggregate]
  return { expr: fn(col), money: f.kind === 'money' }
}

// a money field's currency: the first row's (amounts are summed in cents, then shown in major units)
// ponytail: mixed currencies on one field are summed as one; group by currency when a shop sells in several
async function currencyOf(qs: QuerySet<any>, field: string): Promise<string | undefined> {
  const row = (await qs.values(field).first()) as Record<string, { currency?: string } | null> | undefined
  return row?.[field]?.currency ?? undefined
}

export async function computeChart(a: ModelAdmin, ctx: Ctx, s: Spec, range: Range | undefined, filters: Record<string, string> | undefined): Promise<ChartData> {
  const r = rangeOf(range ?? s.range)
  const base = await changelistQs(a, ctx, { filters })
  const d = s.date ?? dateFieldOf(a)
  const dkey = d ? a.model.fields[d]?.key(d) : undefined
  if (s.date && !dkey) throw bad('chart', `${s.id}: "${s.date}" is not a field`)
  const within = (qs: QuerySet<any>, from: Date, to: Date) => (dkey ? qs.filter({ [`${dkey}__gte`]: from, [`${dkey}__lt`]: to }) : qs)
  const { expr, money } = aggOf(a, s)
  let qs = within(base, r.from, r.to)
  let currency: string | undefined
  if (money) currency = await currencyOf(qs, s.field!)
  // a money aggregate comes back as cents, or already as { value } when the ORM converts it
  const val = (v: unknown) => round(v && typeof v === 'object' && 'value' in v ? Number((v as { value: unknown }).value ?? 0) : Number(v ?? 0) / (money ? 100 : 1))
  const unit = money ? 'money' as const : s.aggregate === 'count' ? 'count' as const : 'number' as const
  const head = { id: s.id, title: s.title, type: s.type, unit, ...(currency && { currency }) }
  const valueLabel = s.aggregate === 'count' ? 'Count' : `${labelOf(s.field!)} (${s.aggregate})`

  if (s.by) {
    const f = a.model.fields[s.by]
    if (!f) throw bad('chart', `${s.id}: "${s.by}" is not a field`)
    const key = f.key(s.by)
    const rows = (await qs.values(key).annotate({ _v: expr }).order().all(1000)) as Record<string, unknown>[]
    const spec = filterSpecs(a).find((x) => x.field === s.by || x.name === s.by)
    const labels = new Map(spec ? await choicesOf(a, ctx, spec) : [])
    const text = (v: unknown) => v == null ? '(none)' : f.kind === 'bool' ? (v ? 'Yes' : 'No') : labels.get(String(v)) ?? (f.kind === 'enum' ? labelOf(String(v)) : String(v))
    const sorted = rows.map((x) => ({ x: text(x[key]), v: val(x._v) })).sort((p, q) => q.v - p.v)
    const top = sorted.slice(0, TOP), rest = sorted.slice(TOP).reduce((n, p) => n + p.v, 0)
    const points = [...top, ...(rest ? [{ x: 'Other', v: round(rest) }] : [])].map((p) => ({ x: p.x, values: [p.v] }))
    return { ...head, groupBy: 'category', series: [{ name: 'value', label: valueLabel }], points, total: round(sorted.reduce((n, p) => n + p.v, 0)) }
  }

  if (!dkey) throw bad('chart', `${s.id}: ${a._key} has no date field for a time series (set dateHierarchy or charts[].date)`)
  // per period: GROUP BY day in SQL; hours (24h) and the 1h range bucket the timestamps here (≤ MAX_ROWS rows)
  const g = r.groupBy === 'minute' ? 'minute' : r.groupBy
  const bs = bucketsOf(r.from, r.to, g)
  const at = new Map(bs.map((b, i) => [b, i]))
  const acc = bs.map(() => ({ n: 0, v: 0 as number, set: false }))
  const put = (t: number, v: number, n = 1) => {
    const i = at.get(floorTo(t, g))
    if (i === undefined) return
    const c = acc[i]!
    if (s.aggregate === 'min') c.v = c.set ? Math.min(c.v, v) : v
    else if (s.aggregate === 'max') c.v = c.set ? Math.max(c.v, v) : v
    else if (s.aggregate === 'avg') { c.v = (c.v * c.n + v * n) / (c.n + n) }
    else c.v += v
    c.n += n; c.set = true
  }
  const time = (v: unknown) => +(v instanceof Date ? v : new Date(String(v).length === 10 ? `${String(v)}T00:00:00Z` : String(v)))
  if (g === 'minute' || g === 'hour') {
    const col = s.aggregate === 'count' ? undefined : a.model.fields[s.field!]!.key(s.field!)
    const rows = (await qs.values(dkey, ...(col ? [col] : [])).order().all(MAX_ROWS)) as Record<string, unknown>[]
    for (const x of rows) put(time(x[dkey]), col ? val(x[col]) : 1)
  } else {
    const rows = (await qs.annotate({ _b: TruncDay(dkey) }).values('_b').annotate({ _v: expr, _n: Count('*') }).order().all(1000)) as Record<string, unknown>[]
    for (const x of rows) put(time(x._b), s.aggregate === 'count' ? Number(x._v) : val(x._v), Number(x._n))
  }
  const points = bs.map((b, i) => ({ x: new Date(b).toISOString(), values: [round(acc[i]!.v)] }))
  const out: ChartData = { ...head, groupBy: g, series: [{ name: 'value', label: valueLabel }], points }
  if (s.type === 'stat') {
    const total = async (q: QuerySet<any>) => val((await q.aggregate({ v: expr })).v)
    const prev = within(base, r.prevFrom, r.from)
    out.total = await total(qs)
    out.previous = await total(prev)
  }
  return out
}

async function gateChart(ctx: Ctx, model: string): Promise<ModelAdmin> {
  const a = site.adminFor(model)
  if (!a) throw new DomainError('not_found', `no admin for model ${model}`)
  if (a.agents === false && ctx.request.agent.is) throw new DomainError('forbidden', 'forbidden: this model is not for agents')
  if (!(await checkPerm(a, ctx, 'view'))) throw new DomainError('forbidden', 'forbidden: not allowed')
  return a
}
const modelKey = z.string().regex(/^[a-z][a-z0-9_]*\.[a-zA-Z0-9_]+$/).max(100)
const read = { permissions: [isStaff], readOnly: true }

export const charts = defineAction('charts', z.object({ model: modelKey }), async ({ model }, ctx) => {
  const a = await gateChart(ctx, model)
  return { charts: chartSpecs(a).map(({ id, title, type, aggregate, field, by, size }) => ({ id, title, type, aggregate, ...(field && { field }), ...(by && { by }), ...(size && { size }) })) }
}, read)

export const chart = defineAction('chart', z.object({
  model: modelKey, chart: z.string().max(100), range: rangeParam.optional(), filters: z.record(z.string().max(200)).optional(),
}), async (p, ctx) => {
  const a = await gateChart(ctx, p.model)
  const s = chartSpecs(a).find((c) => c.id === p.chart)
  if (!s) throw bad('chart', `no chart "${p.chart}" on ${p.model}`)
  if (p.range && typeof p.range === 'object') { try { rangeOf(p.range) } catch (e) { throw bad('range', (e as Error).message) } }
  // per user: getQueryset may scope rows by user; the range is relative, so a short timeout keeps it current
  const key = `tvine.admin.chart:${String(ctx.request.user.id ?? '')}:${JSON.stringify([p.model, p.chart, p.range ?? null, p.filters ?? null])}`
  let c: { lookup: typeof cache.lookup; set: typeof cache.set } | undefined
  try { c = cache; const hit = await c.lookup(key); if (hit.hit) return hit.v } catch { c = undefined }   // no cache configured: compute
  const out = await computeChart(a, ctx, s, p.range, p.filters)
  try { await c?.set(key, out, CACHE_S) } catch { /* a cache outage never fails a chart */ }
  return out
}, read)
