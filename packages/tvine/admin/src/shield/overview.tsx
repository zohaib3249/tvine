'use client'
// Analytics: one shield.analytics call per (range | from/to, filters). Sticky range bar + filter chips (URL-backed),
// KPI strip with deltas + sparklines, served vs mitigated (drag to zoom), decisions (stacked + donut), world map,
// top-N grid with "Filter for" / "Exclude", score histogram, challenge funnel, recent events. Live frames refetch.
import { useState } from 'react'
import { ChartCard, DonutChart, Sparkline, XYChart, type ChartData } from '../charts.js'
import { LivePill, useLiveData } from '../live.js'
import { Empty, ErrorBox, Icon, Region, cx } from '../ui.js'
import { useShield } from './ctx.js'
import { BOT_CATEGORIES } from './fields.js'
import { Ago, FilterBar, Funnel, RangeBar, TopList, WorldMap, countryName, flag, num, pct, useFilters, type FilterState } from './kit.js'
import type { Analytics as Data, EventPage, EventRow, FilterField, Rule, TopKey } from './types.js'

// every request Shield sees nudges admin:live: refetch at most every 15 s per widget (stays inside settings.limits.rate, 60/min)
export const LIVE = { group: 'admin:live', types: ['shield'], minMs: 15_000 }
// one color per decision, everywhere (stacked bars use the .tvs-dec series order: pass allow log challenge block rateLimit)
export const DECISION_COLOR: Record<string, string> = { pass: 'var(--tvs-pass)', allow: 'var(--tvs-allow)', log: 'var(--tvs-log)', challenge: 'var(--tvs-challenge)', block: 'var(--tvs-block)', rateLimit: 'var(--tvs-rate)' }
export const DECISION_LABEL: Record<string, string> = { pass: 'Passed', allow: 'Allowed', log: 'Logged', challenge: 'Challenged', block: 'Blocked', rateLimit: 'Rate limited', custom: 'Custom' }
export const decisionTone = (d: string) => (/block|rateLimit/.test(d) ? 'error' : /challenge/.test(d) ? 'warn' : /would|log/.test(d) ? 'info' : 'ok')
export const DecisionBadge = ({ d }: { d: string }) => <span className="tvs-decision" data-t={decisionTone(d)}>{d.startsWith('would-') ? `would ${d.slice(6)}` : DECISION_LABEL[d] ?? d}</span>

// the analytics input for the current URL state
export const analyticsInput = (s: FilterState) => ({ range: s.range, ...s.custom, filters: s.filters })

const TOPS: { key: TopKey; title: string; field: FilterField }[] = [
  { key: 'countries', title: 'Countries', field: 'country' }, { key: 'asns', title: 'Networks (ASN)', field: 'asn' },
  { key: 'paths', title: 'Paths', field: 'path' }, { key: 'ips', title: 'IP addresses', field: 'ip' },
  { key: 'bots', title: 'Bots', field: 'botName' }, { key: 'botCategories', title: 'Bot categories', field: 'botCategory' },
  { key: 'rules', title: 'Rules', field: 'ruleId' }, { key: 'uaFamilies', title: 'User agents', field: 'uaFamily' },
  { key: 'methods', title: 'HTTP methods', field: 'method' }, { key: 'statuses', title: 'Response status', field: 'status' },
  { key: 'ja4', title: 'TLS fingerprints (JA4)', field: 'tlsJa4' }, { key: 'hosts', title: 'Hosts', field: 'host' },
]

export function Overview() {
  const { call, base, navigate } = useShield()
  const s = useFilters()
  const a = useLiveData<Data>(call, 'shield.analytics', analyticsInput(s), LIVE)
  const rules = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const ruleName = (id: string) => (Array.isArray(rules.data) ? rules.data : rules.data?.rules)?.find((r) => r.id === id)?.name ?? id
  const d = a.data, t = d?.totals
  const col = (k: number) => d?.series.points.map((p) => p.values[k] ?? 0) ?? []
  const solveRate = t && t.solved + t.failed > 0 ? (t.solved / (t.solved + t.failed)) * 100 : undefined
  const prevSolve = t?.previous && (t.previous.solved ?? 0) + (t.previous.failed ?? 0) > 0 ? ((t.previous.solved ?? 0) / ((t.previous.solved ?? 0) + (t.previous.failed ?? 0))) * 100 : undefined
  const kpis = [
    { id: 'requests', label: 'Requests', v: t?.requests, p: t?.previous?.requests, spark: d && col(0).map((x, i) => x + (col(1)[i] ?? 0)), up: true },
    { id: 'served', label: 'Served', v: t?.served, p: t?.previous?.served, spark: d && col(0), up: true },
    { id: 'mitigated', label: 'Mitigated', v: t?.mitigated, p: t?.previous?.mitigated, spark: d && col(1), up: false, sub: t && `${pct(t.mitigated, t.requests)} of requests` },
    { id: 'solve-rate', label: 'Challenge solve rate', v: solveRate, p: prevSolve, unit: '%', up: true, sub: t && `${num(t.solved)} solved · ${num(t.failed)} failed` },
    { id: 'avg-score', label: 'Avg. bot score', v: t?.avgScore, p: t?.previous?.avgScore, up: true, sub: '1 bot … 99 human' },
  ]
  const series: ChartData | undefined = d && { ...d.series, unit: 'count', title: 'Served vs mitigated' }
  const decisions: ChartData | undefined = d && { ...d.decisions, unit: 'count', series: d.decisions.series.map((x) => ({ ...x, label: DECISION_LABEL[x.name] ?? x.label })) }
  const donut: ChartData | undefined = decisions && { groupBy: 'category', unit: 'count', title: 'Decisions', series: [{ name: 'n', label: 'Requests' }],
    points: decisions.series.map((x, k) => ({ x: x.label, values: [decisions.points.reduce((acc, p) => acc + (p.values[k] ?? 0), 0)] })).filter((p) => p.values[0]! > 0) }
  const hist: ChartData | undefined = d && { groupBy: 'category', unit: 'count', series: [{ name: 'n', label: 'Requests' }],
    points: d.histogram.map((n, i) => ({ x: `${i * 10 + 1}–${i === 9 ? 99 : i * 10 + 10}`, values: [n] })) }
  const zoom = (i0: number, i1: number) => { const p = d!.series.points; s.setWindow(p[i0]!.x, p[i1]!.x) }
  const empty = d && d.totals.requests === 0
  return (
    <Region id="shield:analytics" label="Security analytics" state={{ range: s.custom ? 'custom' : s.range, filters: s.filters.length, requests: t?.requests ?? null, mitigated: t?.mitigated ?? null, sampled: d?.sampled ?? null, loading: a.loading }}>
      <RangeBar title="Security analytics" sub="Every request Shield saw, what it decided, and why." s={s}>
        <LivePill state={a.live} />
        <button type="button" agentId="refresh" aria-label="Refresh" className="tva-btn tva-btn-ghost tva-btn-icon" onClick={() => void a.reload()} disabled={a.loading}><Icon name="refresh" className={cx(a.loading && 'animate-spin')} /></button>
      </RangeBar>
      <div className="mb-4"><FilterBar s={s} /></div>
      {d?.sampled && <p role="note" className="tvs-banner mb-4"><Icon name="alert" size={14} />Based on a {Math.round((d.sampleRate <= 1 ? d.sampleRate * 100 : d.sampleRate) * 10) / 10}% sample of requests. Counts are estimates.</p>}
      {a.error && !d && <div className="mb-4"><ErrorBox error={a.error} /></div>}

      <div className={cx('grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5', a.loading && d && 'opacity-70 transition-opacity')}>
        {kpis.map((k) => <Kpi key={k.id} {...k} />)}
      </div>

      {empty ? (
        <div className="tva-card mt-4"><Empty title="No traffic in this view" icon="shield">Shield saw no requests{s.filters.length ? ' matching these filters' : ''} in this range. Try a longer range{s.filters.length ? ' or remove a filter' : ''}.</Empty></div>
      ) : (
        <>
          <Region id="chart:traffic" label="Served vs mitigated" state={{ points: series?.points.length ?? 0, served: t?.served ?? null, mitigated: t?.mitigated ?? null, zoomed: !!s.custom }} className="tva-card tvs-traffic mt-4 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1"><h3 className="text-[13px] font-semibold">Requests: served vs mitigated</h3><p className="text-xs text-muted">Drag across the chart to zoom in.</p></div>
              {s.custom && <button type="button" agentId="zoom-out" className="tva-btn tva-btn-ghost h-7 px-2 text-xs" onClick={() => s.setRange(s.range)}><Icon name="resize" size={12} />Reset zoom</button>}
            </div>
            {!series ? <div className="tva-skel h-[260px]" aria-busy="true" /> : <XYChart d={series} kind="area" height={260} onBrush={zoom} />}
          </Region>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <ChartCard id="decisions" title="Decisions over time" type="stacked" data={decisions} loading={a.loading} height={220} className="tvs-dec lg:col-span-2" />
            <Region id="chart:decision-share" label="Decision share" state={{ parts: donut?.points.map((p) => `${p.x} ${p.values[0]}`).join(', ') ?? '' }} className="tva-card tvs-dec-donut p-4">
              <h3 className="mb-3 text-[13px] font-semibold">Decision share</h3>
              {!donut ? <div className="tva-skel size-40 rounded-full" aria-busy="true" /> : <DonutChart d={donut} colors={Object.fromEntries(Object.entries(DECISION_COLOR).map(([k, v]) => [DECISION_LABEL[k]!, v]))} />}
            </Region>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
            <WorldMap geo={d?.geo} onPick={(cc) => s.add({ field: 'country', op: 'eq', value: cc })} />
            <div className="grid gap-4">
              <ChartCard id="scores" title="Bot score distribution" subtitle="1 = surely a bot · 99 = surely a human" type="bar" data={hist} loading={a.loading} height={150} className="tvs-hist" />
              <Funnel f={d?.funnel} />
            </div>
          </div>

          <h2 className="mt-6 mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Top by</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {TOPS.map((x) => (
              <TopList key={x.key} id={x.key} title={x.title} field={x.field} rows={d ? d.top[x.key] ?? [] : undefined} onFilter={s.add}
                render={x.key === 'countries' ? (r) => <>{flag(r.key)} {r.label ?? countryName(r.key)}</>
                  : x.key === 'asns' ? (r) => <><span className="font-mono text-xs">AS{r.key.replace(/^AS/i, '')}</span> {r.label && <span className="text-muted">{r.label}</span>}</>
                  : x.key === 'rules' ? (r) => r.label ?? ruleName(r.key)
                  : x.key === 'botCategories' ? (r) => BOT_CATEGORIES.find((c) => c.value === r.key)?.label ?? r.key
                  : x.key === 'paths' || x.key === 'ips' || x.key === 'ja4' ? (r) => <span className="font-mono text-xs">{r.key}</span> : undefined}
                onOpen={x.key === 'ips' ? (r) => navigate(`${base}/ip/${encodeURIComponent(r.key)}/`) : undefined} />
            ))}
          </div>

          <div className="mt-4"><Feed /></div>
        </>
      )}
      {d && <p className="mt-4 text-right text-[11px] text-muted">Source: {d.source === 'rollups' ? 'per-minute rollups' : 'stored events'} · {new Date(d.range.from).toLocaleString()} – {new Date(d.range.to).toLocaleString()} · step {d.range.step}</p>}
    </Region>
  )
}

function Kpi({ id, label, v, p, spark, up, unit, sub }: { id: string; label: string; v?: number; p?: number; spark?: number[]; up: boolean; unit?: string; sub?: string }) {
  const delta = v !== undefined && p ? ((v - p) / Math.abs(p)) * 100 : undefined
  const good = delta === undefined ? undefined : (delta >= 0) === up
  return (
    <Region id={`kpi:${id}`} label={label} state={{ value: v ?? null, previous: p ?? null }} className={cx('tva-card tva-lift flex flex-col p-4', id === 'avg-score' && 'col-span-2 md:col-span-1')}>
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      {v === undefined ? <div aria-busy="true" className="mt-2"><div className="tva-skel mb-1 h-8 w-24" /><div className="tva-skel h-3 w-32" /></div> : (
        <>
          <div className="mt-1 flex items-end justify-between gap-2">
            <p className="tva-stat-value" title={v.toLocaleString()}>{unit === '%' ? `${Math.round(v * 10) / 10}%` : num(v)}</p>
            {spark && spark.length > 1 && <Sparkline values={spark} width={84} height={28} label={label} />}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            {delta !== undefined && <span className={cx('tva-delta', good ? 'is-good' : 'is-bad')}><Icon name={delta >= 0 ? 'up' : 'down'} size={12} />{delta >= 0 ? '+' : ''}{Math.round(delta * 10) / 10}%</span>}
            {sub && <span className="truncate text-muted">{sub}</span>}
          </p>
        </>
      )}
    </Region>
  )
}

function Feed() {
  const { call, base, navigate } = useShield()
  const s = useFilters()
  const f = useLiveData<EventPage>(call, 'shield.events', { filters: s.filters, ...s.window, page: 1, pageSize: 10 }, LIVE)
  const rows = f.data?.rows.slice(0, 10)
  const all = `${base}/events/${location.search}`
  return (
    <Region id="shield:feed" label="Recent events" state={{ count: rows?.length ?? 0, latest: rows?.[0]?.ray ?? null }} className="tva-card flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <h3 className="flex-1 text-[13px] font-semibold">Recent events</h3>
        <LivePill state={f.live} />
        <a href={all} agentId="all-events" className="tva-btn tva-btn-ghost h-7 px-2 text-xs" onClick={(e) => { e.preventDefault(); navigate(all) }}>Open in Events<Icon name="chevron" size={12} /></a>
      </div>
      {!rows ? <div className="space-y-2 p-4 pt-0" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="tva-skel h-5" />)}</div>
        : rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No events yet. They appear here as requests arrive.</p>
        : <ul className="tva-log">{rows.map((r) => <FeedRow key={r.ray} r={r} onOpen={() => navigate(`${base}/events/?ray=${encodeURIComponent(r.ray)}`)} />)}</ul>}
    </Region>
  )
}
function FeedRow({ r, onOpen }: { r: EventRow; onOpen(): void }) {
  const [fresh] = useState(() => Date.now() - Date.parse(r.ts) < 10_000)
  return (
    <li>
      <button type="button" agentId={`event-${r.ray}`} className={cx('tvs-feed-row', fresh && 'is-new')} onClick={onOpen}>
        <span className="text-muted"><Ago ts={r.ts} /></span>
        <DecisionBadge d={r.decision} />
        <span className="truncate font-mono text-xs">{r.method ?? 'GET'} {r.path}</span>
        <span className="hidden truncate text-muted sm:inline">{[r.country && `${flag(r.country)} ${r.country}`, r.bot, r.ip].filter(Boolean).join(' · ')}</span>
        <span className="text-right tabular-nums" title="Score">{r.score}</span>
      </button>
    </li>
  )
}
