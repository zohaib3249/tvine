'use client'
// Inputs pack widgets (forms.md): one per FieldKind, on native elements, each ONE agent target (the Field).
// Same props / classes / data-attributes as widgets.tsx.
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent, type ReactNode } from 'react'
import type { FieldMeta, FieldWidgetProps } from './types.js'
import { COUNTRY_CODES, COUNTRY_DIAL, countryName, normalizePhone } from './rich.js'
import { markdownToHtml } from './richdoc.js'

const common = (p: FieldWidgetProps) => ({
  id: p.id, name: p.name, disabled: p.readOnly, required: p.meta.required,
  'aria-invalid': p.invalid || undefined, 'aria-describedby': p.describedBy,
})
const ev = (f: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => f(e.target.value)
const group = (p: FieldWidgetProps, role = 'group') => ({ role, 'aria-label': p.meta.label, id: p.id, 'aria-describedby': p.describedBy, 'aria-invalid': p.invalid || undefined })

// ---- simple native inputs ----
const NATIVE: Record<string, Record<string, unknown>> = {
  search: { type: 'search', autoComplete: 'off' }, month: { type: 'month', placeholder: 'YYYY-MM' }, week: { type: 'week', placeholder: 'YYYY-Www' },
  ip: { type: 'text', inputMode: 'decimal', spellCheck: false, autoCapitalize: 'off', placeholder: '192.0.2.1 or 2001:db8::1' },
  slugAuto: { type: 'text', spellCheck: false, autoCapitalize: 'off' },
}
export function Native(p: FieldWidgetProps) {
  return <input className="tf-input" {...NATIVE[p.meta.kind]} value={p.value ?? ''} onChange={ev(p.onChange)} maxLength={p.meta.maxLength} {...common(p)} />
}

export function Color(p: FieldWidgetProps) {
  const v: string = p.value ?? '', ok = /^#[0-9a-f]{6}$/i.test(v)
  return <div className="tf-color" data-part="color">
    <input type="color" className="tf-color-swatch" aria-label={`${p.meta.label} picker`} value={ok ? v.toLowerCase() : '#000000'} disabled={p.readOnly} onChange={ev(p.onChange)} />
    <input className="tf-input tf-mono" type="text" placeholder="#000000" maxLength={7} spellCheck={false} value={v} onChange={ev(p.onChange)} {...common(p)} />
    {p.meta.palette && <div className="tf-palette" role="group" aria-label={`${p.meta.label} palette`}>
      {p.meta.palette.map((c) => <button key={c} type="button" className="tf-palette-dot" style={{ background: c }} aria-label={c} aria-pressed={c.toLowerCase() === v.toLowerCase()}
        disabled={p.readOnly} onClick={() => p.onChange(c.toLowerCase())} />)}
    </div>}
  </div>
}

export function Range(p: FieldWidgetProps) {
  const m = p.meta, min = m.min ?? 0, max = m.max ?? 100, step = m.step ?? 1
  if (m.multiple) {
    const [lo, hi] = (Array.isArray(p.value) ? p.value : [min, max]).map(Number) as [number, number]
    const set = (a: number, b: number) => p.onChange([Math.min(a, b), Math.max(a, b)])
    return <div className="tf-range tf-range-dual" data-part="range" {...group(p)}>
      <input type="range" className="tf-range-input" min={min} max={max} step={step} value={lo} aria-label={`${m.label} minimum`} disabled={p.readOnly} onChange={(e) => set(+e.target.value, hi)} />
      <input type="range" className="tf-range-input" min={min} max={max} step={step} value={hi} aria-label={`${m.label} maximum`} disabled={p.readOnly} onChange={(e) => set(lo, +e.target.value)} />
      <output className="tf-range-out">{lo} – {hi}</output>
    </div>
  }
  const v = p.value === '' || p.value == null ? min : Number(p.value)
  return <div className="tf-range" data-part="range">
    <input type="range" className="tf-range-input" min={min} max={max} step={step} value={v} onChange={ev(p.onChange)} {...common(p)} required={false} />
    <output className="tf-range-out" htmlFor={p.id}>{p.value === '' || p.value == null ? '—' : v}</output>
  </div>
}

const dialOf = (v: string) => { let best = ''; for (const [c, d] of COUNTRY_DIAL) if (v.startsWith(`+${d}`) && d.length > (COUNTRY_DIAL.get(best)?.length ?? 0)) best = c; return best }
export function Phone(p: FieldWidgetProps) {
  const v: string = p.value ?? ''
  const [country, setCountry] = useState(() => dialOf(v) || p.meta.choices?.[0]?.value || 'US')
  const dial = COUNTRY_DIAL.get(country) ?? ''
  useEffect(() => { const c = dialOf(v); if (c && COUNTRY_DIAL.get(c) !== dial) setCountry(c) }, [v])   // set from outside (agent / reset)
  const shown = v.startsWith(`+${dial}`) ? v.slice(dial.length + 1) : v
  return <div className="tf-phone" data-part="phone">
    <select className="tf-input tf-phone-cc" aria-label={`${p.meta.label} country code`} value={country} disabled={p.readOnly}
      onChange={(e) => { setCountry(e.target.value); if (shown) p.onChange(normalizePhone(shown, e.target.value)) }}>
      {COUNTRY_CODES.map((c) => <option key={c} value={c}>{c} +{COUNTRY_DIAL.get(c)}</option>)}
    </select>
    <input className="tf-input" type="tel" autoComplete="tel" inputMode="tel" placeholder="555 123 4567" value={shown}
      onChange={(e) => p.onChange(e.target.value ? normalizePhone(e.target.value, country) : '')} {...common(p)} />
  </div>
}

export function Tags(p: FieldWidgetProps) {
  const vs: string[] = p.value ?? [], m = p.meta
  const [text, setText] = useState('')
  const full = m.max != null && vs.length >= m.max
  const add = (raw: string) => {
    const t = raw.trim()
    if (!t || vs.includes(t) || full) return
    if (m.choices && !m.free && !m.choices.some((c) => c.value === t)) return
    p.onChange([...vs, t]); setText('')
  }
  return <div className="tf-tags" data-part="tags">
    <ul className="tf-chips" aria-label={`${m.label} selected`}>
      {vs.map((t) => <li key={t} className="tf-chip" data-value={t}>{m.choices?.find((c) => c.value === t)?.label ?? t}
        {!p.readOnly && <button type="button" className="tf-chip-x" aria-label={`Remove ${t}`} onClick={() => p.onChange(vs.filter((x) => x !== t))}>×</button>}</li>)}
    </ul>
    {!p.readOnly && <input className="tf-input" type="text" list={m.choices ? `${p.id}-dl` : undefined} placeholder={full ? `Max ${m.max}` : 'Add… (Enter)'} disabled={full}
      value={text} onChange={(e) => setText(e.target.value)} id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text) }
        else if (e.key === 'Backspace' && !text && vs.length) p.onChange(vs.slice(0, -1))
      }} onBlur={() => add(text)} />}
    {m.choices && <datalist id={`${p.id}-dl`}>{m.choices.filter((c) => !vs.includes(c.value)).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</datalist>}
  </div>
}

export function Checkboxes(p: FieldWidgetProps) {
  const vs: string[] = p.value ?? []
  return <div className="tf-checks" data-part="checkboxes" {...group(p)}>
    {(p.meta.choices ?? []).map((c) => <label key={c.value} className="tf-radio"><input type="checkbox" className="tf-check" value={c.value} name={p.name}
      checked={vs.includes(c.value)} disabled={p.readOnly} onChange={(e) => p.onChange(e.target.checked ? [...vs, c.value] : vs.filter((x) => x !== c.value))} /> <span>{c.label}</span></label>)}
  </div>
}

export function Switch(p: FieldWidgetProps) {
  return <button type="button" className="tf-switch" role="switch" aria-checked={!!p.value} id={p.id} aria-describedby={p.describedBy} disabled={p.readOnly}
    data-checked={p.value ? '' : undefined} onClick={() => p.onChange(!p.value)}><span className="tf-switch-thumb" /><span className="tf-sr-only">{p.meta.label}</span></button>
}

export function Segmented(p: FieldWidgetProps) {
  return <div className="tf-segmented" data-part="segmented" {...group(p, 'radiogroup')}>
    {(p.meta.choices ?? []).map((c) => <label key={c.value} className="tf-seg" data-checked={p.value === c.value ? '' : undefined}>
      <input type="radio" className="tf-sr-only" name={p.name} value={c.value} checked={p.value === c.value} disabled={p.readOnly} onChange={() => p.onChange(c.value)} />{c.label}</label>)}
  </div>
}

export function Rating(p: FieldWidgetProps) {
  const max = p.meta.max ?? 5, v = Number(p.value) || 0
  return <div className="tf-rating" data-part="rating" {...group(p, 'radiogroup')}>
    {Array.from({ length: max }, (_, i) => i + 1).map((n) => <label key={n} className="tf-star" data-on={n <= v ? '' : undefined} title={`${n} of ${max}`}>
      <input type="radio" className="tf-sr-only" name={p.name} value={n} checked={v === n} disabled={p.readOnly} onChange={() => p.onChange(n)}
        onClick={() => { if (v === n && !p.meta.required) p.onChange(0) }} aria-label={`${n} of ${max}`} />★</label>)}
  </div>
}

export function Otp(p: FieldWidgetProps) {
  const n = p.meta.maxLength ?? 6, v: string = p.value ?? ''
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const put = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (!digits && raw) return
    const arr = v.padEnd(n, ' ').split('')
    if (!digits) arr[i] = ' '
    else for (let k = 0; k < digits.length && i + k < n; k++) arr[i + k] = digits[k]!
    p.onChange(arr.join('').trimEnd().replace(/ /g, ''))   // ponytail: a gap in the middle closes up; codes are typed in order
    refs.current[Math.min(n - 1, i + Math.max(1, digits.length))]?.focus()
  }
  return <div className="tf-otp" data-part="otp" {...group(p)}>
    {Array.from({ length: n }, (_, i) => <input key={i} ref={(el) => { refs.current[i] = el }} className="tf-input tf-otp-cell" type="text" inputMode="numeric"
      autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={i === 0 ? n : 1} aria-label={`Digit ${i + 1} of ${n}`} value={v[i] ?? ''} disabled={p.readOnly}
      onChange={(e) => put(i, e.target.value.slice(-n))}
      onPaste={(e) => { e.preventDefault(); put(i, e.clipboardData.getData('text')) }}
      onKeyDown={(e) => { if (e.key === 'Backspace' && !v[i] && i) { refs.current[i - 1]?.focus() } }} />)}
    <input type="hidden" name={p.name} value={v} />
  </div>
}

export function Markdown(p: FieldWidgetProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const ta = useRef<HTMLTextAreaElement>(null), v: string = p.value ?? ''
  const wrap = (a: string, b = a) => {
    const t = ta.current; if (!t) return
    const s = t.selectionStart, e = t.selectionEnd
    p.onChange(v.slice(0, s) + a + v.slice(s, e) + b + v.slice(e))
    requestAnimationFrame(() => { t.focus(); t.setSelectionRange(s + a.length, e + a.length) })
  }
  const line = (pre: string) => { const t = ta.current; if (!t) return; const ls = v.lastIndexOf('\n', t.selectionStart - 1) + 1; p.onChange(v.slice(0, ls) + pre + v.slice(ls)) }
  const tools: [string, string, () => void][] = [['B', 'Bold', () => wrap('**')], ['I', 'Italic', () => wrap('*')], ['S', 'Strikethrough', () => wrap('~~')],
    ['</>', 'Code', () => wrap('`')], ['H', 'Heading', () => line('## ')], ['•', 'List', () => line('- ')], ['❝', 'Quote', () => line('> ')], ['🔗', 'Link', () => wrap('[', '](https://)')]]
  return <div className="tf-markdown" data-part="markdown">
    <div className="tf-toolbar" role="toolbar" aria-label={`${p.meta.label} formatting`}>
      <button type="button" className="tf-btn tf-btn-ghost tf-tool" aria-pressed={tab === 'write'} onClick={() => setTab('write')}>Write</button>
      <button type="button" className="tf-btn tf-btn-ghost tf-tool" aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
      <span className="tf-tool-sep" aria-hidden="true" />
      {!p.readOnly && tab === 'write' && tools.map(([l, t, f]) => <button key={t} type="button" className="tf-btn tf-btn-ghost tf-tool" aria-label={t} title={t} onMouseDown={(e) => e.preventDefault()} onClick={f}>{l}</button>)}
    </div>
    <div className="tf-md-panes" data-tab={tab}>
      <textarea ref={ta} className="tf-input tf-textarea tf-mono" rows={6} value={v} onChange={ev(p.onChange)} maxLength={p.meta.maxLength} {...common(p)} hidden={tab !== 'write'} />
      {tab === 'preview' && <div className="tf-input tf-rich-view tf-md-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(v) || '<p>Nothing to preview</p>' }} />}
    </div>
  </div>
}

export function DateRange(p: FieldWidgetProps) {
  const v = p.value ?? { start: '', end: '' }
  return <div className="tf-daterange" data-part="daterange" {...group(p)}>
    <input className="tf-input" type="date" aria-label={`${p.meta.label} start`} value={v.start} max={v.end || undefined} disabled={p.readOnly} onChange={(e) => p.onChange({ ...v, start: e.target.value })} />
    <span aria-hidden="true">–</span>
    <input className="tf-input" type="date" aria-label={`${p.meta.label} end`} value={v.end} min={v.start || undefined} disabled={p.readOnly} onChange={(e) => p.onChange({ ...v, end: e.target.value })} />
  </div>
}

// Searchable: a filter box narrows the native <select> (which also has type-ahead).
function useCountries() {
  const [list, setList] = useState(() => COUNTRY_CODES.map((c) => [c, c] as [string, string]))
  useEffect(() => { setList(COUNTRY_CODES.map((c) => [c, countryName(c, navigator.language)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]))) }, [])   // names in the tab's locale after hydration
  return list
}
export function CountrySelect(p: { id?: string; value: string; onChange(v: string): void; label: string; disabled?: boolean; required?: boolean; invalid?: boolean; describedBy?: string }) {
  const all = useCountries(), [q, setQ] = useState('')
  const shown = q ? all.filter(([c, n]) => c === p.value || `${c} ${n}`.toLowerCase().includes(q.toLowerCase())) : all
  return <div className="tf-country" data-part="country">
    <input className="tf-input tf-country-q" type="search" placeholder="Filter countries…" aria-label={`${p.label} filter`} value={q} disabled={p.disabled} onChange={(e) => setQ(e.target.value)} />
    <select className="tf-input" id={p.id} value={p.value} aria-label={p.label} disabled={p.disabled} required={p.required} aria-invalid={p.invalid || undefined} aria-describedby={p.describedBy}
      onChange={(e) => p.onChange(e.target.value)}>
      <option value="">---------</option>
      {shown.map(([c, n]) => <option key={c} value={c}>{n === c ? c : `${n} (${c})`}</option>)}
    </select>
  </div>
}
export function Country(p: FieldWidgetProps) {
  return <CountrySelect id={p.id} value={p.value ?? ''} onChange={p.onChange} label={p.meta.label} disabled={p.readOnly} required={p.meta.required} invalid={p.invalid} describedBy={p.describedBy} />
}

export const ADDRESS_PARTS = [['line1', 'Street address', 'address-line1'], ['line2', 'Apartment, suite, etc.', 'address-line2'], ['city', 'City', 'address-level2'],
  ['region', 'State / region', 'address-level1'], ['postal', 'Postal code', 'postal-code']] as const
export function Address(p: FieldWidgetProps) {
  const v = p.value ?? {}, set = (k: string, x: string) => p.onChange({ ...v, [k]: x })
  return <div className="tf-address" data-part="address" {...group(p)}>
    {ADDRESS_PARTS.map(([k, label, ac]) => <label key={k} className="tf-sub"><span className="tf-sub-label">{label}</span>
      <input className="tf-input" type="text" autoComplete={ac} value={v[k] ?? ''} disabled={p.readOnly} onChange={(e) => set(k, e.target.value)} /></label>)}
    <label className="tf-sub"><span className="tf-sub-label">Country</span>
      <CountrySelect value={v.country ?? ''} onChange={(c) => set('country', c)} label={`${p.meta.label} country`} disabled={p.readOnly} /></label>
  </div>
}

export function KeyValue(p: FieldWidgetProps) {
  const rows: { key: string; value: string }[] = p.value ?? []
  const set = (i: number, r: { key: string; value: string }) => p.onChange(rows.map((x, k) => (k === i ? r : x)))
  return <div className="tf-kv" data-part="keyvalue" {...group(p)}>
    {rows.map((r, i) => <div key={i} className="tf-kv-row">
      <input className="tf-input tf-mono" placeholder="key" aria-label={`Key ${i + 1}`} value={r.key} disabled={p.readOnly} onChange={(e) => set(i, { ...r, key: e.target.value })} />
      <input className="tf-input" placeholder="value" aria-label={`Value ${i + 1}`} value={r.value} disabled={p.readOnly} onChange={(e) => set(i, { ...r, value: e.target.value })} />
      {!p.readOnly && <button type="button" className="tf-btn tf-btn-ghost" aria-label={`Remove ${r.key || `row ${i + 1}`}`} onClick={() => p.onChange(rows.filter((_, k) => k !== i))}>×</button>}
    </div>)}
    {!p.readOnly && <button type="button" className="tf-btn tf-btn-ghost tf-add" onClick={() => p.onChange([...rows, { key: '', value: '' }])}>+ Add row</button>}
  </div>
}

// list of a sub-kind: each row is the sub-kind's own widget (no own agent target; the list field's add/remove/set drive it)
export function List(p: FieldWidgetProps & { widgetFor(m: FieldMeta): (q: FieldWidgetProps) => ReactNode; blank(m: FieldMeta): unknown }) {
  const of: FieldMeta = { name: 'item', label: 'Item', kind: 'text', required: false, readOnly: false, nullable: false, ...p.meta.of }
  const vs: unknown[] = p.value ?? [], W = p.widgetFor(of)
  const full = p.meta.max != null && vs.length >= p.meta.max
  return <div className="tf-list" data-part="list" {...group(p)}>
    {vs.map((x, i) => <div key={i} className="tf-list-row">
      <div className="tf-list-item">{W({ meta: { ...of, label: `${p.meta.label} ${i + 1}` }, value: x, onChange: (y) => p.onChange(vs.map((z, k) => (k === i ? y : z))), id: `${p.id}-${i}`, name: `${p.name}.${i}`, invalid: false, readOnly: p.readOnly })}</div>
      {!p.readOnly && <button type="button" className="tf-btn tf-btn-ghost" aria-label={`Remove item ${i + 1}`} onClick={() => p.onChange(vs.filter((_, k) => k !== i))}>×</button>}
    </div>)}
    {!p.readOnly && !full && <button type="button" className="tf-btn tf-btn-ghost tf-add" onClick={() => p.onChange([...vs, p.blank(of)])}>+ Add</button>}
  </div>
}

// Canvas → PNG File (uploaded like an image field). Agents cannot draw: the field is humanOnly by default.
export function Signature(p: FieldWidgetProps) {
  const cv = useRef<HTMLCanvasElement>(null), drawing = useRef(false)
  const stored = typeof p.value === 'string' ? p.value : undefined
  const pos = (e: PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)] as const }
  const clear = () => { const c = cv.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); p.onChange(null) }
  useEffect(() => { if (p.value == null) { const c = cv.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height) } }, [p.value])
  return <div className="tf-signature" data-part="signature" data-filled={p.value ? '' : undefined}>
    {stored ? <img className="tf-preview" src={stored} alt={`${p.meta.label} (saved)`} />
      : <canvas ref={cv} className="tf-signature-pad" width={480} height={140} id={p.id} aria-label={`${p.meta.label}: draw with mouse, pen or finger`} aria-describedby={p.describedBy}
          role="img" style={{ touchAction: 'none' }}
          onPointerDown={(e) => { if (p.readOnly) return; drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); const g = e.currentTarget.getContext('2d'); const [x, y] = pos(e); g?.beginPath(); g?.moveTo(x, y) }}
          onPointerMove={(e) => { if (!drawing.current) return; const g = e.currentTarget.getContext('2d'); if (!g) return; const [x, y] = pos(e); g.lineWidth = 2.5; g.lineCap = 'round'; g.strokeStyle = getComputedStyle(e.currentTarget).color || '#111'; g.lineTo(x, y); g.stroke() }}
          onPointerUp={(e) => { if (!drawing.current) return; drawing.current = false; e.currentTarget.toBlob?.((b) => { if (b) p.onChange(new File([b], 'signature.png', { type: 'image/png' })) }, 'image/png') }} />}
    {!p.readOnly && <button type="button" className="tf-btn tf-btn-ghost" onClick={clear}>Clear</button>}
  </div>
}

// Intl's full ISO 4217 list where the runtime has it; else the money widget's list.
const FALLBACK = ['USD', 'EUR', 'GBP', 'ISK', 'SEK', 'NOK', 'DKK', 'CHF', 'JPY', 'CAD', 'AUD', 'PKR', 'INR']
export const currencies = (m: FieldMeta): string[] => m.choices?.map((c) => c.value)
  ?? ((Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? FALLBACK)
export function Currency(p: FieldWidgetProps) {
  return <select className="tf-input" value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)}>
    <option value="">---------</option>
    {currencies(p.meta).map((c) => <option key={c} value={c}>{c}</option>)}
  </select>
}

export function Percent(p: FieldWidgetProps) {
  return <div className="tf-money" data-part="percent">
    <input className="tf-input" type="number" inputMode="decimal" step={p.meta.step ?? 'any'} min={p.meta.min ?? 0} max={p.meta.max ?? 100} value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} />
    <span className="tf-addon" aria-hidden="true">%</span>
  </div>
}
