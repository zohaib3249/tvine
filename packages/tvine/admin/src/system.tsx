'use client'
// System section: Health, Logs, Agents, Metrics, Jobs, Security (admin.system.* actions), all live over the channel
// group admin:live (logs: admin:logs). Staff see health/agents/metrics/jobs; superusers also logs/security.
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'tvine/widgets'
import { ChartCard, DataTable, Sparkline, tableState, Stat, fmtValue, type ChartData, type StatTable } from './charts.js'
import { LivePill, useLive, useLiveData, type LiveState } from './live.js'
import type { User } from './types.js'
import { Empty, ErrorBox, Icon, Region, Skeleton, cx, useAdmin } from './ui.js'

export const SYSTEM_PAGES = [
  { page: 'health', title: 'Health', icon: 'heart', superuser: false },
  { page: 'traffic', title: 'Traffic', icon: 'chart', superuser: false },
  { page: 'metrics', title: 'Metrics', icon: 'gauge', superuser: false },
  { page: 'agents', title: 'Agents', icon: 'bot', superuser: false },
  { page: 'search', title: 'Search', icon: 'search', superuser: false },
  { page: 'pages', title: 'Pages', icon: 'chart', superuser: false },
  { page: 'queries', title: 'Database queries', icon: 'table', superuser: false },
  { page: 'jobs', title: 'Jobs', icon: 'layers', superuser: false },
  { page: 'logs', title: 'Logs', icon: 'logs', superuser: true },
  { page: 'security', title: 'Logins & security', icon: 'shield', superuser: true },
] as const
export type SystemPage = (typeof SYSTEM_PAGES)[number]['page']
// inside the panel admin.site answered, so the user is staff even when auth.me failed; superuser pages need auth.me
export const systemPagesFor = (u: User | null) => SYSTEM_PAGES.filter((p) => !p.superuser || !!u?.isSuperuser)

type Status = 'ok' | 'warn' | 'error'
const STATUS_TEXT: Record<Status, string> = { ok: 'Healthy', warn: 'Warning', error: 'Error' }
const STATUS_ICON: Record<Status, string> = { ok: 'check', warn: 'alert', error: 'x' }
export const StatusBadge = ({ s }: { s: Status }) => <span className="tva-status" data-s={s}><Icon name={STATUS_ICON[s] ?? 'alert'} size={11} />{STATUS_TEXT[s] ?? s}</span>
const ago = (t: string | number | undefined) => {
  if (t === undefined) return '—'
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
const time = (t: string) => { const d = new Date(t); return Number.isNaN(+d) ? t : d.toLocaleTimeString(undefined, { hour12: false }) }

function Header({ title, sub, live, children }: { title: string; sub?: string; live?: LiveState; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {children}
      <LivePill state={live} />
    </div>
  )
}

export function SystemView({ page }: { page: SystemPage }) {
  const { user } = useAdmin()
  const meta = SYSTEM_PAGES.find((p) => p.page === page)!
  if (!systemPagesFor(user).some((p) => p.page === page)) return <ErrorBox error={{ code: 'domain', reason: 'forbidden', message: `${meta.title} needs a ${meta.superuser ? 'superuser' : 'staff'} account.` }} />
  return (
    <Region id={`admin:system:${page}`} label={meta.title}>
      {page === 'health' ? <Health /> : page === 'logs' ? <Logs /> : page === 'agents' ? <Agents /> : page === 'metrics' ? <Metrics />
        : page === 'jobs' ? <Jobs /> : page === 'traffic' ? <Traffic /> : page === 'queries' ? <Queries /> : page === 'search' ? <Search /> : page === 'pages' ? <Pages /> : <Security />}
    </Region>
  )
}

const Loading = ({ error }: { error?: { code: string; message: string; reason?: string } }) => (error ? <ErrorBox error={error} /> : <div className="tva-card"><Skeleton rows={6} /></div>)

// one range for every system page that takes one (remembered per user)
const SYS_RANGES = ['1h', '24h', '7d', '30d', '90d'] as const
type SysRange = (typeof SYS_RANGES)[number]
function useRange(): [SysRange, (r: SysRange) => void] {
  const { prefs } = useAdmin()
  const [r, setR] = useState<SysRange>(() => prefs.get<SysRange>('system.range', '24h'))
  return [r, (x) => { setR(x); prefs.set('system.range', x) }]
}
function RangePicker({ value, onChange }: { value: SysRange; onChange(r: SysRange): void }) {
  return <div className="tva-seg" role="group" aria-label="Time range">{SYS_RANGES.map((r) => <button key={r} type="button" agentId={`range-${r}`} aria-pressed={value === r} onClick={() => onChange(r)}>{r}</button>)}</div>
}
type Table = StatTable
// a titled table card; `mono` columns (by name) render monospace, long cells truncate with the full text on hover
function TablePanel({ id, title, t, mono = [], empty = 'Nothing yet' }: { id: string; title: string; t?: Table; mono?: string[]; empty?: string }) {
  return (
    <Region id={`table:${id}`} label={title} state={tableState(t, 50)} className="tva-card min-w-0 overflow-hidden" as="section">
      <h2 className="border-b border-line px-4 py-3 font-semibold">{title}</h2>
      {!t?.rows.length ? <p className="px-4 py-8 text-center text-sm text-muted">{empty}</p> : <div className="max-h-96 overflow-auto"><DataTable t={t} mono={mono} /></div>}
    </Region>
  )
}

// ---- Health -----------------------------------------------------------------------------------------------------
type Health = { status: Status; at: string; sections: { name: string; title: string; status: Status; summary: string; details: Record<string, string | number | boolean | null> }[]; warnings: string[] }
function Health() {
  const { call } = useAdmin()
  const { data, error, live, reload, loading } = useLiveData<Health>(call, 'admin.system.health', {}, { group: 'admin:live', every: 15_000, types: ['tick', 'job'] })
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return <><Header title="Health" live={live} /><Loading error={error} /></>
  return (
    <>
      <Header title="Health" sub={`Checked ${ago(data.at)}`} live={live}>
        <StatusBadge s={data.status} />
        <button type="button" agentId="recheck" className="tva-btn" onClick={() => void reload()} disabled={loading}><Icon name="refresh" size={14} />Re-check</button>
      </Header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data.sections.map((s, i) => (
          <Region key={s.name} id={`health:${s.name}`} label={s.title} state={{ status: s.status, summary: s.summary.slice(0, 200) }}
            className={cx('tva-card tva-lift tva-enter flex flex-col p-4', `tva-tile-${s.status}`)} style={{ animationDelay: `${i * 40}ms` }}>
            <div className="mb-1 flex items-center gap-2"><h2 className="flex-1 font-semibold">{s.title}</h2><StatusBadge s={s.status} /></div>
            <p className="text-sm text-muted">{s.summary}</p>
            <button type="button" agentId="details" aria-expanded={open === s.name} className="mt-3 flex items-center gap-1 self-start text-xs font-medium text-accent"
              onClick={() => setOpen((o) => (o === s.name ? null : s.name))}>
              <Icon name={open === s.name ? 'up' : 'down'} size={12} />{open === s.name ? 'Hide details' : 'Details'}
            </button>
            {open === s.name && (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line pt-2 text-[13px]">
                {Object.entries(s.details).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-all text-right tabular-nums">{v === null ? '—' : String(v)}</dd></div>)}
              </dl>
            )}
          </Region>
        ))}
      </div>
      {data.warnings.length > 0 && (
        <section className="tva-card mt-4 p-4" aria-label="Configuration warnings">
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><Icon name="alert" className="text-warn" />Configuration warnings</h2>
          <ul className="space-y-1 text-sm">{data.warnings.map((w, i) => <li key={i} className="flex gap-2"><span className="text-warn">•</span>{w}</li>)}</ul>
        </section>
      )}
    </>
  )
}

// ---- Logs (superuser) -------------------------------------------------------------------------------------------
type LogRec = { seq: number; t: string; level: 'debug' | 'info' | 'warn' | 'error'; logger: string; msg: string; fields: Record<string, unknown> }
const LEVELS = ['debug', 'info', 'warn', 'error'] as const
function Logs() {
  const { call } = useAdmin()
  const [f, setF] = useState({ level: 'debug', logger: '', q: '', requestId: '' })
  const [recs, setRecs] = useState<LogRec[]>([])
  const [meta, setMeta] = useState<{ enabled: boolean; capacity: number }>()
  const [err, setErr] = useState<{ code: string; message: string; reason?: string }>()
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const fresh = useRef(new Set<number>())
  const box = useRef<HTMLDivElement>(null)
  const held = useRef<LogRec[]>([])
  const params = useMemo(() => ({ ...(f.level !== 'debug' && { level: f.level }), ...(f.logger && { logger: f.logger }), ...(f.q && { q: f.q }), ...(f.requestId && { requestId: f.requestId }), limit: 500 }), [f])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => void call('admin.system.logs', params).then((r) => {
      if (!live) return
      if (r.ok) { const d = r.data as { enabled: boolean; capacity: number; records: LogRec[] }; setMeta(d); setRecs(d.records); setErr(undefined) } else setErr({ code: r.code, message: r.message, reason: r.reason })
    }), 200)
    return () => { live = false; clearTimeout(t) }
  }, [params, call])
  const match = (r: LogRec) => LEVELS.indexOf(r.level) >= LEVELS.indexOf(f.level as LogRec['level']) && (!f.logger || r.logger.startsWith(f.logger))
    && (!f.requestId || r.fields?.requestId === f.requestId) && (!f.q || `${r.msg} ${JSON.stringify(r.fields)}`.toLowerCase().includes(f.q.toLowerCase()))
  const add = (rs: LogRec[]) => setRecs((cur) => {
    const seen = new Set(cur.map((r) => r.seq))
    const next = rs.filter((r) => !seen.has(r.seq) && match(r))
    for (const r of next) fresh.current.add(r.seq)
    return next.length ? [...cur, ...next].slice(-2000) : cur
  })
  const state = useLive('admin:logs', (fr) => {
    if (fr.type !== 'log' || !fr.record) return
    if (paused) held.current.push(fr.record as LogRec); else add([fr.record as LogRec])
  })
  useEffect(() => { if (!paused && held.current.length) { add(held.current); held.current = [] } }, [paused])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!paused && open === null) box.current?.scrollTo?.({ top: box.current.scrollHeight }) }, [recs, paused, open])
  // offline: poll for records after the last seq
  useEffect(() => {
    if (state !== 'offline' || paused) return
    const t = setInterval(() => void call('admin.system.logs', { ...params, after: recs[recs.length - 1]?.seq ?? 0 }).then((r) => { if (r.ok) add((r.data as { records: LogRec[] }).records) }), 5000)
    return () => clearInterval(t)
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((o) => ({ ...o, [k]: e.target.value }))
  return (
    <>
      <Header title="Logs" sub={meta ? `In-memory ring buffer · last ${meta.capacity.toLocaleString()} records · redacted` : undefined} live={state}>
        <button type="button" agentId="pause" aria-pressed={paused} className="tva-btn" onClick={() => setPaused((p) => !p)}>
          <Icon name={paused ? 'play' : 'pause'} size={14} />{paused ? `Resume${held.current.length ? ` (${held.current.length})` : ''}` : 'Pause'}
        </button>
        <button type="button" agentId="clear" className="tva-btn tva-btn-ghost" onClick={() => setRecs([])}>Clear</button>
      </Header>
      <div className="mb-3 flex flex-wrap gap-2">
        <select agentId="level" aria-label="Minimum level" value={f.level} onChange={set('level')} className="tva-input w-32">{LEVELS.map((l) => <option key={l} value={l}>{l} +</option>)}</select>
        <input agentId="logger" aria-label="Logger" placeholder="Logger (tvine.request)" value={f.logger} onChange={set('logger')} className="tva-input w-48" />
        <input agentId="q" type="search" aria-label="Search text" placeholder="Search message or fields…" value={f.q} onChange={set('q')} className="tva-input min-w-40 flex-1" />
        <input agentId="request-id" aria-label="Request id" placeholder="Request id" value={f.requestId} onChange={set('requestId')} className="tva-input w-44" />
      </div>
      {err ? <ErrorBox error={err} /> : meta && !meta.enabled ? <Empty title="Log buffer is off" icon="logs">Add <code className="tva-kbd">{"{ type: 'memory' }"}</code> to <code className="tva-kbd">settings.logging.handlers</code>.</Empty> : (
        <div ref={box} className="tva-card tva-log max-h-[calc(100dvh-16rem)] overflow-auto" role="log" aria-live={paused ? 'off' : 'polite'} aria-label="Log records">
          {!meta ? <Skeleton rows={10} /> : recs.length === 0 ? <Empty title="No records match" icon="logs" /> : recs.map((r) => (
            <div key={r.seq}>
              <button type="button" agentId={`log-${r.seq}`} aria-expanded={open === r.seq} onClick={() => setOpen((o) => (o === r.seq ? null : r.seq))}
                className={cx('tva-log-row', fresh.current.has(r.seq) && 'is-new')}>
                <span className="text-muted">{time(r.t)}</span><span className="tva-lvl" data-l={r.level}>{r.level}</span>
                <span className="truncate text-muted" title={r.logger}>{r.logger}</span><span className="truncate">{r.msg}{Object.keys(r.fields ?? {}).length > 0 && <span className="text-muted"> {Object.entries(r.fields).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ').slice(0, 160)}</span>}</span>
              </button>
              {open === r.seq && <pre className="tva-pre mx-3 my-2">{JSON.stringify(r, null, 2)}</pre>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---- Agents -----------------------------------------------------------------------------------------------------
type Agents = {
  activity?: ChartData; topAgents?: Table; topTokens?: Table; topActions?: Table; refusals?: Record<string, number>
  sessions: { id: string; agent: string; verified: boolean; via: string; lastAction: string | null; lastAt: string; actions: number; perMin: number }[]
  tabs: { id: string; page: string; since: string; agent: string; verified: boolean }[]
  recent: { t: string; agent: string; via: string; action: string; outcome: string; session: string }[]
}
const Unverified = () => <span className="tva-chip h-5 bg-sunken text-[10.5px] text-muted" title="The agent's name is self-declared">unverified</span>
function Agents() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const { data, error, live, reload, loading } = useLiveData<Agents>(call, 'admin.system.agents', { range }, { group: 'admin:live', types: ['agent', 'tick'] })
  const stop = async (id: string) => {
    const r = await call('admin.system.revokeTab', { id })
    toast(r.ok ? { kind: 'success', title: 'Control revoked', description: 'The agent no longer controls that tab.' } : { kind: 'error', title: 'Not revoked', description: r.message })
    void reload()
  }
  const picker = <RangePicker value={range} onChange={setRange} />
  if (!data) return <><Header title="Agents" live={live}>{picker}</Header><Loading error={error} /></>
  return (
    <>
      <Header title="Agents" sub="AI agents using this site: MCP sessions, controlled tabs and their recent actions" live={live}>{picker}</Header>
      {data.activity && (
        <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <ChartCard id="agents-activity" title="Actions: human vs agent" type="stacked" loading={loading} data={data.activity} className="xl:col-span-2" />
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-1">
            {Object.entries(data.refusals ?? {}).map(([k, v]) => <Kpi key={k} id={`refusal-${k}`} label={k === 'human_only' ? 'Human-only refusals' : k === 'confirm' ? 'Confirmations asked' : k} s={{ value: v, upIsGood: false }} />)}
          </div>
        </div>
      )}
      {(data.topAgents || data.topTokens || data.topActions) && (
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <TablePanel id="top-agents" title="Top agents" t={data.topAgents} />
          <TablePanel id="top-tokens" title="Top API tokens" t={data.topTokens} />
          <TablePanel id="top-actions" title="Top agent actions" t={data.topActions} mono={['Action', 'action']} />
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[['Active sessions', data.sessions.length], ['Controlled tabs', data.tabs.length], ['Actions / min', data.sessions.reduce((a, s) => a + s.perMin, 0)], ['Recent actions', data.recent.length]].map(([l, v], i) => (
          <Region key={String(l)} id={`kpi:${String(l).toLowerCase().replace(/\W+/g, '-')}`} label={String(l)} state={{ value: Number(v) }} className="tva-card tva-enter p-4" style={{ animationDelay: `${i * 40}ms` }}>
            <p className="text-[13px] font-semibold text-muted">{l}</p><Stat s={{ value: Number(v) }} label={String(l)} />
          </Region>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="tva-card overflow-hidden" aria-label="Controlled tabs">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Controlled tabs</h2>
          {data.tabs.length === 0 ? <Empty title="No tab is under agent control" icon="bot" /> : (
            <ul className="divide-y divide-line">{data.tabs.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <Icon name="bot" className="text-accent" />
                <div className="min-w-0 flex-1"><p className="flex items-center gap-2 font-medium">{t.agent}<Unverified /></p><p className="truncate text-xs text-muted">{t.page || '/'} · since {ago(t.since)}</p></div>
                <button type="button" agentId={`stop-${t.id}`} className="tva-btn tva-btn-danger-solid h-8" onClick={() => void stop(t.id)}><Icon name="stop" size={12} />Stop</button>
              </li>
            ))}</ul>
          )}
        </section>
        <section className="tva-card overflow-hidden" aria-label="Agent sessions">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Sessions (last 15 minutes)</h2>
          {data.sessions.length === 0 ? <Empty title="No agent activity yet" icon="bot">Connect an agent to <code className="tva-kbd">/mcp</code>.</Empty> : (
            <div className="overflow-x-auto"><table className="w-full text-[13px]">
              <thead><tr><th className="tva-th">Agent</th><th className="tva-th">Via</th><th className="tva-th">Last action</th><th className="tva-th text-right">Actions</th><th className="tva-th text-right">/min</th><th className="tva-th">Seen</th></tr></thead>
              <tbody>{data.sessions.map((s) => (
                <tr key={s.id} className="tva-row"><td className="tva-td"><span className="font-medium">{s.agent}</span> <span className="text-xs text-muted">#{s.id.slice(0, 8)}</span></td><td className="tva-td">{s.via}</td>
                  <td className="tva-td font-mono text-xs">{s.lastAction ?? '—'}</td><td className="tva-td text-right">{s.actions}</td><td className="tva-td text-right">{s.perMin}</td><td className="tva-td text-muted">{ago(s.lastAt)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>
      <section className="tva-card mt-4 overflow-hidden" aria-label="Recent agent actions">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Actions timeline</h2>
        {data.recent.length === 0 ? <Empty title="No agent actions yet" icon="clock" /> : (
          <ol className="max-h-[28rem] overflow-y-auto px-4 py-2">{data.recent.map((a, i) => (
            <li key={`${a.t}-${i}`} className="relative flex gap-3 border-l border-line py-2 pl-4">
              <span className={cx('absolute -left-[5px] top-3.5 size-2.5 rounded-full ring-2 ring-[var(--tva-surface)]', a.outcome === 'ok' ? 'bg-ok' : 'bg-danger')} aria-hidden="true" />
              <div className="min-w-0 flex-1"><p className="truncate"><span className="font-mono text-xs">{a.action}</span> <span className={cx('text-xs font-semibold', a.outcome === 'ok' ? 'text-ok' : 'text-danger')}>{a.outcome}</span></p>
                <p className="text-xs text-muted">{a.agent} · {a.via} · #{a.session.slice(0, 8)}</p></div>
              <time className="shrink-0 text-xs text-muted" dateTime={a.t}>{time(a.t)}</time>
            </li>
          ))}</ol>
        )}
      </section>
    </>
  )
}

// ---- Metrics ----------------------------------------------------------------------------------------------------
type Metrics = { intervalSec: number; points: { t: string; requests: number; errors: number; p50: number; p95: number; human: number; agent: number }[]; totals: { requests: number; errors: number; human: number; agent: number } }
function Metrics() {
  const { call } = useAdmin()
  const { data, error, live, loading } = useLiveData<Metrics>(call, 'admin.system.metrics', {}, { group: 'admin:live', types: ['tick'], every: 10_000 })
  if (!data) return <><Header title="Metrics" live={live} /><Loading error={error} /></>
  const P = data.points, per = 60 / (data.intervalSec || 10)
  const cd = (series: [string, string][], f: (p: Metrics['points'][number]) => number[], unit: ChartData['unit'] = 'number'): ChartData =>
    ({ groupBy: 'time', unit, series: series.map(([name, label]) => ({ name, label })), points: P.map((p) => ({ x: p.t, values: f(p) })) })
  const t = data.totals
  const errRate = t.requests ? (t.errors / t.requests) * 100 : 0
  return (
    <>
      <Header title="Metrics" sub={`In-process, one point every ${data.intervalSec}s, last hour`} live={live} />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi id="requests" label="Requests (1h)" s={{ value: t.requests, spark: P.map((p) => p.requests) }} />
        <Kpi id="error-rate" label="Error rate" s={{ value: +errRate.toFixed(2), unit: 'percent', spark: P.map((p) => (p.requests ? (p.errors / p.requests) * 100 : 0)) }} />
        <Kpi id="human" label="Human actions" s={{ value: t.human, spark: P.map((p) => p.human) }} />
        <Kpi id="agent" label="Agent actions" s={{ value: t.agent, spark: P.map((p) => p.agent) }} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard id="requests-min" title="Requests per minute" type="area" loading={loading} data={cd([['rpm', 'Requests / min']], (p) => [p.requests * per])} />
        <ChartCard id="latency" title="Latency" subtitle="p50 and p95, milliseconds" type="line" loading={loading} data={cd([['p50', 'p50'], ['p95', 'p95']], (p) => [p.p50, p.p95], 'ms')} />
        <ChartCard id="errors" title="Error rate" type="line" loading={loading} data={cd([['err', 'Errors %']], (p) => [p.requests ? +((p.errors / p.requests) * 100).toFixed(2) : 0], 'percent')} />
        <ChartCard id="callers" title="Actions by caller" type="stacked" loading={loading} data={cd([['human', 'Human'], ['agent', 'Agent']], (p) => [p.human, p.agent])} />
      </div>
    </>
  )
}
function Kpi({ id, label, s }: { id: string; label: string; s: Parameters<typeof Stat>[0]['s'] }) {
  return (
    <Region id={`kpi:${id}`} label={label} state={{ value: s.value }} className="tva-card tva-lift tva-enter p-4">
      <p className="mb-1 text-[13px] font-semibold text-muted">{label}</p><Stat s={s} label={label} />
    </Region>
  )
}

// ---- Jobs -------------------------------------------------------------------------------------------------------
type Jobs = { available: boolean; broker: string | null; counts: Record<string, number>; queues: { name: string; queued: number; running: number; scheduled: number; dead: number }[]; series?: ChartData; failed: { pk: string; task: string; queue: string; error: string; at: string; attempts: number }[]; canRetry: boolean }
function Jobs() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live, loading, reload } = useLiveData<Jobs>(call, 'admin.system.jobs', { range }, { group: 'admin:live', types: ['job', 'tick'], every: 15_000 })
  const [busy, setBusy] = useState<string | null>(null)
  const retry = async (pk: string) => {
    setBusy(pk)
    const r = await call('admin.action', { model: 'tasks.job', action: 'retry', pks: [pk] })
    setBusy(null)
    toast(r.ok ? { kind: 'success', title: 'Queued for retry', description: (r.data as { message?: string })?.message } : { kind: 'error', title: 'Retry failed', description: r.message })
    void reload()
  }
  if (!data) return <><Header title="Jobs" live={live}>{picker}</Header><Loading error={error} /></>
  if (!data.available) return <><Header title="Jobs" live={live} /><Empty title="Background tasks are not installed" icon="layers">Add <code className="tva-kbd">tvine.tasks</code> to <code className="tva-kbd">settings.installedApps</code>.</Empty></>
  const queues: ChartData = { groupBy: 'category', series: [['queued', 'Queued'], ['running', 'Running'], ['scheduled', 'Scheduled'], ['dead', 'Failed']].map(([name, label]) => ({ name: name!, label: label! })), points: data.queues.map((q) => ({ x: q.name, values: [q.queued, q.running, q.scheduled, q.dead] })) }
  return (
    <>
      <Header title="Jobs" sub={`Broker: ${data.broker ?? '—'}`} live={live}>{picker}</Header>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(['queued', 'running', 'scheduled', 'dead'] as const).map((k) => <Kpi key={k} id={`jobs-${k}`} label={k === 'dead' ? 'Failed' : k[0]!.toUpperCase() + k.slice(1)} s={{ value: data.counts[k] ?? 0, upIsGood: k !== 'dead' }} />)}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {data.series && <ChartCard id="jobs-throughput" title={data.series.title ?? 'Throughput'} type="stacked" loading={loading} data={data.series} />}
        <ChartCard id="jobs-queues" title="Queue depth" type="stacked" loading={loading} data={queues} />
      </div>
      <section className="tva-card mt-4 overflow-hidden" aria-label="Failed jobs">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Recent failures</h2>
        {data.failed.length === 0 ? <Empty title="No failed jobs" icon="check" /> : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]">
            <thead><tr><th className="tva-th">Task</th><th className="tva-th">Queue</th><th className="tva-th">Error</th><th className="tva-th text-right">Attempts</th><th className="tva-th">When</th><th className="tva-th" /></tr></thead>
            <tbody>{data.failed.map((j) => (
              <tr key={j.pk} className="tva-row"><td className="tva-td font-mono text-xs">{j.task}</td><td className="tva-td">{j.queue}</td><td className="tva-td max-w-80 truncate text-danger" title={j.error}>{j.error}</td>
                <td className="tva-td text-right">{j.attempts}</td><td className="tva-td text-muted">{ago(j.at)}</td>
                <td className="tva-td text-right">{data.canRetry && <button type="button" agentId={`retry-${j.pk}`} className="tva-btn h-8" disabled={busy === j.pk} onClick={() => void retry(j.pk)}><Icon name="refresh" size={12} />Retry</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

// ---- Security (superuser) ---------------------------------------------------------------------------------------
type Security = { logins?: ChartData; counts: Record<string, number>; series: ChartData; events: { t: string; event: string; level: string; ip?: string; userId?: string | null; via?: string; path?: string; action?: string }[] }
const EVENT_LABEL: Record<string, string> = { login_ok: 'Logins', login_failed: 'Failed logins', lockout: 'Lockouts', permission_denied: 'Permission denied', human_only: 'Human-only refusals', confirm_required: 'Confirmations', host_refused: 'Host refused', ip_refused: 'IP refused', origin_refused: 'Origin refused', rate_limited: 'Rate limited' }
function Security() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live, loading } = useLiveData<Security>(call, 'admin.system.security', { range }, { group: 'admin:live', types: ['security', 'tick'] })
  if (!data) return <><Header title="Logins & security" live={live}>{picker}</Header><Loading error={error} /></>
  const idx = (e: string) => data.series.series.findIndex((s) => s.name === e)
  const counts = Object.entries(data.counts).sort((a, b) => b[1] - a[1])
  return (
    <>
      <Header title="Logins & security" sub="Sign-ins and events from the tvine.security channel" live={live}>{picker}</Header>
      {data.logins && <ChartCard id="logins" title="Sign-ins" type="stacked" loading={loading} data={data.logins} className="mb-4" />}
      {counts.length === 0 ? <Empty title="No security events" icon="shield" /> : (
        <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {counts.map(([e, n], i) => (
            <Region key={e} id={`security:${e}`} label={EVENT_LABEL[e] ?? e} state={{ count: n }} className="tva-card tva-lift tva-enter p-4" style={{ animationDelay: `${i * 40}ms` }}>
              <p className="truncate text-[13px] font-semibold text-muted">{EVENT_LABEL[e] ?? e}</p>
              <div className="flex items-end justify-between gap-2"><p className="tva-stat-value">{n.toLocaleString()}</p>
                {idx(e) >= 0 && <Sparkline width={84} height={28} label={EVENT_LABEL[e] ?? e} values={data.series.points.map((p) => p.values[idx(e)] ?? 0)} />}</div>
            </Region>
          ))}
        </div>
      )}
      <ChartCard id="security-events" title="Events per hour" type="stacked" loading={loading} data={data.series} />
      <section className="tva-card mt-4 overflow-hidden" aria-label="Recent security events">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Recent events</h2>
        {data.events.length === 0 ? <Empty title="Nothing recorded yet" icon="shield" /> : (
          <div className="max-h-[32rem] overflow-auto"><table className="w-full text-[13px]">
            <thead><tr><th className="tva-th">Time</th><th className="tva-th">Event</th><th className="tva-th">Via</th><th className="tva-th">IP</th><th className="tva-th">User</th><th className="tva-th">Where</th></tr></thead>
            <tbody>{data.events.map((e, i) => (
              <tr key={i} className="tva-row"><td className="tva-td whitespace-nowrap text-muted">{time(e.t)}</td>
                <td className="tva-td"><span className="tva-lvl" data-l={e.level === 'info' ? 'info' : 'warn'}>{e.level}</span> {EVENT_LABEL[e.event] ?? e.event}</td>
                <td className="tva-td">{e.via ?? '—'}</td><td className="tva-td font-mono text-xs">{e.ip ?? '—'}</td><td className="tva-td">{e.userId ?? '—'}</td><td className="tva-td max-w-60 truncate font-mono text-xs">{e.action ?? e.path ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

// ---- Traffic ----------------------------------------------------------------------------------------------------
type Traffic = { requests: ChartData; status: ChartData; latency: ChartData; errorRate: ChartData; routes?: Table; actions?: { top?: Table; slowest?: Table; failing?: Table } }
function Traffic() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live, loading } = useLiveData<Traffic>(call, 'admin.system.traffic', { range }, { group: 'admin:live', types: ['tick'] })
  if (!data) return <><Header title="Traffic" live={live}>{picker}</Header><Loading error={error} /></>
  return (
    <>
      <Header title="Traffic" sub="Requests by transport, status, latency and errors" live={live}>{picker}</Header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard id="traffic-requests" title="Requests by transport" type="area" loading={loading} data={data.requests} />
        <ChartCard id="traffic-status" title="Responses by status" type="stacked" loading={loading} data={data.status} />
        <ChartCard id="traffic-latency" title="Latency" subtitle="p50 and p95, milliseconds" type="line" loading={loading} data={data.latency} />
        <ChartCard id="traffic-errors" title="Error rate" type="line" loading={loading} data={data.errorRate} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TablePanel id="routes" title="Busiest routes" t={data.routes} mono={['Route', 'route', 'Path', 'path']} />
        <TablePanel id="actions-top" title="Top actions" t={data.actions?.top} mono={['Action', 'action']} />
        <TablePanel id="actions-slowest" title="Slowest actions" t={data.actions?.slowest} mono={['Action', 'action']} />
        <TablePanel id="actions-failing" title="Failing actions" t={data.actions?.failing} mono={['Action', 'action']} empty="No failures" />
      </div>
    </>
  )
}

// ---- Queries ----------------------------------------------------------------------------------------------------
type Queries = { enabled: boolean; top?: Table; slow?: Table }
function Queries() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live } = useLiveData<Queries>(call, 'admin.system.queries', { range }, { group: 'admin:live', types: ['tick'] })
  if (!data) return <><Header title="Database queries" live={live}>{picker}</Header><Loading error={error} /></>
  const mono = ['fingerprint', 'Fingerprint', 'query', 'Query', 'SQL']
  return (
    <>
      <Header title="Database queries" sub="Database statements grouped by shape (values never shown)" live={live}>{picker}</Header>
      {!data.enabled ? <Empty title="Query stats are off" icon="table">Turn on query statistics in settings to record statement timings.</Empty> : (
        <div className="grid grid-cols-1 gap-4">
          <TablePanel id="queries-top" title="Most time spent" t={data.top} mono={mono} />
          <TablePanel id="queries-slow" title="Slow queries" t={data.slow} mono={mono} empty="No slow queries" />
        </div>
      )}
    </>
  )
}

// ---- Search (what visitors search for) + Pages (most visited) ----------------------------------------------------------
type Search = { enabled: boolean; total: number; noResultsPct: number; minCount: number; top?: Table; noResults?: Table; activity: ChartData }
function Search() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live, loading } = useLiveData<Search>(call, 'admin.system.search', { range }, { group: 'admin:live', types: ['tick'] })
  if (!data) return <><Header title="Search" live={live}>{picker}</Header><Loading error={error} /></>
  return (
    <>
      <Header title="Search" sub={`What visitors search for. A term shows once ${data.minCount} different visitors searched it; emails, numbers and tokens are never kept`} live={live}>{picker}</Header>
      {!data.enabled ? <Empty title="Search stats are off" icon="search">Turn on settings.admin.stats.searches to count what visitors search for.</Empty> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Kpi id="search-total" label="Searches" s={{ value: data.total, unit: 'count' }} />
            <Kpi id="search-none" label="No results" s={{ value: data.noResultsPct, unit: 'percent' }} />
          </div>
          <ChartCard id="search-activity" title="Searches: human vs agent" type="stacked" loading={loading} data={data.activity} />
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <TablePanel id="search-top" title="Top searches" t={data.top} empty="No searches yet" />
            <TablePanel id="search-none" title="Searches with no results" t={data.noResults} empty="Every search found something" />
          </div>
        </>
      )}
    </>
  )
}
type Pages = { enabled: boolean; views: number; visitors: number; agentReads: number; top?: Table; entries?: Table; agentTop?: Table; activity: ChartData }
function Pages() {
  const { call } = useAdmin()
  const [range, setRange] = useRange()
  const picker = <RangePicker value={range} onChange={setRange} />
  const { data, error, live, loading } = useLiveData<Pages>(call, 'admin.system.pages', { range }, { group: 'admin:live', types: ['tick'] })
  if (!data) return <><Header title="Pages" live={live}>{picker}</Header><Loading error={error} /></>
  const mono = ['Path', 'Entry page']
  return (
    <>
      <Header title="Pages" sub="Most visited pages (paths without query strings; admin, media and static files are not counted)" live={live}>{picker}</Header>
      {!data.enabled ? <Empty title="Page stats are off" icon="chart">Turn on settings.admin.stats.pages to count page views.</Empty> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Kpi id="pages-views" label="Page views" s={{ value: data.views, unit: 'count' }} />
            <Kpi id="pages-visitors" label="Visitors" s={{ value: data.visitors, unit: 'count' }} />
            <Kpi id="pages-agent" label="Agent page reads" s={{ value: data.agentReads, unit: 'count' }} />
          </div>
          <ChartCard id="pages-activity" title="Page views: human vs agent" type="stacked" loading={loading} data={data.activity} />
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <TablePanel id="pages-top" title="Most visited pages" t={data.top} mono={mono} empty="No page views yet" />
            <TablePanel id="pages-entry" title="Entry pages" t={data.entries} mono={mono} empty="No entries yet" />
            <TablePanel id="pages-agent" title="Pages agents read" t={data.agentTop} mono={mono} empty="No agent reads yet" />
          </div>
        </>
      )}
    </>
  )
}
