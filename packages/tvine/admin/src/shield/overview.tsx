'use client'
// Overview: KPIs, traffic by decision, top blocked IP/ASN/country/bot, score histogram, live feed. One shield.overview
// call per range; live frames (admin:live, type 'shield') refetch it and the feed. Skeletons only before the first data;
// a range change keeps the old numbers on screen (dimmed) until the new ones land.
import { useState } from 'react'
import { ChartCard, DataTable, Stat, tableState, type ChartData } from '../charts.js'
import { RANGES } from '../data.js'
import { LivePill, useLiveData } from '../live.js'
import { Empty, ErrorBox, Icon, Region, cx } from '../ui.js'
import { useShield } from './ctx.js'
import type { Count, EventPage, EventRow, Overview as Data } from './types.js'

const LIVE = { group: 'admin:live', types: ['shield'] }
export const DECISION_LABEL: Record<string, string> = { pass: 'Passed', allow: 'Allowed', log: 'Logged', challenge: 'Challenged', block: 'Blocked', rateLimit: 'Rate limited', custom: 'Custom' }

export function Overview() {
  const { call, query, setQuery } = useShield()
  const range = (RANGES as readonly string[]).includes(query.range ?? '') ? query.range! : '24h'
  const o = useLiveData<Data>(call, 'shield.overview', { range }, LIVE)
  const d = o.data
  const t = d?.totals
  const kpis: { id: string; label: string; value?: number; prev?: number; unit?: 'percent'; upIsGood?: boolean }[] = [
    { id: 'requests', label: 'Requests', value: t?.requests, prev: t?.previous?.requests },
    { id: 'blocked', label: 'Blocked', value: t?.blocked, prev: t?.previous?.blocked, upIsGood: false },
    { id: 'challenged', label: 'Challenged', value: t?.challenged, prev: t?.previous?.challenged, upIsGood: false },
    { id: 'pass-rate', label: 'Challenge pass rate', value: t?.passRate, prev: t?.previous?.passRate, unit: 'percent' },
    { id: 'avg-score', label: 'Avg. score', value: t?.avgScore, prev: t?.previous?.avgScore },
  ]
  const series: ChartData | undefined = d && { ...d.series, unit: 'count', series: d.series.series.map((s) => ({ ...s, label: DECISION_LABEL[s.name] ?? s.label })) }
  const hist: ChartData | undefined = d && {
    groupBy: 'category', unit: 'count', series: [{ name: 'n', label: 'Requests' }],
    points: d.histogram.map((n, i) => ({ x: `${i * 10 + 1}–${i === 9 ? 99 : i * 10 + 10}`, values: [n] })),
  }
  const empty = d && d.totals.requests === 0
  return (
    <Region id="shield:overview" label="Shield overview" state={{ range, requests: t?.requests ?? null, blocked: t?.blocked ?? null, loading: o.loading }}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">What Shield saw and did with your traffic.</p>
        </div>
        <LivePill state={o.live} />
        <div className="tva-seg" role="group" aria-label="Time range">
          {RANGES.map((r) => <button key={r} type="button" agentId={`range-${r}`} aria-pressed={range === r} onClick={() => setQuery({ ...query, range: r })}>{r}</button>)}
        </div>
        <button type="button" agentId="refresh" aria-label="Refresh" className="tva-btn tva-btn-ghost tva-btn-icon" onClick={() => void o.reload()} disabled={o.loading}><Icon name="refresh" className={cx(o.loading && 'animate-spin')} /></button>
      </div>
      {o.error && !d && <ErrorBox error={o.error} />}
      <div className={cx('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', o.loading && d && 'opacity-70 transition-opacity')}>
        {kpis.map((k) => (
          <Region key={k.id} id={`kpi:${k.id}`} label={k.label} state={{ value: k.value ?? null }} className={cx('tva-card tva-lift p-4', k.id === 'avg-score' && 'col-span-2 sm:col-span-1')}>
            <p className="mb-1 text-[13px] font-semibold text-muted">{k.label}</p>
            {k.value === undefined ? <div aria-busy="true"><div className="tva-skel mb-1 h-8 w-24" /><div className="tva-skel h-3 w-32" /></div>
              : <Stat s={{ value: k.value, previous: k.prev, unit: k.unit, upIsGood: k.upIsGood }} label={k.label} />}
          </Region>
        ))}
      </div>
      {empty ? (
        <div className="tva-card mt-4"><Empty title="No traffic yet" icon="shield">Shield has not seen requests in this range. Try a longer range, or send one with <strong>Test a request</strong>.</Empty></div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ChartCard id="traffic" title="Traffic by decision" type="stacked" data={series} loading={o.loading} height={240} className="tvs-decisions lg:col-span-2" />
          <ChartCard id="scores" title="Score histogram" subtitle="1 = surely a bot · 99 = surely a human" type="bar" data={hist} loading={o.loading} height={240} />
        </div>
      )}
      {!empty && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Top id="ips" title="Top blocked IPs" col="IP" rows={d?.top.ips} mono />
          <Top id="asns" title="Top blocked networks (ASN)" col="ASN" rows={d?.top.asns} />
          <Top id="countries" title="Top blocked countries" col="Country" rows={d?.top.countries} />
          <Top id="bots" title="Top bots" col="Bot" rows={d?.top.bots} />
        </div>
      )}
      {!empty && <div className="mt-4"><Feed /></div>}
    </Region>
  )
}

function Top({ id, title, col, rows, mono }: { id: string; title: string; col: string; rows?: Count[]; mono?: boolean }) {
  const t = rows && { columns: [col, 'Requests'], rows: rows.map((r) => [r.label ? `${r.key} · ${r.label}` : r.key, r.count]) }
  return (
    <Region id={`top:${id}`} label={title} state={tableState(t)} className="tva-card flex min-w-0 flex-col overflow-hidden">
      <h3 className="px-4 pt-4 pb-2 text-[13px] font-semibold text-muted">{title}</h3>
      {!t ? <div className="space-y-2 p-4 pt-0" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="tva-skel h-5" />)}</div>
        : t.rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">Nothing blocked here.</p>
        : <div className="max-h-64 overflow-auto"><DataTable t={t} mono={mono ? [col] : []} /></div>}
    </Region>
  )
}

export const decisionTone = (d: string) => (/block|rateLimit/.test(d) ? 'error' : /challenge/.test(d) ? 'warn' : /would|log/.test(d) ? 'info' : 'ok')
export const DecisionBadge = ({ d }: { d: string }) => <span className="tvs-decision" data-t={decisionTone(d)}>{d.startsWith('would-') ? `would ${d.slice(6)}` : DECISION_LABEL[d] ?? d}</span>

function Feed() {
  const { call, base, navigate } = useShield()
  const f = useLiveData<EventPage>(call, 'shield.events', { filters: {}, page: 1, pageSize: 12 }, LIVE)
  const rows = f.data?.rows.slice(0, 12)
  return (
    <Region id="shield:feed" label="Live feed" state={{ count: rows?.length ?? 0, latest: rows?.[0]?.ray ?? null }} className="tva-card flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <h3 className="flex-1 text-[13px] font-semibold text-muted">Live feed</h3>
        <LivePill state={f.live} />
        <a href={`${base}/events/`} agentId="all-events" className="tva-btn tva-btn-ghost h-7 px-2 text-xs" onClick={(e) => { e.preventDefault(); navigate(`${base}/events/`) }}>All events<Icon name="chevron" size={12} /></a>
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
        <span className="text-muted">{new Date(r.ts).toLocaleTimeString()}</span>
        <DecisionBadge d={r.decision} />
        <span className="truncate">{r.method ?? 'GET'} {r.path}</span>
        <span className="hidden truncate text-muted sm:inline">{[r.country, r.bot, r.ip].filter(Boolean).join(' · ')}</span>
        <span className="text-right tabular-nums" title="Score">{r.score}</span>
      </button>
    </li>
  )
}
