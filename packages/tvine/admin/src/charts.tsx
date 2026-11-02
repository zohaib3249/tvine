'use client'
// Our own SVG charts (no chart library): Line, Area, Bar (stacked | grouped), Donut, Sparkline, Stat + a table view.
// Marks follow the dataviz rules: 2px lines, ~10% area wash, bars ≤ 24px with a 4px rounded data end, hairline grid,
// a crosshair + one tooltip for every series at an X, a legend for ≥ 2 series, a table fallback. Colors come from
// --tva-c1…c8 (admin.css: fixed categorical order, light and dark steps). Every chart card is a Weft widget whose
// state is a compact summary, so an agent's read_page sees the numbers without the SVG.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Empty, Icon, Region, cx } from './ui.js'

export type Unit = 'count' | 'money' | 'number' | 'ms' | 'percent'
export type ChartSeries = { name: string; label: string }
export type ChartPoint = { x: string; values: number[] }
export type ChartData = {
  id?: string; title?: string; type?: ChartType; unit?: Unit; currency?: string
  groupBy?: 'hour' | 'day' | 'week' | 'month' | 'category' | 'time'
  series: ChartSeries[]; points: ChartPoint[]; total?: number; previous?: number
}
export type ChartType = 'line' | 'area' | 'bar' | 'stacked' | 'donut' | 'stat' | 'table'
export const isChartData = (v: unknown): v is ChartData => !!v && typeof v === 'object' && Array.isArray((v as ChartData).series) && Array.isArray((v as ChartData).points)

const color = (i: number) => `var(--tva-c${(i % 8) + 1})`
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- numbers + labels ----------------------------------------------------------------------------------------------
const nf = new Map<string, Intl.NumberFormat>()
const numFmt = (o: Intl.NumberFormatOptions) => { const k = JSON.stringify(o); let f = nf.get(k); if (!f) nf.set(k, (f = new Intl.NumberFormat(undefined, o))); return f }
export function fmtValue(v: number, unit: Unit = 'number', currency?: string, compact = false): string {
  if (!Number.isFinite(v)) return '—'
  if (unit === 'money' && currency) return numFmt({ style: 'currency', currency, ...(compact ? (Math.abs(v) >= 10_000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }) : { maximumFractionDigits: 2 }) }).format(v)
  if (unit === 'ms') return `${numFmt({ maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ms`
  if (unit === 'percent') return `${numFmt({ maximumFractionDigits: 1 }).format(v)}%`
  if (compact && Math.abs(v) >= 10_000) return numFmt({ notation: 'compact', maximumFractionDigits: 1 }).format(v)
  return numFmt({ maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v)
}
export function fmtX(x: string, by?: ChartData['groupBy'], long = false): string {
  if (by === 'category' || !/^\d{4}-\d\d-\d\d/.test(x)) return x
  const d = new Date(x)
  if (Number.isNaN(+d)) return x
  if (by === 'hour' || by === 'time') return d.toLocaleString(undefined, long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  if (by === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(long && { year: 'numeric' }), timeZone: 'UTC' })
}
// clean axis ticks: 0 … a round max (1/2/2.5/5 × 10^n steps)
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count, p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!
  const out: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) out.push(+v.toFixed(10))
  return out
}

// width of the card body (ResizeObserver); a fixed fallback where layout does not exist (SSR, jsdom)
function useWidth(fallback = 560): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => { const cw = Math.floor(e!.contentRect.width); if (cw > 0) setW(cw) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// a bar rect with a 4px rounded data end, square at the baseline (r shrinks for short bars)
function barPath(x: number, y: number, w: number, h: number, round = true): string {
  if (h <= 0) return ''
  const r = round ? Math.min(4, w / 2, h) : 0
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const left = x > w * 0.6
  return <div role="status" className="tva-tip" style={left ? { right: w - x + 10 } : { left: x + 10 }}>{children}</div>
}
function TipRows({ d, i }: { d: ChartData; i: number }) {
  const p = d.points[i]!
  return (
    <>
      <p className="tva-tip-x">{fmtX(p.x, d.groupBy, true)}</p>
      {d.series.map((s, k) => (
        <p key={s.name} className="flex items-center gap-2">
          <span className="tva-key-line" style={{ background: color(k) }} />
          <strong className="tabular-nums">{fmtValue(p.values[k] ?? 0, d.unit, d.currency)}</strong>
          <span className="text-muted">{s.label}</span>
        </p>
      ))}
    </>
  )
}

export function Legend({ d, kind = 'line' }: { d: ChartData; kind?: 'line' | 'rect' }) {
  if (d.series.length < 2) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {d.series.map((s, k) => <li key={s.name} className="flex items-center gap-1.5"><span className={kind === 'line' ? 'tva-key-line' : 'tva-key-rect'} style={{ background: color(k) }} />{s.label}</li>)}
    </ul>
  )
}

// ---- line / area / bar: one XY frame ------------------------------------------------------------------------------
// onBrush: drag across the plot to pick a span of points (inclusive indices), e.g. zoom a time range
export function XYChart({ d, kind, stacked = false, height = 220, onBrush }: { d: ChartData; kind: 'line' | 'area' | 'bar'; stacked?: boolean; height?: number; onBrush?(from: number, to: number): void }) {
  const [ref, W] = useWidth()
  const [hi, setHi] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const n = d.points.length
  const compact = W < 420
  // a multi-series area stacks (parts of a whole over time); lines never stack
  const stackArea = kind === 'area' && d.series.length > 1
  const cum = (i: number, k: number) => (stackArea ? d.points[i]!.values.slice(0, k + 1).reduce((a, b) => a + Math.max(0, b), 0) : d.points[i]!.values[k] ?? 0)
  const tops = d.points.map((p) => (stacked || stackArea ? p.values.reduce((a, b) => a + Math.max(0, b), 0) : Math.max(0, ...p.values)))
  const ticks = niceTicks(Math.max(0, ...tops), height < 160 ? 2 : 4)
  const tickUnit = d.unit === 'ms' ? 'number' : d.unit
  const tickText = (t: number) => fmtValue(t, tickUnit, d.currency, true)
  const padL = 12 + 6.4 * Math.max(...ticks.map((t) => tickText(t).length)), padR = 12, padT = 10, padB = 24
  const iw = Math.max(10, W - padL - padR), ih = height - padT - padB
  const top = ticks[ticks.length - 1]!
  const y = (v: number) => padT + ih - (v / top) * ih
  const band = iw / Math.max(1, n)
  const x = (i: number) => (kind === 'bar' ? padL + band * (i + 0.5) : padL + (n <= 1 ? iw / 2 : (i * iw) / (n - 1)))
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / (compact ? 70 : 90)))))
  const idx = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect(), px = ((clientX - r.left) / (r.width || W)) * W
    const i = kind === 'bar' ? Math.floor((px - padL) / band) : Math.round(((px - padL) / iw) * (n - 1))
    return Math.max(0, Math.min(n - 1, i))
  }
  const pick = (clientX: number, el: SVGSVGElement) => { const i = idx(clientX, el); setHi(i); if (drag) setDrag({ ...drag, b: i }) }
  const down = (e: React.PointerEvent<SVGSVGElement>) => { if (!onBrush || e.button !== 0) return; const i = idx(e.clientX, e.currentTarget); setDrag({ a: i, b: i }); e.currentTarget.setPointerCapture?.(e.pointerId) }
  const up = () => { if (drag && drag.a !== drag.b) onBrush?.(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)); setDrag(null) }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setHi((h) => Math.max(0, Math.min(n - 1, (h ?? (e.key === 'ArrowRight' ? -1 : n)) + (e.key === 'ArrowRight' ? 1 : -1)))) }
    if (e.key === 'Escape') setHi(null)
  }
  if (!n) return <div ref={ref}><Empty title="No data in this range" icon="grid" /></div>
  const line = (k: number) => d.points.map((_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(cum(i, k)).toFixed(1)}`).join('')
  const under = (k: number) => (stackArea && k > 0 ? d.points.map((_, j) => n - 1 - j).map((i) => `L${x(i).toFixed(1)},${y(cum(i, k - 1)).toFixed(1)}`).join('') : `L${x(n - 1)},${y(0)}L${x(0)},${y(0)}`)
  const sub = d.series.length
  const gap = band > 10 ? 4 : 1   // dense series: keep a hairline of air, never a negative width
  const gw = Math.max(1, stacked ? Math.min(24, band - gap) : Math.min(24, (band - gap) / sub - (band > 10 ? 2 : 0)))
  return (
    <div ref={ref} className="relative">
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} role="img" tabIndex={0} className="tva-plot"
        aria-label={`${d.title ?? 'Chart'}: ${n} points, use arrow keys to read values`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)} onPointerLeave={() => setHi(null)} onKeyDown={key} onBlur={() => setHi(null)}
        onPointerDown={down} onPointerUp={up} onPointerCancel={() => setDrag(null)} style={onBrush ? { cursor: 'crosshair', touchAction: 'pan-y' } : undefined}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'tva-axis' : 'tva-grid'} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="tva-tick">{tickText(t)}</text>
          </g>
        ))}
        {d.points.map((p, i) => i % every === 0 && <text key={p.x} x={x(i)} y={height - 6} textAnchor="middle" className="tva-tick">{fmtX(p.x, d.groupBy)}</text>)}
        {kind === 'bar' && hi !== null && <rect x={padL + band * hi} y={padT} width={band} height={ih} className="tva-band" />}
        {kind === 'bar' ? d.points.map((p, i) => {
          let acc = 0
          return (
            <g key={p.x} className={cx('tva-bars', hi === i && 'is-hi')}>
              {d.series.map((s, k) => {
                const v = Math.max(0, p.values[k] ?? 0)
                if (stacked) {
                  const y0 = y(acc), y1 = y(acc + v); acc += v
                  const isTop = d.series.slice(k + 1).every((_, j) => !(p.values[k + 1 + j]! > 0))
                  return <path key={s.name} d={barPath(x(i) - gw / 2, y1, gw, Math.max(0, y0 - y1 - (k ? 2 : 0)), isTop)} fill={color(k)} />
                }
                const bx = x(i) - (sub * (gw + 2) - 2) / 2 + k * (gw + 2)
                return <path key={s.name} d={barPath(bx, y(v), gw, y(0) - y(v))} fill={color(k)} />
              })}
            </g>
          )
        }) : d.series.map((s, k) => (
          <g key={s.name}>
            {kind === 'area' && <path d={`${line(k)}${under(k)}Z`} fill={color(k)} className={stackArea ? 'tva-area tva-area-stack' : 'tva-area'} />}
            <path d={line(k)} fill="none" stroke={color(k)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="tva-line" />
            {n === 1 && <circle cx={x(0)} cy={y(cum(0, k))} r={4} fill={color(k)} />}
          </g>
        ))}
        {drag && drag.a !== drag.b && <rect x={Math.min(x(drag.a), x(drag.b))} y={padT} width={Math.abs(x(drag.b) - x(drag.a))} height={ih} className="tva-brush" />}
        {kind !== 'bar' && hi !== null && (
          <g>
            <line x1={x(hi)} x2={x(hi)} y1={padT} y2={padT + ih} className="tva-cross" />
            {d.series.map((s, k) => <circle key={s.name} cx={x(hi)} cy={y(cum(hi, k))} r={4} fill={color(k)} className="tva-dot" />)}
          </g>
        )}
      </svg>
      {hi !== null && <Tip x={x(hi)} w={W}><TipRows d={d} i={hi} /></Tip>}
      <Legend d={d} kind={kind === 'line' ? 'line' : 'rect'} />
    </div>
  )
}

// ---- donut: one series over categories (≤ 7 slices + "Other") ----------------------------------------------------
// colors: a fixed color per category label (e.g. one per decision), else the categorical order by size
export function DonutChart({ d, size = 168, colors }: { d: ChartData; size?: number; colors?: Record<string, string> }) {
  const [hi, setHi] = useState<number | null>(null)
  let rows = d.points.map((p) => ({ label: p.x, v: Math.max(0, p.values[0] ?? 0) })).sort((a, b) => b.v - a.v)
  if (rows.length > 8) rows = [...rows.slice(0, 7), { label: 'Other', v: rows.slice(7).reduce((a, r) => a + r.v, 0) }]
  const total = rows.reduce((a, r) => a + r.v, 0)
  if (!total) return <Empty title="No data in this range" icon="grid" />
  const R = size / 2, r0 = R * 0.62
  let a0 = -Math.PI / 2
  const arcs = rows.map((r) => {
    const a = (r.v / total) * Math.PI * 2, a1 = a0 + a
    const gap = rows.length > 1 ? Math.min(0.02, a / 4) : 0
    const s = a0 + gap, e = a1 - gap, big = e - s > Math.PI ? 1 : 0
    const pt = (rad: number, ang: number) => `${(R + rad * Math.cos(ang)).toFixed(2)},${(R + rad * Math.sin(ang)).toFixed(2)}`
    const path = rows.length === 1
      ? `M${R},${R - R}A${R},${R} 0 1 1 ${R - 0.01},0ZM${R},${R - r0}A${r0},${r0} 0 1 0 ${R + 0.01},${R - r0}Z`
      : `M${pt(R, s)}A${R},${R} 0 ${big} 1 ${pt(R, e)}L${pt(r0, e)}A${r0},${r0} 0 ${big} 0 ${pt(r0, s)}Z`
    a0 = a1
    return path
  })
  const shown = hi ?? null
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${d.title ?? 'Breakdown'}: ${rows.length} parts`} className="tva-donut">
          {arcs.map((p, i) => <path key={i} d={p} fill={colors?.[rows[i]!.label] ?? color(i)} fillRule="evenodd" tabIndex={0} aria-label={`${rows[i]!.label}: ${fmtValue(rows[i]!.v, d.unit, d.currency)}`}
            className={cx('tva-slice', shown === i && 'is-hi')} onPointerEnter={() => setHi(i)} onPointerLeave={() => setHi(null)} onFocus={() => setHi(i)} onBlur={() => setHi(null)} />)}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-lg font-semibold">{fmtValue(shown === null ? total : rows[shown]!.v, d.unit, d.currency, true)}</p>
            <p className="max-w-24 truncate text-xs text-muted">{shown === null ? 'Total' : `${rows[shown]!.label} · ${Math.round((rows[shown]!.v / total) * 100)}%`}</p>
          </div>
        </div>
      </div>
      <ul className="min-w-36 flex-1 space-y-1 text-[13px]" aria-label="Legend">
        {rows.map((r, i) => (
          <li key={r.label} className={cx('flex items-center gap-2 rounded px-1', shown === i && 'bg-sunken')} onPointerEnter={() => setHi(i)} onPointerLeave={() => setHi(null)}>
            <span className="tva-key-rect" style={{ background: colors?.[r.label] ?? color(i) }} /><span className="flex-1 truncate">{r.label}</span>
            <span className="tabular-nums text-muted">{Math.round((r.v / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- a stats table: optional per-row trend sparkline and first-cell link (Top searches / Most visited pages) ------------
export type StatTable = { columns: string[]; rows: (string | number | null)[][]; trend?: number[][]; links?: (string | null)[] }
// the table as flat region state, so agents read it in read_page: one 'a | b | c' line per row
export const tableState = (t: StatTable | undefined, n = 25) => ({ count: t?.rows.length ?? 0, columns: t?.columns.join(' | ') ?? '', rows: (t?.rows ?? []).slice(0, n).map((r) => r.map((c) => c ?? '—').join(' | ')).join('\n') })
export function DataTable({ t, mono = [] }: { t: StatTable; mono?: string[] }) {
  return (
    <table className="w-full text-[13px]">
      <thead><tr>{t.columns.map((c) => <th key={c} className="tva-th">{c}</th>)}{t.trend && <th className="tva-th">Trend</th>}</tr></thead>
      <tbody>{t.rows.map((r, i) => (
        <tr key={i} className="tva-row">{r.map((c, j) => {
          const text = c === null ? '—' : typeof c === 'number' ? c.toLocaleString(undefined, { maximumFractionDigits: 2 }) : c
          const href = j === 0 ? t.links?.[i] : undefined
          return <td key={j} title={typeof c === 'string' && c.length > 40 ? c : undefined} className={cx('tva-td', typeof c === 'number' && 'text-right', mono.includes(t.columns[j]!) && 'max-w-[28rem] truncate font-mono text-xs')}>
            {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{text}</a> : text}</td>
        })}{t.trend && <td className="tva-td py-0.5">{t.trend[i] && <Sparkline values={t.trend[i]!} width={88} height={22} label={`${r[0]} trend`} />}</td>}</tr>
      ))}</tbody>
    </table>
  )
}

// ---- sparkline + stat ---------------------------------------------------------------------------------------------
export function Sparkline({ values, width = 120, height = 32, label = 'Trend' }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values), min = Math.min(0, ...values), span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const)
  const dPath = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
  const [lx, ly] = pts[pts.length - 1]!
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${values.length} points, last ${fmtValue(values[values.length - 1]!)}`} className="tva-spark">
      <path d={`${dPath}L${lx},${height}L2,${height}Z`} className="tva-spark-area" />
      <path d={dPath} fill="none" strokeWidth={1.5} strokeLinejoin="round" pathLength={1} className="tva-line tva-spark-line" />
      <circle cx={lx} cy={ly} r={3} className="tva-spark-dot" />
    </svg>
  )
}

export function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(target)
  const from = useRef(0)
  useEffect(() => {
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') { setV(target); from.current = target; return }
    const start = performance.now(), a = from.current
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms), e = 1 - (1 - t) ** 3
      setV(a + (target - a) * e)
      if (t < 1) raf = requestAnimationFrame(step); else from.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

export type StatData = { value: number; previous?: number; unit?: Unit; currency?: string; spark?: number[]; upIsGood?: boolean }
export function statOf(v: unknown): StatData | undefined {
  if (isChartData(v)) {
    const spark = v.points.map((p) => p.values[0] ?? 0)
    return { value: v.total ?? spark.reduce((a, b) => a + b, 0), previous: v.previous, unit: v.unit, currency: v.currency, spark }
  }
  if (v && typeof v === 'object' && typeof (v as StatData).value === 'number') return v as StatData
  if (typeof v === 'number') return { value: v }
  return undefined
}
export function Stat({ s, label }: { s: StatData; label?: string }) {
  const shown = useCountUp(s.value)
  const delta = s.previous !== undefined && s.previous !== 0 ? ((s.value - s.previous) / Math.abs(s.previous)) * 100 : undefined
  const good = delta === undefined ? undefined : (delta >= 0) === (s.upIsGood ?? true)
  const exact = Number.isInteger(s.value) ? Math.round(shown) : shown
  return (
    <div className="min-w-0">
      <div className="flex items-end justify-between gap-3">
        <p className="tva-stat-value min-w-0 truncate" aria-label={`${label ?? 'Value'}: ${fmtValue(s.value, s.unit, s.currency)}`}>{fmtValue(exact, s.unit, s.currency, true)}</p>
        {s.spark && s.spark.length > 1 && <Sparkline values={s.spark} width={96} label={label} />}
      </div>
      {delta !== undefined && (
        <p className={cx('tva-delta whitespace-nowrap', good ? 'is-good' : 'is-bad')}>
          <Icon name={delta >= 0 ? 'up' : 'down'} size={12} />
          <span>{delta >= 0 ? '+' : ''}{fmtValue(Math.round(delta * 10) / 10, 'percent')}</span>
          <span className="font-normal text-muted">vs prev. period</span>
        </p>
      )}
      {delta === undefined && s.previous === 0 && s.value > 0 && <p className="tva-delta is-good"><Icon name="up" size={12} /><span>new</span><span className="font-normal text-muted">vs prev. period</span></p>}
    </div>
  )
}

// ---- table fallback -----------------------------------------------------------------------------------------------
export function ChartTable({ d }: { d: ChartData }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-line">
      <table className="w-full text-[13px]">
        <thead><tr><th className="tva-th">{d.groupBy === 'category' ? 'Category' : 'Period'}</th>{d.series.map((s) => <th key={s.name} className="tva-th text-right">{s.label}</th>)}</tr></thead>
        <tbody>{d.points.map((p) => <tr key={p.x}><td className="tva-td">{fmtX(p.x, d.groupBy, true)}</td>{d.series.map((s, k) => <td key={s.name} className="tva-td text-right">{fmtValue(p.values[k] ?? 0, d.unit, d.currency)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

// compact numbers an agent reads in read_page (state values are primitives)
export function summary(d: ChartData, type: string): Record<string, string | number | boolean | null> {
  const first = d.points.map((p) => p.values[0] ?? 0)
  const total = d.total ?? first.reduce((a, b) => a + b, 0)
  return {
    type, series: d.series.map((s) => s.label).join(', ').slice(0, 200), n: d.points.length, total: +total.toFixed(2),
    last: first.length ? +first[first.length - 1]!.toFixed(2) : null, max: first.length ? Math.max(...first) : null, min: first.length ? Math.min(...first) : null,
    ...(d.points.length && { from: d.points[0]!.x.slice(0, 20), to: d.points[d.points.length - 1]!.x.slice(0, 20) }),
    ...(d.previous !== undefined && { previous: d.previous }), ...(d.unit && { unit: d.unit }),
  }
}

// One chart by type (no card chrome)
export function Chart({ d, type, height }: { d: ChartData; type: ChartType; height?: number }) {
  if (type === 'donut') return <DonutChart d={d} size={height && height < 168 ? Math.max(110, height - 20) : 168} />
  if (type === 'stat') { const s = statOf(d); return s ? <Stat s={s} label={d.title} /> : null }
  if (type === 'table') return <ChartTable d={d} />
  if (type === 'stacked') return <XYChart d={d} kind="bar" stacked height={height} />
  return <XYChart d={d} kind={type} height={height} />
}

// A card: title, Table toggle, the chart; loading = skeleton, refetch = previous frame dimmed, errors + empty states.
export function ChartCard({ id, title, type, data, loading, error, height, actions, className, subtitle }: {
  id: string; title: string; type: ChartType; data?: ChartData; loading?: boolean; error?: string; height?: number
  actions?: ReactNode; className?: string; subtitle?: string
}) {
  const [table, setTable] = useState(false)
  const st = data ? summary(data, type) : { type, n: 0, loading: !!loading, error: error ?? null }
  return (
    <Region id={`chart:${id}`} label={title} state={st} className={cx('tva-card tva-chart-card flex min-w-0 flex-col p-4', className)}>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-muted">{title}</h3>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {actions}
        {data && type !== 'stat' && type !== 'table' && (
          <button type="button" agentId="table" aria-pressed={table} className="tva-btn tva-btn-ghost h-7 px-2 text-xs" onClick={() => setTable((t) => !t)} title={table ? 'Show chart' : 'Show table'}>
            <Icon name={table ? 'chart' : 'table'} size={14} /><span className="sr-only sm:not-sr-only">{table ? 'Chart' : 'Table'}</span>
          </button>
        )}
      </div>
      <div className={cx('min-h-0 flex-1 transition-opacity', loading && data && 'opacity-60')}>
        {error && !data ? <p role="alert" className="flex items-center gap-2 text-sm text-danger"><Icon name="alert" size={14} />{error}</p>
          : !data ? <ChartSkeleton type={type} height={height} />
          : table ? <ChartTable d={data} /> : <Chart d={data} type={type} height={height} />}
      </div>
    </Region>
  )
}

export function ChartSkeleton({ type, height = 220 }: { type: ChartType; height?: number }) {
  if (type === 'stat') return <div aria-busy="true" aria-label="Loading"><div className="tva-skel mb-2 h-8 w-28" /><div className="tva-skel h-4 w-40" /></div>
  if (type === 'donut') return <div aria-busy="true" aria-label="Loading" className="flex items-center gap-5"><div className="tva-skel size-40 rounded-full" /><div className="flex-1 space-y-2"><div className="tva-skel h-4" /><div className="tva-skel h-4 w-2/3" /></div></div>
  return <div aria-busy="true" aria-label="Loading" className="flex items-end gap-1.5" style={{ height }}>{Array.from({ length: 14 }, (_, i) => <div key={i} className="tva-skel flex-1" style={{ height: `${25 + ((i * 37) % 65)}%` }} />)}</div>
}
