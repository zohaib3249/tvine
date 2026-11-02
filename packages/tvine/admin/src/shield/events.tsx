'use client'
// Events (sampled logs): filter bar + range, filtered volume, dense table with a column picker, the event drawer with
// actions (filter by IP, IP profile, block / allow, create a rule from it), and the IP profile page (/shield/ip/<ip>).
import { useEffect, useState, type ReactNode } from 'react'
import { Drawer } from '../../../weft/dist/widgets/index.js'
import { XYChart, type ChartData } from '../charts.js'
import { LivePill, useLiveData } from '../live.js'
import { Empty, ErrorBox, Icon, Region, Skeleton, cx } from '../ui.js'
import { useShield, write } from './ctx.js'
import { Ago, FilterBar, RangeBar, countryName, flag, num, pct, useFilters } from './kit.js'
import { DECISION_LABEL, DecisionBadge, LIVE, analyticsInput } from './overview.js'
import { Score, SignalGrid } from './pages.js'
import type { Analytics, Condition, EventDetail, EventPage, EventRow, IpProfile as IpData, Rule } from './types.js'

const listOf = (d: unknown): Rule[] => (Array.isArray(d) ? d : (d as { rules?: Rule[] } | undefined)?.rules ?? [])
const useRules = () => { const { call } = useShield(); return listOf(useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {}).data) }

// ---- the table ----------------------------------------------------------------------------------------------------------
type Col = { key: string; label: string; cell(r: EventRow, rules: Rule[]): ReactNode; right?: boolean; off?: boolean }
export const COLS: Col[] = [
  { key: 'time', label: 'Time', cell: (r) => <span className="text-muted"><Ago ts={r.ts} /></span> },
  { key: 'ray', label: 'Ray', cell: (r) => <span className="font-mono text-xs text-accent">{r.ray}</span> },
  { key: 'ip', label: 'IP', cell: (r) => <span className="font-mono text-xs">{r.country && <span className="mr-1 font-sans">{flag(r.country)}</span>}{r.ip ?? '—'}</span> },
  { key: 'country', label: 'Country', cell: (r) => (r.local ? <span title="Local network (localhost / private address)">Local</span> : r.country ? <span title={countryName(r.country)}>{r.country}</span> : '—'), off: true },
  { key: 'asn', label: 'ASN', cell: (r) => (r.asn ? <span title={r.asnOrg}>AS{r.asn}{r.asnOrg && <span className="ml-1 text-muted">{r.asnOrg}</span>}</span> : '—') },
  { key: 'path', label: 'Request', cell: (r) => <span className="block max-w-[22rem] truncate font-mono text-xs" title={`${r.method ?? 'GET'} ${r.host ?? ''}${r.path}`}><span className="text-muted">{r.method ?? 'GET'}</span> {r.path}</span> },
  { key: 'host', label: 'Host', cell: (r) => r.host ?? '—', off: true },
  { key: 'bot', label: 'Bot', cell: (r) => r.bot ?? (r.botCategory && r.botCategory !== 'browser' ? r.botCategory : '—') },
  { key: 'ua', label: 'User agent', cell: (r) => r.uaFamily ?? '—', off: true },
  { key: 'score', label: 'Score', cell: (r) => <Score n={r.score} />, right: true },
  { key: 'decision', label: 'Decision', cell: (r) => <DecisionBadge d={r.decision} /> },
  { key: 'status', label: 'Status', cell: (r) => r.status ?? '—', off: true, right: true },
  { key: 'rule', label: 'Rule', cell: (r, rules) => <span className="block max-w-[12rem] truncate text-muted">{rules.find((x) => x.id === r.ruleId)?.name ?? r.ruleId ?? '—'}</span> },
]
const PREF = 'tvs:event-cols'
function useCols(): [string[], (k: string) => void] {
  const [cols, setCols] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem(PREF) ?? 'null'); if (Array.isArray(v)) return v } catch { /* */ } return COLS.filter((c) => !c.off).map((c) => c.key) })
  const toggle = (k: string) => setCols((c) => { const n = c.includes(k) ? c.filter((x) => x !== k) : [...c, k]; try { localStorage.setItem(PREF, JSON.stringify(n)) } catch { /* */ } return n })
  return [cols, toggle]
}

export function EventsTable({ rows, cols, rules, selected, onOpen }: { rows: EventRow[]; cols: string[]; rules: Rule[]; selected?: string; onOpen(r: EventRow): void }) {
  const shown = COLS.filter((c) => cols.includes(c.key))
  return (
    <div className="overflow-x-auto">
      <table className="tvs-table w-full text-[13px]">
        <thead><tr>{shown.map((c) => <th key={c.key} className={cx('tva-th', c.right && 'text-right')}>{c.label}</th>)}<th className="tva-th w-8"><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.ray} className="tva-row cursor-pointer" data-selected={selected === r.ray || undefined} onClick={() => onOpen(r)}>
            {shown.map((c) => <td key={c.key} className={cx('tva-td whitespace-nowrap', c.right && 'text-right')}>{c.cell(r, rules)}</td>)}
            <td className="tva-td"><button type="button" agentId={`open-${r.ray}`} aria-label={`Open event ${r.ray}`} className="tva-btn tva-btn-ghost tva-btn-icon h-7 w-7" onClick={(e) => { e.stopPropagation(); onOpen(r) }}><Icon name="chevron" size={14} /></button></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function ColumnPicker({ cols, toggle }: { cols: string[]; toggle(k: string): void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button type="button" agentId="columns" aria-expanded={open} className="tva-btn h-8 px-2 text-xs" onClick={() => setOpen((o) => !o)}><Icon name="columns" size={14} />Columns</button>
      {open && (
        <div role="dialog" aria-label="Columns" className="tvs-pop right-0 left-auto w-48" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          {COLS.map((c) => (
            <label key={c.key} className="flex items-center gap-2 py-0.5 text-[13px]">
              <input type="checkbox" agentId={`col-${c.key}`} className="tva-check" checked={cols.includes(c.key)} onChange={() => toggle(c.key)} />{c.label}
            </label>
          ))}
          <button type="button" agentId="columns-done" className="tva-btn mt-2 h-7 w-full text-xs" onClick={() => setOpen(false)}>Done</button>
        </div>
      )}
    </div>
  )
}

// ---- Events page --------------------------------------------------------------------------------------------------------
const SIZES = [25, 50, 100]
export function Events() {
  const { call, query, setQuery } = useShield()
  const s = useFilters()
  const rules = useRules()
  const [cols, toggle] = useCols()
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = SIZES.includes(Number(query.size)) ? Number(query.size) : 25
  const ev = useLiveData<EventPage>(call, 'shield.events', { filters: s.filters, ...s.window, page, pageSize }, LIVE)
  const vol = useLiveData<Analytics>(call, 'shield.analytics', analyticsInput(s), LIVE)
  const d = ev.data
  const series: ChartData | undefined = vol.data && { ...vol.data.series, unit: 'count', title: 'Volume' }
  const set = (q: Record<string, string>) => setQuery({ ...query, ...q })
  return (
    <Region id="shield:events" label="Events" state={{ count: d?.count ?? 0, page, pageSize, ray: query.ray ?? null, filters: s.filters.length }}>
      <RangeBar title="Events" sub="Sampled request logs: every challenge and block, a sample of passes. Click a row for the full story." s={s}><LivePill state={ev.live} /></RangeBar>
      <div className="mb-3"><FilterBar s={s} /></div>
      <Region id="chart:volume" label="Filtered volume" state={{ requests: vol.data?.totals.requests ?? null, mitigated: vol.data?.totals.mitigated ?? null }} className="tva-card tvs-traffic mb-4 px-4 pt-3 pb-1">
        <div className="mb-1 flex items-center gap-3 text-xs text-muted">
          <span className="font-semibold text-fg">Volume</span>
          {vol.data && <><span><strong className="text-fg tabular-nums">{num(vol.data.totals.requests)}</strong> requests</span><span><strong className="text-fg tabular-nums">{num(vol.data.totals.mitigated)}</strong> mitigated ({pct(vol.data.totals.mitigated, vol.data.totals.requests)})</span></>}
          <span className="ml-auto hidden sm:inline">Drag to zoom</span>
        </div>
        {!series ? <div className="tva-skel mb-3 h-[90px]" aria-busy="true" /> : <XYChart d={series} kind="area" height={90} onBrush={(a, b) => s.setWindow(series.points[a]!.x, series.points[b]!.x)} />}
      </Region>
      <div className="tva-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[13px]"><strong className="tabular-nums">{d ? d.count.toLocaleString() : '…'}</strong> <span className="text-muted">events</span></span>
          {ev.loading && d && <span className="text-xs text-muted" role="status">Updating…</span>}
          <div className="flex-1" />
          <ColumnPicker cols={cols} toggle={toggle} />
        </div>
        {ev.error && !d ? <div className="p-4"><ErrorBox error={ev.error} /></div>
          : !d ? <Skeleton rows={10} />
          : d.rows.length === 0 ? <Empty title="No events match" icon="search">Try a longer range or fewer filters.</Empty>
          : <div className={cx('transition-opacity', ev.loading && 'opacity-60')}><EventsTable rows={d.rows} cols={cols} rules={rules} selected={query.ray} onOpen={(r) => set({ ray: r.ray })} /></div>}
        {d && d.count > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-3 text-sm">
            <label className="mr-auto flex items-center gap-2 text-xs text-muted">Rows
              <select agentId="page-size" className="tva-input h-8 w-20" value={pageSize} onChange={(e) => set({ size: e.target.value, page: '' })}>{SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <span className="text-muted">Page {d.page} of {d.pages}</span>
            <button type="button" agentId="prev" className="tva-btn h-8" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
            <button type="button" agentId="next" className="tva-btn h-8" disabled={page >= d.pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
          </div>
        )}
      </div>
      <Drawer name="event" label="Event detail" side="right" open={!!query.ray} onOpenChange={(o) => { if (!o) set({ ray: '' }) }} slots={{ trigger: { className: 'hidden' }, content: { className: 'tvs-drawer' } }}>
        {query.ray && <EventDrawer ray={query.ray} rules={rules} onFilterIp={(ip) => s.add({ field: 'ip', op: 'eq', value: ip }, { ray: '' })} />}
      </Drawer>
    </Region>
  )
}

// a rule draft from one event: same IP and path (the editor lets you widen it)
export const ruleFrom = (r: EventRow): Condition => ({ all: [
  ...(r.ip ? [{ field: 'ip', op: 'eq' as const, value: r.ip }] : []),
  { field: 'path', op: 'eq' as const, value: r.path },
  ...(r.bot ? [{ field: 'bot.name', op: 'eq' as const, value: r.bot }] : []),
] })

function EventDrawer({ ray, rules, onFilterIp }: { ray: string; rules: Rule[]; onFilterIp(ip: string): void }) {
  const { call, base, navigate } = useShield()
  const e = useLiveData<EventDetail>(call, 'shield.event', { ray })
  if (e.error && !e.data) return <div className="p-1"><h2 className="mb-3 font-mono text-sm">{ray}</h2><ErrorBox error={e.error} /></div>
  if (!e.data) return <Skeleton rows={10} />
  const { event: r, signals, decision } = e.data
  const ip = r.ip ?? signals?.ip
  const list = (l: 'allow' | 'deny') => write(call, 'shield.lists.save', { entries: [{ kind: 'ip', value: ip, list: l, note: `from event ${ray}` }] }, l === 'deny' ? `Blocked ${ip}` : `Allowed ${ip}`)
  const rule = () => navigate(`${base}/rules/new/?when=${encodeURIComponent(JSON.stringify(ruleFrom({ ...r, ip })))}&name=${encodeURIComponent(`From event ${ray}`)}`)
  const ua = r.ua ?? signals?.ua
  return (
    <Region id="shield:event" label={`Event ${ray}`} state={{ ray, decision: r.decision, score: r.score, ip: ip ?? null }} className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-muted">Ray ID</p>
        <h2 className="font-mono text-sm break-all">{ray}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2"><DecisionBadge d={r.decision} /><Score n={r.score} /><span className="text-sm text-muted" title={new Date(r.ts).toLocaleString()}><Ago ts={r.ts} /></span>{r.mode && <span className="tva-chip">{r.mode}</span>}</div>
      </div>
      <p className="rounded-md bg-sunken p-2 font-mono text-xs break-all"><strong>{r.method ?? 'GET'}</strong> {r.host ?? signals?.host ?? ''}{r.path}{r.status ? <span className="text-muted"> → {r.status}</span> : null}</p>
      {ip && (
        <Region id="event:actions" label="Event actions" state={{ ip }} className="grid grid-cols-2 gap-2">
          <button type="button" agentId="filter-ip" className="tva-btn h-8 text-xs" onClick={() => onFilterIp(ip)}><Icon name="filter" size={13} />Filter by this IP</button>
          <button type="button" agentId="ip-profile" className="tva-btn h-8 text-xs" onClick={() => navigate(`${base}/ip/${encodeURIComponent(ip)}/`)}><Icon name="user" size={13} />Open IP profile</button>
          <button type="button" agentId="block-ip" className="tva-btn tva-btn-danger h-8 text-xs" onClick={() => void list('deny')}><Icon name="stop" size={13} />Block IP</button>
          <button type="button" agentId="allow-ip" className="tva-btn h-8 text-xs" onClick={() => void list('allow')}><Icon name="check" size={13} />Allow IP</button>
          <button type="button" agentId="create-rule" className="tva-btn tva-btn-primary col-span-2 h-8 text-xs" onClick={rule}><Icon name="plus" size={13} />Create rule from this</button>
          <button type="button" agentId="test-code" className="tva-btn col-span-2 h-8 text-xs" onClick={() => navigate(`${base}/rules/new/?action=code&ray=${encodeURIComponent(ray)}&name=${encodeURIComponent(`Code rule from ${ray}`)}`)}><Icon name="code" size={13} />Test code with this event</button>
        </Region>
      )}
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Decision</h3>
        <dl className="tvs-kv">
          <div><dt>Action</dt><dd>{DECISION_LABEL[decision?.action ?? r.decision] ?? r.decision}{(decision?.level ?? r.level) ? ` · ${decision?.level ?? r.level}` : ''}{decision?.status ? ` · ${decision.status}` : ''}</dd></div>
          <div><dt>Why</dt><dd>{decision?.reason ?? r.reason ?? '—'}</dd></div>
          <div><dt>Rule</dt><dd>{(decision?.ruleId ?? r.ruleId) ? rules.find((x) => x.id === (decision?.ruleId ?? r.ruleId))?.name ?? decision?.ruleId ?? r.ruleId : 'none (lists / default)'}</dd></div>
          <div><dt>Mode</dt><dd>{decision?.mode ?? r.mode ?? '—'}</dd></div>
          {decision && <div><dt>Took</dt><dd>{decision.ms.toFixed(2)} ms</dd></div>}
          {r.solveMs !== undefined && <div><dt>Solve time</dt><dd>{r.solveMs >= 1000 ? `${(r.solveMs / 1000).toFixed(1)} s` : `${r.solveMs} ms`}</dd></div>}
        </dl>
      </section>
      {ua && <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">User agent</h3><p className="rounded-md bg-sunken p-2 font-mono text-xs break-all">{ua}</p></section>}
      {signals ? <SignalGrid s={signals} /> : <p className="text-sm text-muted">Signals were not kept for this event (sampling).</p>}
      {e.data.headers && <div><h3 className="mb-1 text-xs font-semibold uppercase text-muted">Headers</h3><pre className="tva-pre">{Object.entries(e.data.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre></div>}
    </Region>
  )
}

// ---- IP profile ---------------------------------------------------------------------------------------------------------
export function IpProfile({ ip }: { ip: string }) {
  const { call, base, navigate } = useShield()
  const rules = useRules()
  const p = useLiveData<IpData>(call, 'shield.ip', { ip })
  const [cols] = useCols()
  const d = p.data
  useEffect(() => { document.getElementById('tvs-main')?.scrollTo?.(0, 0) }, [ip])
  const list = async (l: 'allow' | 'deny') => { if (await write(call, 'shield.lists.save', { entries: [{ kind: 'ip', value: ip, list: l }] }, l === 'deny' ? `Blocked ${ip}` : `Allowed ${ip}`)) void p.reload() }
  const remove = async (id: string) => { if (await write(call, 'shield.lists.delete', { id }, 'Removed from list')) void p.reload() }
  const by = Object.entries(d?.counts.byDecision ?? {}).sort((a, b) => b[1] - a[1])
  const total = Math.max(1, d?.counts.requests ?? 0)
  return (
    <Region id="shield:ip" label={`IP ${ip}`} state={{ ip, requests: d?.counts.requests ?? null, mitigated: d?.counts.mitigated ?? null, verdict: d?.test.action ?? null, lists: d?.lists.map((l) => `${l.list}:${l.value}`).join(',') ?? '' }}>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-[13px] text-muted">
        <a href={`${base}/events/`} agentId="crumb-events" className="hover:text-fg hover:underline" onClick={(e) => { e.preventDefault(); navigate(`${base}/events/`) }}>Events</a>
        <Icon name="chevron" size={12} /><span aria-current="page" className="font-mono text-fg">{ip}</span>
      </nav>
      {p.error && !d ? <ErrorBox error={p.error} /> : !d ? <div className="tva-card"><Skeleton rows={8} /></div> : (
        <>
          <section className="tva-card flex flex-wrap items-start gap-4 p-5">
            <span className="text-4xl leading-none" aria-hidden="true">{flag(d.country)}</span>
            <div className="min-w-0 flex-1">
              <h1 className="font-mono text-xl font-semibold break-all">{d.ip}</h1>
              <p className="text-sm text-muted">{countryName(d.country)} · {d.asn ? `AS${d.asn}` : 'unknown network'}{d.asnOrg ? ` · ${d.asnOrg}` : ''} · {d.ipNet}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.asnKind && <span className="tva-chip">{d.asnKind}</span>}
                {d.tor && <span className="tvs-decision" data-t="error">Tor exit</span>}
                {d.lists.map((l) => (
                  <span key={l.id} className="tvs-chip" data-neg={l.list === 'deny' || undefined}>
                    <span className="font-semibold">{l.list === 'deny' ? 'Deny list' : 'Allow list'}</span><span className="font-mono">{l.value}</span>
                    <button type="button" agentId={`unlist-${l.id}`} aria-label={`Remove ${l.value} from the ${l.list} list`} onClick={() => void remove(l.id)}><Icon name="x" size={12} /></button>
                  </span>
                ))}
              </div>
            </div>
            <Region id="ip:actions" label="IP actions" state={{ listed: d.lists.length }} className="flex flex-wrap gap-2">
              <button type="button" agentId="block" className="tva-btn tva-btn-danger" disabled={d.lists.some((l) => l.list === 'deny' && l.value === ip)} onClick={() => void list('deny')}><Icon name="stop" size={14} />Block IP</button>
              <button type="button" agentId="allow" className="tva-btn" disabled={d.lists.some((l) => l.list === 'allow' && l.value === ip)} onClick={() => void list('allow')}><Icon name="check" size={14} />Allow IP</button>
              <button type="button" agentId="events" className="tva-btn tva-btn-ghost" onClick={() => navigate(`${base}/events/?f=${encodeURIComponent(`ip:${encodeURIComponent(ip)}`)}`)}><Icon name="table" size={14} />All events</button>
            </Region>
          </section>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Fact label="Requests" v={num(d.counts.requests)} />
            <Fact label="Mitigated" v={num(d.counts.mitigated)} sub={pct(d.counts.mitigated, d.counts.requests)} />
            <Fact label="First seen" v={<Ago ts={d.firstSeen} />} />
            <Fact label="Last seen" v={<Ago ts={d.lastSeen} />} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Region id="ip:decisions" label="Decisions" state={{ parts: by.map(([k, v]) => `${k} ${v}`).join(', ') }} className="tva-card p-4">
              <h2 className="mb-3 text-[13px] font-semibold">Decisions for this IP</h2>
              {by.length === 0 ? <p className="text-sm text-muted">No requests recorded.</p> : <ul className="flex flex-col gap-2">{by.map(([k, v]) => (
                <li key={k} className="tvs-funnel" data-t={k === 'pass' || k === 'allow' ? 'ok' : k === 'challenge' ? 'warn' : k === 'log' ? 'info' : 'error'}>
                  <span className="w-28 shrink-0"><DecisionBadge d={k} /></span><span className="tvs-funnel-bar"><span style={{ width: `${(v / total) * 100}%` }} /></span><span className="w-16 text-right text-[13px] tabular-nums">{num(v)}</span>
                </li>
              ))}</ul>}
            </Region>
            <Region id="ip:verdict" label="Live verdict" state={{ action: d.test.action, score: d.test.score, rule: d.test.ruleId ?? null }} className="tvs-verdict tva-card p-4" data-t={/block|rateLimit/.test(d.test.action) ? 'error' : d.test.action === 'challenge' ? 'warn' : 'ok'}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">If this IP sent a plain browser request now</p>
              <div className="mt-1 flex flex-wrap items-center gap-3"><span className="text-2xl font-semibold">{DECISION_LABEL[d.test.action] ?? d.test.action}</span><Score n={d.test.score} /></div>
              <p className="mt-1 text-sm text-muted">{d.test.reason}{d.test.ruleId && <> — rule <strong className="text-fg">{rules.find((r) => r.id === d.test.ruleId)?.name ?? d.test.ruleId}</strong></>}</p>
            </Region>
          </div>
          <Region id="ip:recent" label="Recent events" state={{ count: d.recent.length }} className="tva-card mt-4 overflow-hidden">
            <h2 className="px-4 pt-4 pb-2 text-[13px] font-semibold">Recent events</h2>
            {d.recent.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">None stored.</p>
              : <EventsTable rows={d.recent} cols={cols.filter((c) => c !== 'ip')} rules={rules} onOpen={(r) => navigate(`${base}/events/?ray=${encodeURIComponent(r.ray)}`)} />}
          </Region>
        </>
      )}
    </Region>
  )
}
const Fact = ({ label, v, sub }: { label: string; v: ReactNode; sub?: string }) => (
  <div className="tva-card p-4"><p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{v}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</div>
)
