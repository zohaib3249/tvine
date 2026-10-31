'use client'
// One built-in widget per FieldKind, on native elements. Each gets FieldWidgetProps (form-shape value).
// Classes are `tf-*` (forms.css); every part also carries data-attributes for Tailwind (`data-[invalid]:…`).
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react'
import type { FieldKind, FieldWidget, FieldWidgetProps, SearchResult } from './types.js'
import { countryName, sanitizeHtml } from './rich.js'
import { RichEditor } from './rich-editor.js'
import { CodeEditor, highlight } from './code.js'
import { markdownToHtml } from './richdoc.js'
import { fromApi } from './values.js'
import * as I from './inputs.js'

const common = (p: FieldWidgetProps) => ({
  id: p.id, name: p.name, disabled: p.readOnly, required: p.meta.required,
  'aria-invalid': p.invalid || undefined, 'aria-describedby': p.describedBy,
})
const ev = (f: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => f(e.target.value)

const INPUT_TYPE: Partial<Record<FieldKind, string>> = { text: 'text', email: 'email', url: 'url', slug: 'text', uuid: 'text', date: 'date', datetime: 'datetime-local', time: 'time' }

function TextInput(p: FieldWidgetProps) {
  const m = p.meta
  return <input className="tf-input" type={INPUT_TYPE[m.kind] ?? 'text'} value={p.value ?? ''} onChange={ev(p.onChange)} maxLength={m.maxLength}
    spellCheck={m.kind === 'slug' || m.kind === 'uuid' ? false : undefined} placeholder={m.kind === 'uuid' ? '00000000-0000-0000-0000-000000000000' : undefined}
    autoComplete={m.kind === 'email' ? 'email' : m.kind === 'url' ? 'url' : undefined} {...common(p)} />
}
function Duration(p: FieldWidgetProps) {
  return <input className="tf-input" type="text" inputMode="numeric" placeholder="HH:MM:SS" pattern="(\d+ )?\d+:[0-5]?\d(:[0-5]?\d)?" value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} />
}
function TextArea(p: FieldWidgetProps) {
  return <textarea className="tf-input tf-textarea" rows={4} value={p.value ?? ''} onChange={ev(p.onChange)} maxLength={p.meta.maxLength} {...common(p)} />
}
const step = (d?: number) => (d == null ? 'any' : d === 0 ? '1' : `0.${'0'.repeat(d - 1)}1`)
function NumberInput(p: FieldWidgetProps) {
  const m = p.meta
  return <input className="tf-input" type="number" inputMode={m.kind === 'int' ? 'numeric' : 'decimal'} step={m.kind === 'int' ? 1 : step(m.decimals)}
    min={m.min} max={m.max} value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} />
}

// ponytail: fixed currency list when the field has no fixed currency; pass `choices` on a money field to restrict.
const CURRENCIES = ['USD', 'EUR', 'GBP', 'ISK', 'SEK', 'NOK', 'DKK', 'CHF', 'JPY', 'CAD', 'AUD', 'PKR', 'INR']
function Money(p: FieldWidgetProps) {
  const m = p.meta, v = p.value ?? { amount: '', currency: m.currency ?? '' }
  const list = m.choices?.map((c) => c.value) ?? CURRENCIES
  return <div className="tf-money" data-part="money">
    <input className="tf-input" type="number" inputMode="decimal" step={step(m.decimals ?? 2)} min={m.min} max={m.max} value={v.amount}
      onChange={(e) => p.onChange({ ...v, amount: e.target.value })} {...common(p)} />
    {m.currency
      ? <span className="tf-addon" aria-label="currency">{m.currency}</span>
      : <select className="tf-input tf-currency" aria-label={`${m.label} currency`} disabled={p.readOnly} value={v.currency}
          onChange={(e) => p.onChange({ ...v, currency: e.target.value })}>
          <option value="">—</option>{list.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>}
  </div>
}

function Bool(p: FieldWidgetProps) {
  if (p.meta.nullable) {   // Django NullBooleanSelect
    return <select className="tf-input" value={p.value == null ? '' : String(p.value)} onChange={(e) => p.onChange(e.target.value === '' ? null : e.target.value === 'true')} {...common(p)}>
      <option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option>
    </select>
  }
  return <input className="tf-check" type="checkbox" checked={!!p.value} onChange={(e) => p.onChange(e.target.checked)} {...common(p)} required={false} />
}

const RADIO_MAX = 4
function Choice(p: FieldWidgetProps) {
  const m = p.meta, cs = m.choices ?? []
  if (m.multiple) {
    return <select className="tf-input" multiple value={p.value ?? []} onChange={(e) => p.onChange([...e.target.selectedOptions].map((o) => o.value))} {...common(p)}>
      {cs.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  }
  if (cs.length <= RADIO_MAX) {
    const { id, describedBy } = p
    return <div className="tf-radios" role="radiogroup" aria-label={m.label} id={id} aria-describedby={describedBy} aria-invalid={p.invalid || undefined} aria-required={m.required || undefined}>
      {!m.required && <label className="tf-radio"><input type="radio" name={p.name} value="" checked={!p.value} disabled={p.readOnly} onChange={() => p.onChange('')} /> <span>None</span></label>}
      {cs.map((c) => <label key={c.value} className="tf-radio"><input type="radio" name={p.name} value={c.value} checked={p.value === c.value} disabled={p.readOnly} onChange={() => p.onChange(c.value)} /> <span>{c.label}</span></label>)}
    </div>
  }
  return <select className="tf-input" value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)}>
    <option value="">---------</option>
    {cs.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
  </select>
}

function Password(p: FieldWidgetProps) {
  const [show, setShow] = useState(false)
  return <div className="tf-password" data-part="password">
    <input className="tf-input" type={show ? 'text' : 'password'} autoComplete="new-password" value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} />
    <button type="button" className="tf-btn tf-btn-ghost" aria-pressed={show} aria-controls={p.id} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
  </div>
}

function Json(p: FieldWidgetProps) {
  let err: string | undefined
  if (p.value) { try { JSON.parse(p.value) } catch (e) { err = (e as Error).message } }
  return <div className="tf-json" data-part="json" data-invalid={err ? '' : undefined}>
    <textarea className="tf-input tf-textarea tf-mono" rows={6} spellCheck={false} value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)}
      aria-invalid={p.invalid || !!err || undefined} />
    {err && <p className="tf-hint tf-hint-error" data-part="json-error">JSON: {err}</p>}
  </div>
}

// ---- files ----
const isFile = (v: unknown): v is File => typeof File !== 'undefined' && v instanceof File
const fileName = (v: any): string => isFile(v) ? v.name : typeof v === 'string' ? v.split('/').pop()! : v?.name ?? v?.url ?? ''
const fileUrl = (v: any): string | undefined => typeof v === 'string' ? v : v?.url
function Upload(p: FieldWidgetProps) {
  const m = p.meta, v = p.value, img = m.kind === 'image'
  const [preview, setPreview] = useState<string>()
  useEffect(() => {
    if (!img || !isFile(v) || typeof URL.createObjectURL !== 'function') return setPreview(undefined)
    const u = URL.createObjectURL(v); setPreview(u); return () => URL.revokeObjectURL(u)
  }, [v, img])
  const src = preview ?? (img ? fileUrl(v) : undefined)
  return <div className="tf-file" data-part="file" data-filled={v ? '' : undefined}>
    {src && <img className="tf-preview" src={src} alt="" />}
    {v && <span className="tf-file-name">{fileUrl(v) && !isFile(v) ? <a href={fileUrl(v)} target="_blank" rel="noreferrer">{fileName(v)}</a> : fileName(v)}</span>}
    <input className="tf-file-input" type="file" accept={m.upload?.accept ?? (img ? 'image/*' : undefined)} {...common(p)} required={m.required && !v}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onChange(f) }} />
    {v && !m.required && !p.readOnly && <button type="button" className="tf-btn tf-btn-ghost" onClick={() => p.onChange(null)}>Clear</button>}
  </div>
}

// ---- fk / m2m: async autocomplete (APG combobox) over `search(q, page)` ----
function useSearch(p: FieldWidgetProps) {
  const [q, setQ] = useState(''), [res, setRes] = useState<SearchResult[]>([]), [more, setMore] = useState(false)
  const [page, setPage] = useState(1), [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [hi, setHi] = useState(-1)
  const seq = useRef(0)
  const run = (text: string, pg = 1) => {
    if (!p.search) return
    const n = ++seq.current; setLoading(true)
    p.search(text, pg).then((r) => { if (n !== seq.current) return; setRes((old) => (pg > 1 ? [...old, ...r.results] : r.results)); setMore(r.more); setPage(pg) },
      () => { if (n === seq.current) setRes([]) }).finally(() => { if (n === seq.current) setLoading(false) })
  }
  return { q, setQ, res, more, page, open, setOpen, loading, hi, setHi, run }
}
function Listbox(p: { id: string; s: ReturnType<typeof useSearch>; pick(r: SearchResult): void; selected(pk: string): boolean }) {
  const { s } = p
  return <ul className="tf-listbox" id={`${p.id}-list`} role="listbox" hidden={!s.open} aria-busy={s.loading || undefined}>
    {s.res.map((r, i) => <li key={r.pk} id={`${p.id}-o${i}`} role="option" className="tf-option" data-value={r.pk} aria-selected={p.selected(r.pk)}
      data-highlighted={i === s.hi ? '' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => p.pick(r)}>{r.text}</li>)}
    {s.more && <li role="presentation" className="tf-option tf-more" onMouseDown={(e) => e.preventDefault()} onClick={() => s.run(s.q, s.page + 1)}>Load more…</li>}
    {s.loading && <li role="presentation" className="tf-option tf-muted">Loading…</li>}
    {!s.loading && !s.res.length && <li role="presentation" className="tf-option tf-muted">No results</li>}
  </ul>
}
function searchInput(p: FieldWidgetProps, s: ReturnType<typeof useSearch>, pick: (r: SearchResult) => void, extra: Record<string, unknown> = {}) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = s.res.length
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) { e.preventDefault(); s.setOpen(true); s.setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) }
    else if (e.key === 'Enter' && s.open && s.res[s.hi]) { e.preventDefault(); pick(s.res[s.hi]!) }
    else if (e.key === 'Escape') s.setOpen(false)
  }
  return <input className="tf-input tf-search" type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={s.open}
    aria-controls={`${p.id}-list`} aria-activedescendant={s.open && s.res[s.hi] ? `${p.id}-o${s.hi}` : undefined}
    {...common(p)} required={false} name={undefined} value={s.q} onKeyDown={onKey}
    onFocus={() => { s.setOpen(true); if (!s.res.length) s.run(s.q) }} onBlur={() => s.setOpen(false)}
    onChange={(e) => { s.setQ(e.target.value); s.setOpen(true); s.setHi(-1); s.run(e.target.value) }} {...extra} />
}
// Django's default fk / m2m widget: a <select> of the related rows the server listed (FieldMeta.choices)
const selectRel = (p: FieldWidgetProps) => !!p.meta.relation && !p.meta.relation.autocomplete && !p.meta.relation.rawId && !!p.meta.choices
const toRef = (p: FieldWidgetProps, pk: string): SearchResult => ({ pk, text: p.meta.choices!.find((c) => c.value === pk)?.label ?? pk })
function Fk(p: FieldWidgetProps) {
  const rel = p.meta.relation, s = useSearch(p), v = p.value as SearchResult | null
  if (selectRel(p)) {
    return <select className="tf-input" value={v?.pk ?? ''} onChange={(e) => p.onChange(e.target.value ? toRef(p, e.target.value) : null)} {...common(p)}>
      <option value="">---------</option>
      {p.meta.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  }
  if (rel?.rawId || !p.search) {   // Django raw_id_fields: type the pk
    return <input className="tf-input" type="text" inputMode="numeric" value={v?.pk ?? ''} placeholder="id"
      onChange={(e) => p.onChange(e.target.value ? { pk: e.target.value, text: e.target.value } : null)} {...common(p)} />
  }
  const pick = (r: SearchResult) => { p.onChange(r); s.setQ(''); s.setOpen(false) }
  return <div className="tf-autocomplete" data-part="fk">
    {v ? <span className="tf-chip" data-value={v.pk}>{v.text}{!p.readOnly && <button type="button" className="tf-chip-x" aria-label={`Clear ${v.text}`} onClick={() => p.onChange(null)}>×</button>}</span>
      : searchInput(p, s, pick, { placeholder: 'Search…' })}
    <input type="hidden" name={p.name} value={v?.pk ?? ''} />
    <Listbox id={p.id} s={s} pick={pick} selected={(pk) => v?.pk === pk} />
  </div>
}
function M2m(p: FieldWidgetProps) {
  const s = useSearch(p), vs = (p.value ?? []) as SearchResult[]
  if (selectRel(p)) {
    return <select className="tf-input" multiple value={vs.map((r) => r.pk)} onChange={(e) => p.onChange([...e.target.selectedOptions].map((o) => toRef(p, o.value)))} {...common(p)}>
      {p.meta.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  }
  const pick = (r: SearchResult) => { if (!vs.some((x) => x.pk === r.pk)) p.onChange([...vs, r]); s.setQ('') }
  return <div className="tf-autocomplete tf-multi" data-part="m2m">
    <ul className="tf-chips" aria-label={`${p.meta.label} selected`}>
      {vs.map((r) => <li key={r.pk} className="tf-chip" data-value={r.pk}>{r.text}
        {!p.readOnly && <button type="button" className="tf-chip-x" aria-label={`Remove ${r.text}`} onClick={() => p.onChange(vs.filter((x) => x.pk !== r.pk))}>×</button>}</li>)}
    </ul>
    {!p.readOnly && (p.search ? searchInput(p, s, pick, { placeholder: 'Add…' })
      : <input className="tf-input" type="text" placeholder="ids, comma separated" defaultValue={vs.map((r) => r.pk).join(',')} {...common(p)}
          onBlur={(e) => p.onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((pk) => ({ pk, text: pk })))} />)}
    <Listbox id={p.id} s={s} pick={pick} selected={(pk) => vs.some((x) => x.pk === pk)} />
  </div>
}

export const BUILTIN: Record<FieldKind, FieldWidget> = {
  text: TextInput, email: TextInput, url: TextInput, slug: TextInput, uuid: TextInput, date: TextInput, datetime: TextInput, time: TextInput,
  textarea: TextArea, duration: Duration, int: NumberInput, decimal: NumberInput, money: Money, bool: Bool, choice: Choice,
  password: Password, json: Json, file: Upload, image: Upload, fk: Fk, m2m: M2m, rich: RichEditor,
  color: I.Color, range: I.Range, phone: I.Phone, search: I.Native, month: I.Native, week: I.Native, ip: I.Native, slugAuto: I.Native,
  tags: I.Tags, checkboxes: I.Checkboxes, switch: I.Switch, segmented: I.Segmented, rating: I.Rating, otp: I.Otp, markdown: I.Markdown,
  code: CodeEditor, daterange: I.DateRange, country: I.Country, address: I.Address, keyvalue: I.KeyValue, signature: I.Signature,
  currency: I.Currency, percent: I.Percent,
  list: (p) => <I.List {...p} widgetFor={(m) => { const W = BUILTIN[m.kind] ?? TextInput; return (q) => <W {...q} /> }} blank={(m) => fromApi(m, undefined)} />,
}

// Read-only display (Django readonly_fields): text, never an input.
export function display(p: FieldWidgetProps): ReactElement {
  const m = p.meta, v = p.value
  let t: string
  switch (m.kind) {
    case 'bool': t = v == null ? '—' : v ? 'Yes' : 'No'; break
    case 'money': t = v?.amount ? `${v.amount} ${v.currency ?? ''}`.trim() : '—'; break
    case 'choice': t = [v].flat().map((x) => m.choices?.find((c) => c.value === x)?.label ?? x).join(', '); break
    case 'fk': t = v?.text ?? '—'; break
    case 'm2m': t = (v ?? []).map((r: SearchResult) => r.text).join(', '); break
    case 'password': t = v ? '••••••••' : '—'; break
    case 'file': case 'image': t = fileName(v); break
    // in the viewer's locale (Django formats read-only dates with the active locale); SSR may differ from the tab
    case 'date': case 'datetime': {
      const d = v ? new Date(m.kind === 'date' ? `${String(v).slice(0, 10)}T00:00:00Z` : v) : undefined
      t = !d || isNaN(+d) ? String(v ?? '') : m.kind === 'date' ? d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      return <div className="tf-readonly" id={p.id} data-part="readonly" suppressHydrationWarning>{t || '—'}</div>
    }
    case 'rich': return <div className="tf-readonly tf-rich-view" id={p.id} dangerouslySetInnerHTML={{ __html: sanitizeHtml(v ?? '') }} />
    case 'markdown': return <div className="tf-readonly tf-rich-view" id={p.id} dangerouslySetInnerHTML={{ __html: markdownToHtml(v ?? '') }} />
    case 'code': return <pre className="tf-readonly tf-code-hl tf-code-ro" id={p.id} dangerouslySetInnerHTML={{ __html: highlight(v ?? '', m.language) }} />
    case 'color': return <div className="tf-readonly" id={p.id} data-part="readonly">{v ? <><span className="tf-palette-dot" style={{ background: v }} aria-hidden="true" /> {v}</> : '—'}</div>
    case 'signature': return <div className="tf-readonly" id={p.id}>{fileUrl(v) ? <img className="tf-preview" src={fileUrl(v)} alt={m.label} /> : v ? 'Signed' : '—'}</div>
    case 'switch': t = v ? 'On' : 'Off'; break
    case 'rating': t = v ? `${'★'.repeat(v)}${'☆'.repeat(Math.max(0, (m.max ?? 5) - v))}` : ''; break
    case 'tags': case 'checkboxes': t = (v ?? []).map((x: string) => m.choices?.find((c) => c.value === x)?.label ?? x).join(', '); break
    case 'segmented': t = m.choices?.find((c) => c.value === v)?.label ?? v ?? ''; break
    case 'range': t = Array.isArray(v) ? v.join(' – ') : String(v ?? ''); break
    case 'percent': t = v === '' || v == null ? '' : `${v} %`; break
    case 'daterange': t = v?.start || v?.end ? `${v.start} – ${v.end}` : ''; break
    case 'country': t = v ? `${countryName(v)} (${v})` : ''; break
    case 'address': t = v ? [v.line1, v.line2, v.city, v.region, v.postal, v.country && countryName(v.country)].filter(Boolean).join(', ') : ''; break
    case 'keyvalue': t = (v ?? []).map((r: { key: string; value: string }) => `${r.key}: ${r.value}`).join('; '); break
    case 'list': t = (v ?? []).map((x: unknown) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(', '); break
    case 'otp': t = v ? '••••••' : ''; break
    default: t = v == null ? '' : String(v)
  }
  return <div className="tf-readonly" id={p.id} data-part="readonly">{t || '—'}</div>
}
