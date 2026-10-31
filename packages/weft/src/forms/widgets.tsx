'use client'
// One built-in widget per FieldKind, on native elements. Each gets FieldWidgetProps (form-shape value).
// Classes are `tf-*` (forms.css); every part also carries data-attributes for Tailwind (`data-[invalid]:…`).
import { useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import type { FieldKind, FieldWidget, FieldWidgetProps, SearchResult } from './types.js'
import { countryName, sanitizeHtml } from './rich.js'
import { RichEditor } from './rich-editor.js'
import { CodeEditor, highlight } from './code.js'
import { markdownToHtml } from './richdoc.js'
import { fromApi, validateField } from './values.js'
import { Dropdown, FileDrop, MultiSelect, type Opt } from './select.js'
import * as I from './inputs.js'

const common = (p: FieldWidgetProps) => ({
  id: p.id, name: p.name, disabled: p.readOnly, required: p.meta.required,
  'aria-invalid': p.invalid || undefined, 'aria-describedby': p.describedBy,
})
const ev = (f: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => f(e.target.value)

const INPUT_TYPE: Partial<Record<FieldKind, string>> = { text: 'text', email: 'email', url: 'url', slug: 'text', uuid: 'text', date: 'date', datetime: 'datetime-local', time: 'time' }

// prefix / suffix inside the box (FieldMeta.prefix / suffix) and a live "12 / 200" counter for text with a max
function Adorn({ m, children }: { m: FieldWidgetProps['meta']; children: ReactNode }) {
  if (!m.prefix && !m.suffix) return <>{children}</>
  return <div className="tf-adorn" data-part="adorn">{m.prefix && <span className="tf-affix">{m.prefix}</span>}{children}{m.suffix && <span className="tf-affix">{m.suffix}</span>}</div>
}
const COUNTED = new Set<FieldKind>(['text', 'textarea'])
const Counter = ({ p }: { p: FieldWidgetProps }) => p.meta.maxLength && COUNTED.has(p.meta.kind) && !p.readOnly
  ? <span className="tf-counter" data-over={String(p.value ?? '').length > p.meta.maxLength ? '' : undefined} aria-hidden="true">{String(p.value ?? '').length} / {p.meta.maxLength}</span> : null

function TextInput(p: FieldWidgetProps) {
  const m = p.meta
  return <><Adorn m={m}><input className="tf-input" type={INPUT_TYPE[m.kind] ?? 'text'} value={p.value ?? ''} onChange={ev(p.onChange)} maxLength={m.maxLength}
    spellCheck={m.kind === 'slug' || m.kind === 'uuid' ? false : undefined} placeholder={m.kind === 'uuid' ? '00000000-0000-0000-0000-000000000000' : undefined}
    autoComplete={m.kind === 'email' ? 'email' : m.kind === 'url' ? 'url' : undefined} {...common(p)} /></Adorn><Counter p={p} /></>
}
function Duration(p: FieldWidgetProps) {
  return <input className="tf-input" type="text" inputMode="numeric" placeholder="HH:MM:SS" pattern="(\d+ )?\d+:[0-5]?\d(:[0-5]?\d)?" value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} />
}
function TextArea(p: FieldWidgetProps) {
  return <><textarea className="tf-input tf-textarea" rows={4} value={p.value ?? ''} onChange={ev(p.onChange)} maxLength={p.meta.maxLength} {...common(p)} /><Counter p={p} /></>
}
const step = (d?: number) => (d == null ? 'any' : d === 0 ? '1' : `0.${'0'.repeat(d - 1)}1`)
function NumberInput(p: FieldWidgetProps) {
  const m = p.meta
  return <Adorn m={m}><input className="tf-input" type="number" inputMode={m.kind === 'int' ? 'numeric' : 'decimal'} step={m.kind === 'int' ? 1 : step(m.decimals)}
    min={m.min} max={m.max} value={p.value ?? ''} onChange={ev(p.onChange)} {...common(p)} /></Adorn>
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
  return <input className="tf-check tf-toggle" type="checkbox" role="switch" checked={!!p.value} onChange={(e) => p.onChange(e.target.checked)} {...common(p)} required={false} />
}

// choices → a dropdown (radios only when the developer asks: ModelAdmin.widgets = { status: 'segmented' })
const sel = (p: FieldWidgetProps) => ({ id: p.id, name: p.name, label: p.meta.label, describedBy: p.describedBy, invalid: p.invalid, disabled: p.readOnly, required: p.meta.required })
const opts = (p: FieldWidgetProps): Opt[] => p.meta.choices ?? []
function Choice(p: FieldWidgetProps) {
  const m = p.meta, cs = opts(p)
  if (m.multiple) {
    const vs: string[] = p.value ?? []
    return <MultiSelect {...sel(p)} options={cs} max={m.max} value={vs.map((v) => cs.find((c) => c.value === v) ?? { value: v, label: v })} onChange={(v) => p.onChange(v.map((o) => o.value))} />
  }
  return <Dropdown {...sel(p)} options={cs} value={cs.find((c) => c.value === p.value) ?? null} onChange={(o) => p.onChange(o?.value ?? '')} />
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
    <CodeEditor {...p} meta={{ ...p.meta, language: 'json' }} invalid={p.invalid || !!err} />
    {err && <p className="tf-hint tf-hint-error" data-part="json-error">JSON: {err}</p>}
  </div>
}

// ---- files ----
const isFile = (v: unknown): v is File => typeof File !== 'undefined' && v instanceof File
const fileName = (v: any): string => isFile(v) ? v.name : typeof v === 'string' ? v.split('/').pop()! : v?.name ?? v?.url ?? ''
const fileUrl = (v: any): string | undefined => typeof v === 'string' ? v : v?.url
function Upload(p: FieldWidgetProps) {
  const m = p.meta, img = m.kind === 'image'
  return <FileDrop {...sel(p)} image={img} accept={m.upload?.accept ?? (img ? 'image/*' : undefined)} maxBytes={m.upload?.maxBytes}
    value={p.value} onChange={p.onChange} check={(f) => validateField(m, f)} />
}

// ---- fk / m2m: a searchable dropdown / multi-select over the listed rows (FieldMeta.choices) or async search(q, page) ----
const toRef = (o: Opt): SearchResult => ({ pk: o.value, text: o.label })
const toOpt = (r: SearchResult): Opt => ({ value: r.pk, label: r.text })
const listed = (p: FieldWidgetProps) => (p.meta.relation && !p.meta.relation.autocomplete && p.meta.choices) || undefined
// a stored value carries only the pk until the server labels it: take the label from the listed rows
const labelled = (r: SearchResult, choices?: Opt[]): Opt => choices?.find((c) => c.value === String(r.pk)) ?? toOpt(r)
function Fk(p: FieldWidgetProps) {
  const v = p.value as SearchResult | null, choices = listed(p)
  if (p.meta.relation?.rawId || (!choices && !p.search)) {   // Django raw_id_fields: type the pk
    return <input className="tf-input" type="text" inputMode="numeric" value={v?.pk ?? ''} placeholder="id"
      onChange={(e) => p.onChange(e.target.value ? { pk: e.target.value, text: e.target.value } : null)} {...common(p)} />
  }
  return <div data-part="fk"><Dropdown {...sel(p)} options={choices} search={choices ? undefined : p.search} placeholder={choices ? 'Select…' : 'Search…'}
    value={v ? labelled(v, choices) : null} onChange={(o) => p.onChange(o ? toRef(o) : null)} /></div>
}
function M2m(p: FieldWidgetProps) {
  const vs = (p.value ?? []) as SearchResult[], choices = listed(p)
  if (!choices && !p.search) {
    return <input className="tf-input" type="text" placeholder="ids, comma separated" defaultValue={vs.map((r) => r.pk).join(',')} {...common(p)}
      onBlur={(e) => p.onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((pk) => ({ pk, text: pk })))} />
  }
  return <div data-part="m2m"><MultiSelect {...sel(p)} options={choices} search={choices ? undefined : p.search} max={p.meta.max}
    value={vs.map((r) => labelled(r, choices))} onChange={(v) => p.onChange(v.map(toRef))} /></div>
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
