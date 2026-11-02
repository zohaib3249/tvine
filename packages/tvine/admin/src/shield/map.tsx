'use client'
// Traffic by country: an orthographic 3D globe (drag / wheel / pinch / keys, inertia, idle auto-rotate) or a flat
// equirectangular map, both from the lon/lat rings in world.ts. Pure SVG: the globe paths are rebuilt per frame
// (at most once per requestAnimationFrame), clipped to the visible hemisphere along the horizon circle.
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as PE } from 'react'
import { Empty, Icon, Region, cx } from '../ui.js'
import { countryName, flag, num, pct } from './kit.js'
import { WORLD } from './world.js'

export type GeoRow = { country: string; requests: number; mitigated: number; continent?: string }
type View = { lon: number; lat: number; zoom: number }
const HOME: View = { lon: 10, lat: 20, zoom: 1 }
const GW = 800, GH = 440, R0 = 200          // globe viewBox; sphere radius at zoom 1
const FW = 1000, FH = 394                   // flat viewBox: lon -180…180, lat 84…-58
const RAD = Math.PI / 180, KEY = 'tvs:map-view', STEP = 15
const r1 = (n: number) => Math.round(n * 10) / 10
const fx = (lon: number) => r1(((lon + 180) * FW) / 360), fy = (lat: number) => r1(((84 - lat) * FW) / 360)
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
const clampV = (v: View): View => ({ lon: wrap(v.lon), lat: Math.max(-85, Math.min(85, v.lat)), zoom: Math.max(1, Math.min(4, v.zoom)) })

// decoded once: rings as unit vectors (x, y, z interleaved) for the globe, an equirectangular path for the flat map
type Shape = { cc: string; name: string; c: [number, number]; rings: Float32Array[]; flat: string }
let shapes: Shape[] | undefined
const unit = (lon: number, lat: number, out: Float32Array, j: number) => {
  const l = lon * RAD, p = lat * RAD
  out[j] = Math.cos(p) * Math.cos(l); out[j + 1] = Math.cos(p) * Math.sin(l); out[j + 2] = Math.sin(p)
}
function decode(): Shape[] {
  return (shapes ??= Object.entries(WORLD).map(([cc, [name, c, enc]]) => {
    const rings: Float32Array[] = []
    let flat = ''
    for (const ring of enc.split('|')) {
      const n = ring.split(' ').map(Number), v = new Float32Array((n.length / 2) * 3)
      let lon = 0, lat = 0
      for (let i = 0; i < n.length; i += 2) {
        lon += n[i]!; lat += n[i + 1]!
        unit(lon / 10, lat / 10, v, (i / 2) * 3)
        flat += `${i ? 'L' : 'M'}${fx(lon / 10)} ${fy(lat / 10)}`
      }
      rings.push(v); flat += 'z'
    }
    return { cc, name, c, rings, flat }
  }))
}
// graticule every 30°, sampled every 5°
let grat: Float32Array[] | undefined
const graticule = () => (grat ??= [
  ...Array.from({ length: 12 }, (_, k) => { const v = new Float32Array(33 * 3); for (let i = 0; i <= 32; i++) unit(-180 + k * 30, -80 + i * 5, v, i * 3); return v }),
  ...[-60, -30, 0, 30, 60].map((lat) => { const v = new Float32Array(73 * 3); for (let i = 0; i <= 72; i++) unit(-180 + i * 5, lat, v, i * 3); return v }),
])

// orthographic projection centred on (lon, lat): unit vector → x right, y up, z towards the viewer (z > 0 = visible)
type Proj = { cl: number; sl: number; cp: number; sp: number; r: number }
const projOf = (v: View): Proj => ({ cl: Math.cos(v.lon * RAD), sl: Math.sin(v.lon * RAD), cp: Math.cos(v.lat * RAD), sp: Math.sin(v.lat * RAD), r: R0 * v.zoom })
const P3 = new Float64Array(3)
function project(P: Proj, a: Float32Array, j: number) {
  const X = a[j]!, Y = a[j + 1]!, Z = a[j + 2]!, x1 = X * P.cl + Y * P.sl
  P3[0] = -X * P.sl + Y * P.cl; P3[1] = Z * P.cp - x1 * P.sp; P3[2] = x1 * P.cp + Z * P.sp
}
const sx = (P: Proj, x: number) => r1(GW / 2 + P.r * x), sy = (P: Proj, y: number) => r1(GH / 2 - P.r * y)

// one closed ring, clipped to the front hemisphere: hidden stretches are replaced by horizon arcs at the same azimuth
function ringPath(P: Proj, v: Float32Array): string {
  const n = v.length / 3
  let s = -1
  for (let i = 0; i < n; i++) { project(P, v, i * 3); if (P3[2]! > 0) { s = i; break } }
  if (s < 0) return ''
  let d = `M${sx(P, P3[0]!)} ${sy(P, P3[1]!)}`
  let px = P3[0]!, py = P3[1]!, pz = P3[2]!, rx = 0, ry = 0
  const arc = (x: number, y: number) => {
    const l = Math.hypot(x, y); if (!l) return
    x /= l; y /= l
    d += Math.abs(x - rx) + Math.abs(y - ry) < 1e-3 ? `L${sx(P, x)} ${sy(P, y)}` : `A${r1(P.r)} ${r1(P.r)} 0 0 ${rx * y - ry * x < 0 ? 1 : 0} ${sx(P, x)} ${sy(P, y)}`
    rx = x; ry = y
  }
  const edge = (x: number, y: number, z: number) => { const t = pz / (pz - z); return [px + t * (x - px), py + t * (y - py)] as const }
  for (let k = 1; k <= n; k++) {
    project(P, v, ((s + k) % n) * 3)
    const x = P3[0]!, y = P3[1]!, z = P3[2]!
    if (z > 0) {
      if (pz <= 0) arc(...edge(x, y, z))
      d += `L${sx(P, x)} ${sy(P, y)}`
    } else {
      if (pz > 0) { const [ex, ey] = edge(x, y, z), l = Math.hypot(ex, ey) || 1; rx = ex / l; ry = ey / l; d += `L${sx(P, rx)} ${sy(P, ry)}` }
      arc(x, y)
    }
    px = x; py = y; pz = z
  }
  return `${d}z`
}
function linePath(P: Proj, v: Float32Array): string {
  let d = '', on = false
  for (let j = 0; j < v.length; j += 3) {
    project(P, v, j)
    if (P3[2]! > 0) { d += `${on ? 'L' : 'M'}${sx(P, P3[0]!)} ${sy(P, P3[1]!)}`; on = true } else on = false
  }
  return d
}
const pointAt = (P: Proj, [lon, lat]: [number, number]) => {
  const a = new Float32Array(3); unit(lon, lat, a, 0); project(P, a, 0)
  return P3[2]! > 0.05 ? [sx(P, P3[0]!), sy(P, P3[1]!)] as const : null
}

const raf = (f: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 16) as unknown as number)
const unraf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))
const motionOk = () => typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches

export function WorldMap({ geo, onPick, localOnly }: { geo?: GeoRow[]; onPick(cc: string): void; localOnly?: boolean }) {
  const gid = useId().replace(/:/g, '')
  const [metric, setMetric] = useState<'requests' | 'mitigated'>('requests')
  const [view, setViewState] = useState<'globe' | 'flat'>(() => { try { return localStorage.getItem(KEY) === 'flat' ? 'flat' : 'globe' } catch { return 'globe' } })
  const [v, setV] = useState<View>(HOME)
  const [hi, setHi] = useState<{ cc: string; x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // the live view + gesture state, outside React so pointer moves and the animation loop don't fight over renders
  const st = useRef({ v: HOME, frame: 0, auto: true, hover: false, vx: 0, vy: 0, moved: 0, pts: new Map<number, { x: number; y: number }>(), pinch: 0 }).current

  const loop = () => {
    st.frame = 0
    let again = false
    if (!st.pts.size && (Math.abs(st.vx) > 0.02 || Math.abs(st.vy) > 0.02)) {
      st.v = clampV({ ...st.v, lon: st.v.lon + st.vx, lat: st.v.lat + st.vy }); st.vx *= 0.92; st.vy *= 0.92; again = true
    } else if (st.auto && !st.hover && motionOk()) { st.v = clampV({ ...st.v, lon: st.v.lon + 0.06 }); again = true }
    setV(st.v)
    if (again) st.frame = raf(loop)
  }
  const kick = () => { if (!st.frame) st.frame = raf(loop) }
  const go = (next: Partial<View>) => { st.auto = false; st.vx = st.vy = 0; st.v = clampV({ ...st.v, ...next }); kick() }
  const setView = (x: 'globe' | 'flat') => { setViewState(x); setHi(null); try { localStorage.setItem(KEY, x) } catch { /* private mode */ } }
  const has = !!geo?.length
  useEffect(() => { if (view === 'globe' && has) kick(); return () => { unraf(st.frame); st.frame = 0 } }, [view, has])   // eslint-disable-line react-hooks/exhaustive-deps
  // wheel zoom needs a non-passive listener to keep the page from scrolling
  useEffect(() => {
    const el = box.current
    if (!el || view !== 'globe') return
    const wheel = (e: WheelEvent) => { e.preventDefault(); go({ zoom: st.v.zoom * Math.exp(-e.deltaY * 0.0015) }) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [view, has])   // eslint-disable-line react-hooks/exhaustive-deps

  const by = new Map((geo ?? []).filter((g) => g.country !== 'LOCAL').map((g) => [g.country, g]))
  const max = Math.max(1, ...[...by.values()].map((g) => g[metric]))
  const maxReq = Math.max(1, ...[...by.values()].map((g) => g.requests))
  const off = [...by.values()].filter((g) => !WORLD[g.country]).sort((a, b) => b[metric] - a[metric])
  const fill = (cc: string) => {
    const x = by.get(cc)?.[metric] ?? 0
    return x ? `color-mix(in oklab, var(${metric === 'requests' ? '--tva-c1' : '--tva-c2'}) ${Math.round(18 + 82 * Math.sqrt(x / max))}%, var(--tva-sunken))` : undefined
  }
  const top = [...by.values()].sort((a, b) => b[metric] - a[metric]).slice(0, 5)
  const dots = [...by.values()].filter((g) => WORLD[g.country]).sort((a, b) => b.requests - a.requests).slice(0, 10)

  const P = projOf(v)
  const globe = view === 'globe'
  const ds = useMemo(() => decode().map((s) => (globe ? s.rings.map((r) => ringPath(P, r)).join('') : s.flat)), [globe, v])   // eslint-disable-line react-hooks/exhaustive-deps
  const lines = useMemo(() => (globe ? graticule().map((g) => linePath(P, g)).join('') : ''), [globe, v])   // eslint-disable-line react-hooks/exhaustive-deps
  const h = hi && by.get(hi.cc)
  const ccAt = (e: { target: EventTarget }) => (e.target as Element).getAttribute?.('data-cc') ?? null

  const pointer = {
    onPointerDown(e: PE<SVGSVGElement>) {
      if (!globe) return
      st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); st.moved = 0; st.auto = false; st.vx = st.vy = 0
      try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* synthetic pointer */ }
      if (st.pts.size === 2) { const [a, b] = [...st.pts.values()]; st.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y) }
    },
    onPointerMove(e: PE<SVGSVGElement>) {
      const r = e.currentTarget.getBoundingClientRect()
      const prev = st.pts.get(e.pointerId)
      if (!prev) { const cc = ccAt(e); setHi(cc ? { cc, x: e.clientX - r.left, y: e.clientY - r.top } : null); st.hover = !!cc; return }
      st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (st.pts.size === 2) {
        const [a, b] = [...st.pts.values()], dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        if (st.pinch) st.v = clampV({ ...st.v, zoom: st.v.zoom * (dist / st.pinch) })
        st.pinch = dist; st.moved += 10; kick(); return
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y
      st.moved += Math.abs(dx) + Math.abs(dy)
      const k = 180 / (Math.PI * P.r * ((r.width || GW) / GW))   // degrees per screen pixel at the sphere's centre
      st.vx = -dx * k; st.vy = dy * k
      st.v = clampV({ ...st.v, lon: st.v.lon + st.vx, lat: st.v.lat + st.vy })
      setHi(null); kick()
    },
    onPointerUp(e: PE<SVGSVGElement>) {
      st.pts.delete(e.pointerId); st.pinch = 0
      if (!motionOk()) st.vx = st.vy = 0
      kick()
    },
  }

  return (
    <Region id="shield:map" label="Traffic by country" className="tva-card flex min-w-0 flex-col p-4"
      state={{ view, metric, center: [Math.round(v.lon), Math.round(v.lat)], zoom: Math.round(v.zoom * 100) / 100, hovered: hi?.cc ?? null, countries: by.size, top: top.map((g) => `${g.country} ${g[metric]}`).join(', ') }}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[13px] font-semibold">Traffic by country</h3>
        <div className="tva-seg" role="group" aria-label="Map view">
          {(['globe', 'flat'] as const).map((x) => <button key={x} type="button" agentId={`map-view-${x}`} aria-pressed={view === x} className="capitalize" onClick={() => setView(x)}>{x}</button>)}
        </div>
        <div className="tva-seg" role="group" aria-label="Map metric">
          {(['requests', 'mitigated'] as const).map((m) => <button key={m} type="button" agentId={`map-${m}`} aria-pressed={metric === m} className="capitalize" onClick={() => setMetric(m)}>{m}</button>)}
        </div>
      </div>
      {!geo ? <div className={cx('tva-skel w-full', globe ? 'aspect-[800/440]' : 'aspect-[1000/394]')} aria-busy="true" />
        : !has ? (localOnly ? <LocalHint /> : <Empty title="No country data" icon="grid">No request in this view had a known country.</Empty>)
        : (
          <div ref={box} className="relative" onPointerLeave={() => { setHi(null); st.hover = false; kick() }}>
            <svg viewBox={globe ? `0 0 ${GW} ${GH}` : `0 0 ${FW} ${FH}`} className={cx('tvs-map w-full', globe && 'is-globe')} role="group" tabIndex={0} agentId="map"
              aria-label={`${globe ? 'Globe' : 'Map'} of ${metric} by country${globe ? '. Drag or use the arrow keys to rotate, + and - to zoom.' : ''}`}
              {...pointer}
              onMouseDown={(e) => e.preventDefault()}   // drag, not focus: the keyboard ring shows only when tabbed to
              onDoubleClick={() => globe && go(HOME)}
              onClick={(e) => { const cc = ccAt(e); if (cc && by.has(cc) && st.moved < 5) onPick(cc) }}
              onKeyDown={(e) => {
                const cc = ccAt(e)
                if (cc && by.has(cc) && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(cc); return }
                if (!globe) return
                const m: Record<string, Partial<View>> = { ArrowLeft: { lon: st.v.lon - STEP }, ArrowRight: { lon: st.v.lon + STEP }, ArrowUp: { lat: st.v.lat + STEP }, ArrowDown: { lat: st.v.lat - STEP },
                  '+': { zoom: st.v.zoom * 1.25 }, '=': { zoom: st.v.zoom * 1.25 }, '-': { zoom: st.v.zoom / 1.25 }, '0': HOME }
                if (m[e.key]) { e.preventDefault(); go(m[e.key]!) }
              }}>
              {globe && <>
                <defs>
                  <radialGradient id={`${gid}o`} cx="38%" cy="32%" r="75%"><stop offset="0" className="tvs-ocean-hi" /><stop offset="1" className="tvs-ocean-lo" /></radialGradient>
                  <radialGradient id={`${gid}a`} r="50%"><stop offset="0.86" className="tvs-atmo" /><stop offset="1" className="tvs-atmo" stopOpacity="0" /></radialGradient>
                </defs>
                <circle cx={GW / 2} cy={GH / 2} r={P.r * 1.07} fill={`url(#${gid}a)`} />
                <circle cx={GW / 2} cy={GH / 2} r={P.r} fill={`url(#${gid}o)`} className="tvs-sphere" />
                <path d={lines} fill="none" className="tvs-grat" />
              </>}
              {decode().map((s, i) => {
                const g = by.get(s.cc), d = ds[i]!
                return <path key={s.cc} d={d} data-cc={s.cc} fill={fill(s.cc)} className={cx(g && 'has')} {...(g && d && { tabIndex: 0, role: 'button', agentId: `country-${s.cc}`, 'aria-label': `${s.name}: ${g[metric].toLocaleString()} ${metric}, filter for it` })} />
              })}
              {dots.map((g) => {
                const p = globe ? pointAt(P, WORLD[g.country]![1]) : [fx(WORLD[g.country]![1][0]), fy(WORLD[g.country]![1][1])] as const
                if (!p) return null
                const rr = r1((2.5 + 7 * Math.sqrt(g.requests / maxReq)) * (globe ? Math.sqrt(v.zoom) : 0.8))
                return <g key={g.country} className="tvs-dot" aria-hidden="true"><circle cx={p[0]} cy={p[1]} r={rr} className="tvs-pulse" /><circle cx={p[0]} cy={p[1]} r={r1(rr * 0.55)} /></g>
              })}
            </svg>
            {globe && <div className="tvs-globe-ctl" role="group" aria-label="Globe controls">
              {([['rotate-left', 'Rotate left', { lon: v.lon - STEP }, <Icon key="i" name="chevron" size={12} className="rotate-180" />], ['rotate-up', 'Rotate up', { lat: v.lat + STEP }, <Icon key="i" name="up" size={12} />],
                ['rotate-down', 'Rotate down', { lat: v.lat - STEP }, <Icon key="i" name="down" size={12} />], ['rotate-right', 'Rotate right', { lon: v.lon + STEP }, <Icon key="i" name="chevron" size={12} />],
                ['zoom-in', 'Zoom in', { zoom: v.zoom * 1.25 }, <Icon key="i" name="plus" size={12} />], ['zoom-out', 'Zoom out', { zoom: v.zoom / 1.25 }, <span key="i" aria-hidden="true">−</span>],
                ['reset', 'Reset view', HOME, <Icon key="i" name="refresh" size={12} />]] as const).map(([id, label, next, icon]) => (
                <button key={id} type="button" agentId={`globe-${id}`} aria-label={label} title={label} onClick={() => go(next)}
                  disabled={(id === 'zoom-in' && v.zoom >= 4) || (id === 'zoom-out' && v.zoom <= 1)}>{icon}</button>
              ))}
            </div>}
            {hi && <div role="status" className="tva-tip" style={{ left: Math.max(0, hi.x - 70), top: hi.y + 14 }}>
              <p className="font-semibold">{flag(hi.cc)} {countryName(hi.cc)}</p>
              {h ? <><p><strong className="tabular-nums">{h.requests.toLocaleString()}</strong> <span className="text-muted">requests</span></p><p><strong className="tabular-nums">{h.mitigated.toLocaleString()}</strong> <span className="text-muted">mitigated ({pct(h.mitigated, h.requests)})</span></p><p className="text-[11px] text-muted">Click to filter</p></> : <p className="text-muted">No requests</p>}
            </div>}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">0<span className="tvs-ramp" data-m={metric} />{num(max)}</span>
              {top.map((g) => <button key={g.country} type="button" agentId={`map-top-${g.country}`} className="hover:text-fg" onClick={() => onPick(g.country)}>{flag(g.country)} {g.country} <strong className="tabular-nums text-fg">{num(g[metric])}</strong></button>)}
            </div>
            {off.length > 0 && <p className="mt-1 text-xs text-muted">Not on the map: {off.slice(0, 8).map((g) => <button key={g.country} type="button" agentId={`map-off-${g.country}`} className="mr-2 hover:text-fg" onClick={() => onPick(g.country)}>{flag(g.country)} {g.country} {num(g[metric])}</button>)}</p>}
            {localOnly && <LocalHint />}
          </div>
        )}
    </Region>
  )
}

const LocalHint = () => (
  <p role="note" className="tvs-banner mt-2 text-xs"><span aria-hidden="true">🏠</span>All traffic so far is from your own machine (localhost), which has no country. Try <code className="font-mono">tvine shield simulate</code> to see sample traffic.</p>
)
