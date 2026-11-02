'use client'
// Shared analytics pieces: number/time formatting, the URL-backed filter state (?f=country:CN;-decision:block,
// ?range=24h or ?from=…&to=…), the filter bar, the range bar, top-N lists, the world map and the challenge funnel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Empty, Icon, PlainForm, Region, cx } from '../ui.js'
import { useShield } from './ctx.js'
import { BOT_CATEGORIES } from './fields.js'
import { FILTER_FIELDS, type Filter, type FilterField, type Range, type TopRow } from './types.js'
import { WORLD, WORLD_VIEWBOX } from './world.js'

// ---- formatting ----------------------------------------------------------------------------------------------------
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
export const num = (n: number | undefined | null) => (n === undefined || n === null || !Number.isFinite(n) ? '—' : Math.abs(n) < 1000 ? String(Math.round(n * 10) / 10) : compact.format(n))
export const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—')
export const flag = (cc?: string) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🏳')
let regions: Intl.DisplayNames | undefined
export function countryName(cc?: string): string {
  if (!cc) return 'Unknown'
  if (WORLD[cc]) return WORLD[cc]![0]
  try { regions ??= new Intl.DisplayNames(undefined, { type: 'region' }); return regions.of(cc) ?? cc } catch { return cc }
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
export function ago(ts: string, now = Date.now()): string {
  const s = Math.round((Date.parse(ts) - now) / 1000), a = Math.abs(s)
  if (!Number.isFinite(s)) return ts
  if (a < 45) return 'just now'
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86_400), 'day')
}
export const Ago = ({ ts }: { ts?: string }) => (ts ? <time dateTime={ts} title={new Date(ts).toLocaleString()} className="whitespace-nowrap">{ago(ts)}</time> : <>—</>)
export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)

// ---- filters in the URL ---------------------------------------------------------------------------------------------
export const FIELD_LABEL: Record<FilterField, string> = {
  decision: 'Decision', country: 'Country', asn: 'ASN', botCategory: 'Bot category', botName: 'Bot', path: 'Path', method: 'Method', ip: 'IP',
  ipNet: 'IP network', ruleId: 'Rule', uaFamily: 'User agent', status: 'Status', mode: 'Mode', tlsJa4: 'JA4', host: 'Host',
}
export const FIELD_CHOICES: Partial<Record<FilterField, string[]>> = {
  decision: ['pass', 'allow', 'log', 'challenge', 'block', 'rateLimit'], method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  botCategory: BOT_CATEGORIES.map((c) => c.value).concat('browser', 'unknown'), mode: ['log', 'enforce'],
}
// "country:CN;-decision:block" ⇄ [{country eq CN}, {decision neq block}] — values are URI-encoded, so ; and : are safe
export function parseFilters(s?: string): Filter[] {
  if (!s) return []
  return s.split(';').flatMap((part) => {
    const neg = part.startsWith('-'), i = part.indexOf(':')
    const field = part.slice(neg ? 1 : 0, i) as FilterField
    if (i < 0 || !FILTER_FIELDS.includes(field)) return []
    let value: string
    try { value = decodeURIComponent(part.slice(i + 1)) } catch { return [] }
    return [{ field, op: neg ? 'neq' : 'eq', value } satisfies Filter]
  })
}
export const encodeFilters = (f: Filter[]) => f.map((x) => `${x.op === 'neq' ? '-' : ''}${x.field}:${encodeURIComponent(x.value)}`).join(';')
const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
export const RANGES = Object.keys(RANGE_MS) as Range[]

// the filter + time state of the current page, backed by the query string
export function useFilters() {
  const { query, setQuery } = useShield()
  const filters = useMemo(() => parseFilters(query.f), [query.f])
  const range: Range = (RANGES as string[]).includes(query.range ?? '') ? (query.range as Range) : '24h'
  const custom = query.from ? { from: query.from, ...(query.to && { to: query.to }) } : undefined
  // events take from/to only: a preset becomes "since now − range", fixed until the range changes
  const window = useMemo(() => custom ?? { from: new Date(Date.now() - RANGE_MS[range]).toISOString() }, [range, query.from, query.to])   // eslint-disable-line react-hooks/exhaustive-deps
  const put = (q: Record<string, string | undefined>) => setQuery(Object.fromEntries(Object.entries({ ...query, page: '', ...q }).filter(([, v]) => v)) as Record<string, string>)
  const setFilters = (f: Filter[]) => put({ f: encodeFilters(f) })
  return {
    filters, range, custom, window,
    // extra: other query keys to change in the same navigation (e.g. close the drawer)
    add: (f: Filter, extra: Record<string, string> = {}) => put({ f: encodeFilters([...filters.filter((x) => !(x.field === f.field && x.value === f.value)), f]), ...extra }),
    remove: (i: number) => setFilters(filters.filter((_, j) => j !== i)),
    clear: () => setFilters([]),
    setRange: (r: Range) => put({ range: r, from: '', to: '' }),
    setWindow: (from: string, to?: string) => put({ from, to }),
  }
}
export type FilterState = ReturnType<typeof useFilters>

export function valueLabel(f: Pick<Filter, 'field' | 'value'>): string {
  if (f.field === 'country') return `${flag(f.value)} ${f.value}`
  if (f.field === 'asn') return `AS${f.value.replace(/^AS/i, '')}`
  if (f.field === 'botCategory') return BOT_CATEGORIES.find((c) => c.value === f.value)?.label ?? f.value
  return f.value
}

// chips + "Add filter" popover
export function FilterBar({ s, children }: { s: FilterState; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<FilterField>('country'), [op, setOp] = useState<Filter['op']>('eq'), [value, setValue] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  const apply = () => { if (!value.trim()) return; s.add({ field, op, value: value.trim() }); setValue(''); setOpen(false) }
  const choices = FIELD_CHOICES[field]
  return (
    <Region id="shield:filters" label="Filters" state={{ count: s.filters.length, filters: encodeFilters(s.filters) }} className="flex flex-wrap items-center gap-1.5">
      {s.filters.map((f, i) => (
        <span key={`${f.field}${f.op}${f.value}`} className="tvs-chip" data-neg={f.op === 'neq' || undefined}>
          <span className="text-muted">{FIELD_LABEL[f.field]}</span><span className="font-semibold">{f.op === 'eq' ? 'equals' : 'not'}</span>
          <span className="max-w-48 truncate font-mono" title={f.value}>{valueLabel(f)}</span>
          <button type="button" agentId={`remove-${f.field}-${slug(f.value)}`} aria-label={`Remove filter ${FIELD_LABEL[f.field]} ${f.op} ${f.value}`} onClick={() => s.remove(i)}><Icon name="x" size={12} /></button>
        </span>
      ))}
      <div ref={box} className="relative">
        <button type="button" agentId="add-filter" aria-expanded={open} className="tva-btn tva-btn-ghost h-7 border border-dashed border-line px-2 text-xs" onClick={() => setOpen((o) => !o)}><Icon name="plus" size={12} />Add filter</button>
        {open && (
          <div role="dialog" aria-label="Add filter" className="tvs-pop">
            <PlainForm className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); apply() }}>
              <label className="flex flex-col gap-1 text-xs font-medium">Field
                <select agentId="filter-field" className="tva-input h-8" value={field} onChange={(e) => { setField(e.target.value as FilterField); setValue('') }}>
                  {FILTER_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">Operator
                <select agentId="filter-op" className="tva-input h-8" value={op} onChange={(e) => setOp(e.target.value as Filter['op'])}><option value="eq">equals</option><option value="neq">does not equal</option></select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">Value
                {choices ? (
                  <select agentId="filter-value" className="tva-input h-8" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick…</option>{choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                ) : <input agentId="filter-value" autoFocus className="tva-input h-8 font-mono" value={value} placeholder={{ country: 'CN', asn: '16509', path: '/wp-login.php', ip: '203.0.113.7', ipNet: '203.0.113.0/24' }[field as string] ?? ''} onChange={(e) => setValue(e.target.value)} />}
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" agentId="filter-cancel" className="tva-btn h-8" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" agentId="filter-apply" className="tva-btn tva-btn-primary h-8" disabled={!value.trim()}>Apply</button>
              </div>
            </PlainForm>
          </div>
        )}
      </div>
      {s.filters.length > 1 && <button type="button" agentId="clear-filters" className="tva-btn tva-btn-ghost h-7 px-2 text-xs" onClick={s.clear}>Clear all</button>}
      {children}
    </Region>
  )
}

// a datetime-local value ⇄ ISO
const local = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(+d) ? '' : new Date(+d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
// sticky page header: title, range segmented control, custom from/to, extra actions
export function RangeBar({ title, sub, s, children }: { title: string; sub?: ReactNode; s: FilterState; children?: ReactNode }) {
  const [customOpen, setCustomOpen] = useState(!!s.custom)
  const [from, setFrom] = useState(local(s.custom?.from)), [to, setTo] = useState(local(s.custom?.to))
  useEffect(() => { setFrom(local(s.custom?.from)); setTo(local(s.custom?.to)); if (s.custom) setCustomOpen(true) }, [s.custom?.from, s.custom?.to])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tvs-sticky">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {sub && <p className="text-[13px] text-muted">{sub}</p>}
        </div>
        {children}
        <div className="tva-seg" role="group" aria-label="Time range">
          {RANGES.map((r) => <button key={r} type="button" agentId={`range-${r}`} aria-pressed={!s.custom && s.range === r} onClick={() => { setCustomOpen(false); s.setRange(r) }}>{r}</button>)}
          <button type="button" agentId="range-custom" className="inline-flex items-center" aria-pressed={!!s.custom || customOpen} onClick={() => setCustomOpen((o) => !o)}><Icon name="clock" size={13} /><span className="sr-only sm:not-sr-only sm:ml-1">Custom</span></button>
        </div>
      </div>
      {customOpen && (
        <PlainForm className="mt-2 flex flex-wrap items-end gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); if (from) s.setWindow(new Date(from).toISOString(), to ? new Date(to).toISOString() : undefined) }}>
          <label className="flex flex-col gap-1 font-medium">From<input type="datetime-local" agentId="from" className="tva-input h-8" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex flex-col gap-1 font-medium">To<input type="datetime-local" agentId="to" className="tva-input h-8" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="submit" agentId="apply-range" className="tva-btn tva-btn-primary h-8" disabled={!from}>Apply</button>
          {s.custom && <button type="button" agentId="reset-range" className="tva-btn tva-btn-ghost h-8" onClick={() => { setCustomOpen(false); s.setRange(s.range) }}>Back to {s.range}</button>}
        </PlainForm>
      )}
    </div>
  )
}

// ---- top-N list ------------------------------------------------------------------------------------------------------
export function TopList({ id, title, field, rows, render, onFilter, onOpen }: {
  id: string; title: string; field: FilterField; rows?: TopRow[]; render?(r: TopRow): ReactNode
  onFilter(f: Filter): void; onOpen?(r: TopRow): void
}) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count))
  return (
    <Region id={`top:${id}`} label={title} state={{ count: rows?.length ?? 0, rows: (rows ?? []).slice(0, 10).map((r) => `${r.key} | ${r.count} | ${pct(r.mitigated, r.count)} mitigated`).join('\n') }} className="tva-card flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2"><h3 className="flex-1 truncate text-[13px] font-semibold">{title}</h3><span className="text-[11px] text-muted">Requests · mitigated</span></div>
      {!rows ? <div className="space-y-2 px-4 pb-4" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="tva-skel h-6" />)}</div>
        : rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No data in this view.</p>
        : (
          <ol className="pb-2">
            {rows.slice(0, 10).map((r) => (
              <li key={r.key} className="tvs-top">
                <span className="tvs-top-bar" style={{ width: `${(r.count / max) * 100}%` }}><span style={{ width: `${r.count ? (r.mitigated / r.count) * 100 : 0}%` }} /></span>
                {onOpen ? <button type="button" agentId={`open-${slug(r.key)}`} className="relative min-w-0 flex-1 truncate text-left hover:underline" title={r.label ?? r.key} onClick={() => onOpen(r)}>{render ? render(r) : r.label ?? r.key}</button>
                  : <span className="relative min-w-0 flex-1 truncate" title={r.label ?? r.key}>{render ? render(r) : r.label ?? r.key}</span>}
                <span className="tvs-top-act">
                  <button type="button" agentId={`for-${slug(r.key)}`} title="Filter for" aria-label={`Filter for ${r.key}`} onClick={() => onFilter({ field, op: 'eq', value: r.key })}><Icon name="search" size={12} /></button>
                  <button type="button" agentId={`out-${slug(r.key)}`} title="Exclude" aria-label={`Exclude ${r.key}`} onClick={() => onFilter({ field, op: 'neq', value: r.key })}><Icon name="eyeOff" size={12} /></button>
                </span>
                <span className="relative w-12 text-right tabular-nums font-medium">{num(r.count)}</span>
                <span className="relative w-12 text-right text-xs tabular-nums text-muted" title={`${r.mitigated.toLocaleString()} mitigated`}>{pct(r.mitigated, r.count)}</span>
              </li>
            ))}
          </ol>
        )}
    </Region>
  )
}

// ---- world map ------------------------------------------------------------------------------------------------------
export type GeoRow = { country: string; requests: number; mitigated: number }
export function WorldMap({ geo, onPick }: { geo?: GeoRow[]; onPick(cc: string): void }) {
  const [metric, setMetric] = useState<'requests' | 'mitigated'>('requests')
  const [hi, setHi] = useState<{ cc: string; x: number; y: number } | null>(null)
  const by = new Map((geo ?? []).map((g) => [g.country, g]))
  const max = Math.max(1, ...(geo ?? []).map((g) => g[metric]))
  const off = (geo ?? []).filter((g) => !WORLD[g.country]).sort((a, b) => b[metric] - a[metric])
  const fill = (cc: string) => {
    const v = by.get(cc)?.[metric] ?? 0
    if (!v) return undefined
    return `color-mix(in oklab, var(${metric === 'requests' ? '--tva-c1' : '--tva-c2'}) ${Math.round(18 + 82 * Math.sqrt(v / max))}%, var(--tva-sunken))`
  }
  const h = hi && by.get(hi.cc)
  const top = [...(geo ?? [])].sort((a, b) => b[metric] - a[metric]).slice(0, 5)
  return (
    <Region id="shield:map" label="Traffic by country" state={{ metric, countries: geo?.length ?? 0, top: top.map((g) => `${g.country} ${g[metric]}`).join(', ') }} className="tva-card flex min-w-0 flex-col p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[13px] font-semibold">Traffic by country</h3>
        <div className="tva-seg" role="group" aria-label="Map metric">
          {(['requests', 'mitigated'] as const).map((m) => <button key={m} type="button" agentId={`map-${m}`} aria-pressed={metric === m} className="capitalize" onClick={() => setMetric(m)}>{m}</button>)}
        </div>
      </div>
      {!geo ? <div className="tva-skel aspect-[1000/394] w-full" aria-busy="true" />
        : geo.length === 0 ? <Empty title="No country data" icon="grid">No request in this view had a known country.</Empty>
        : (
          <div className="relative" onPointerLeave={() => setHi(null)}>
            <svg viewBox={WORLD_VIEWBOX} className="tvs-map w-full" role="group" aria-label={`Map of ${metric} by country`} agentId="map"
              onPointerMove={(e) => { const cc = (e.target as Element).getAttribute?.('data-cc'); const r = e.currentTarget.getBoundingClientRect(); setHi(cc ? { cc, x: e.clientX - r.left, y: e.clientY - r.top } : null) }}
              onClick={(e) => { const cc = (e.target as Element).getAttribute?.('data-cc'); if (cc && by.has(cc)) onPick(cc) }}
              onKeyDown={(e) => { const cc = (e.target as Element).getAttribute?.('data-cc'); if (cc && by.has(cc) && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(cc) } }}>
              {Object.entries(WORLD).map(([cc, [name, d]]) => {
                const g = by.get(cc)
                return <path key={cc} d={d} data-cc={cc} fill={fill(cc)} className={cx(g && 'has')} {...(g && { tabIndex: 0, role: 'button', agentId: `country-${cc}`, 'aria-label': `${name}: ${g[metric].toLocaleString()} ${metric}, filter for it` })} />
              })}
            </svg>
            {hi && <div role="status" className="tva-tip" style={{ left: Math.max(0, hi.x - 70), top: hi.y + 14 }}>
              <p className="font-semibold">{flag(hi.cc)} {countryName(hi.cc)}</p>
              {h ? <><p><strong className="tabular-nums">{h.requests.toLocaleString()}</strong> <span className="text-muted">requests</span></p><p><strong className="tabular-nums">{h.mitigated.toLocaleString()}</strong> <span className="text-muted">mitigated ({pct(h.mitigated, h.requests)})</span></p><p className="text-[11px] text-muted">Click to filter</p></> : <p className="text-muted">No requests</p>}
            </div>}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">0<span className="tvs-ramp" data-m={metric} />{num(max)}</span>
              {top.map((g) => <button key={g.country} type="button" agentId={`map-top-${g.country}`} className="hover:text-fg" onClick={() => onPick(g.country)}>{flag(g.country)} {g.country} <strong className="tabular-nums text-fg">{num(g[metric])}</strong></button>)}
            </div>
            {off.length > 0 && <p className="mt-1 text-xs text-muted">Not on the map: {off.slice(0, 8).map((g) => <button key={g.country} type="button" agentId={`map-off-${g.country}`} className="mr-2 hover:text-fg" onClick={() => onPick(g.country)}>{flag(g.country)} {g.country} {num(g[metric])}</button>)}</p>}
          </div>
        )}
    </Region>
  )
}

// ---- challenge funnel -------------------------------------------------------------------------------------------------
export function Funnel({ f }: { f?: { issued: number; solved: number; failed: number; solveMsP50?: number; solveMsP95?: number } }) {
  const rows = f ? [{ k: 'Issued', v: f.issued, t: 'info' }, { k: 'Solved', v: f.solved, t: 'ok' }, { k: 'Failed / abandoned', v: f.failed, t: 'error' }] : []
  const ms = (v?: number) => (v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)
  return (
    <Region id="shield:funnel" label="Challenge funnel" state={{ issued: f?.issued ?? null, solved: f?.solved ?? null, failed: f?.failed ?? null, p50: f?.solveMsP50 ?? null, p95: f?.solveMsP95 ?? null }} className="tva-card flex min-w-0 flex-col p-4">
      <h3 className="mb-1 text-[13px] font-semibold">Challenge funnel</h3>
      <p className="mb-3 text-xs text-muted">How many challenges were shown, solved, or not.</p>
      {!f ? <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="tva-skel h-7" />)}</div>
        : f.issued === 0 ? <p className="text-sm text-muted">No challenges in this view.</p>
        : (
          <>
            <ul className="flex flex-col gap-2">{rows.map((r) => (
              <li key={r.k} className="tvs-funnel" data-t={r.t}>
                <span className="w-32 shrink-0 text-[13px]">{r.k}</span>
                <span className="tvs-funnel-bar"><span style={{ width: `${(r.v / Math.max(1, f.issued)) * 100}%` }} /></span>
                <span className="w-24 shrink-0 text-right text-[13px] tabular-nums"><strong>{num(r.v)}</strong> <span className="text-muted">{pct(r.v, f.issued)}</span></span>
              </li>
            ))}</ul>
            <div className="mt-4 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-md bg-sunken p-2"><p className="text-[11px] text-muted">Solve time p50</p><p className="font-semibold tabular-nums">{ms(f.solveMsP50)}</p></div>
              <div className="rounded-md bg-sunken p-2"><p className="text-[11px] text-muted">Solve time p95</p><p className="font-semibold tabular-nums">{ms(f.solveMsP95)}</p></div>
            </div>
          </>
        )}
    </Region>
  )
}
