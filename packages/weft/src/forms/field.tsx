'use client'
// <Field meta value onChange error />: label + widget for meta.kind + help + error, registered as the Weft widget
// `field:<name>` (inside <ModelForm name="order">: `form:order > field:<name>`). Agents speak API shape
// (`set({value: 12.5})`, `choose({value: 'paid'})`, `upload({file})`); each control converts with fromApi,
// validates, then calls onChange like a human edit. Passwords are sensitive: the state is `{filled}` only.
import { useId, useRef, type ReactNode } from 'react'
import { useWidget } from '../widget/useWidget.js'
import { WeftError, applyOverrides } from '../widget/hooks.js'
import type { Control, ControlOverrides, Json, ParamSpec, WidgetKind } from '../widget/types.js'
import { AutoOff, flag, part, type SlotProps, type Slots } from '../widgets/_parts.js'
import { fieldWidgetFor } from './registry.js'
import type { FieldKind, FieldMeta, Search, SearchResult } from './types.js'
import { fromApi, subMeta, validateField } from './values.js'
import { docHtml, htmlToMarkdown, parseHtml, parseMarkdown } from './richdoc.js'
import { richFrom } from './rich-editor.js'
import { currencies } from './inputs.js'
import { COUNTRY_CODES, sanitizeHtml } from './rich.js'
import { BUILTIN, display } from './widgets.js'

export type FieldState = { kind: FieldKind; value?: Json; filled?: boolean; invalid?: string }
export type FieldProps = {
  meta: FieldMeta; value: any; onChange(v: any): void
  error?: string; readOnly?: boolean; search?: Search; model?: string
  hideLabel?: boolean                                  // tabular inlines: label kept for screen readers only
  uploadImage?: (file: File) => Promise<string>       // rich: image button
  controls?: ControlOverrides<Record<string, Control>>
  className?: SlotProps<FieldState>['className']; slots?: Slots<'root' | 'label' | 'control' | 'help' | 'error', FieldState>
}

const WKIND: Record<FieldKind, WidgetKind> = {
  text: 'input', email: 'input', url: 'input', slug: 'input', uuid: 'input', int: 'input', decimal: 'input', money: 'input', duration: 'input',
  password: 'input', textarea: 'textarea', json: 'textarea', rich: 'textarea', bool: 'checkbox', date: 'date', datetime: 'date', time: 'date',
  choice: 'select', fk: 'combobox', m2m: 'combobox', file: 'file', image: 'file',
  color: 'input', range: 'slider', phone: 'input', search: 'input', tags: 'list', checkboxes: 'checkbox', switch: 'switch', segmented: 'radio',
  rating: 'rating', otp: 'input', markdown: 'textarea', code: 'textarea', daterange: 'date', month: 'date', week: 'date', country: 'select',
  address: 'input', keyvalue: 'list', list: 'list', signature: 'file', currency: 'select', percent: 'input', ip: 'input', slugAuto: 'input',
}
// what `set` takes, for kinds whose param schema can't say it (read_page shows the label)
const HINT: Partial<Record<FieldKind, (m: FieldMeta) => string>> = {
  rating: (m) => `1 to ${m.max ?? 5}`, percent: (m) => `${m.min ?? 0} to ${m.max ?? 100}`, otp: (m) => `${m.maxLength ?? 6} digits`,
  range: (m) => (m.multiple ? `[min, max] within ${m.min ?? 0}–${m.max ?? 100}` : `${m.min ?? 0} to ${m.max ?? 100}`), month: () => 'YYYY-MM', week: () => 'YYYY-Www',
  color: () => '#rrggbb', phone: () => 'E.164, e.g. +15551234567', daterange: () => '{start, end} YYYY-MM-DD', rich: () => 'markdown or HTML',
  address: () => '{line1, line2?, city, region?, postal?, country}', keyvalue: () => '{key: value}', ip: () => 'IPv4 or IPv6',
}
const SIGN_LOCK = 'a signature must be drawn by a person'
const signLocked = (m: FieldMeta) => m.kind === 'signature' && m.humanOnly !== false
// long text in agent state: first 400 chars + the length (read_page stays compact; `read` gives the whole text)
const CAP = 400
const brief = (s: string) => (s.length > CAP ? `${s.slice(0, CAP)}… (${s.length} chars)` : s)
const bad = (msg: string) => new WeftError('invalid_param', msg, undefined, 'value')
const isFile = (v: unknown): v is File => typeof File !== 'undefined' && v instanceof File

// Agent-visible state: JSON only, files as {name,type,size}, passwords never.
function stateOf(m: FieldMeta, v: any, error?: string): FieldState {
  const s: FieldState = { kind: m.kind }
  if (m.kind === 'password') s.filled = !!v
  else if (m.kind === 'signature') s.filled = !!v
  else if (m.kind === 'rich') s.value = brief(htmlToMarkdown(v ?? ''))      // markdown: what the agent would send back
  else if (m.kind === 'markdown' || m.kind === 'code' || m.kind === 'textarea') s.value = brief(String(v ?? ''))
  else if (m.kind === 'keyvalue') s.value = Object.fromEntries((v ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))
  else s.value = isFile(v) ? { name: v.name, type: v.type, size: v.size } : v === undefined ? null : v
  if (error) s.invalid = error
  return s
}

function paramFor(m: FieldMeta): ParamSpec {
  const opt = !m.required || undefined
  switch (m.kind) {
    case 'int': case 'decimal': case 'money': return { type: 'number', ...(m.min != null && { min: m.min }), ...(m.max != null && { max: m.max }), ...(m.kind === 'int' && { step: 1 }), optional: opt }
    case 'bool': return { type: 'boolean' }
    case 'date': case 'datetime': return { type: 'date' }
    case 'json': return { type: 'json' }
    case 'choice': return { type: 'string', enum: m.choices?.map((c) => c.value), ...(m.multiple && { multiple: true }) }
    case 'm2m': return { type: 'string', multiple: true }
    case 'switch': return { type: 'boolean' }
    // inputs pack: bounds / formats are checked by validateField so agents get the human message (the label says the range)
    case 'percent': case 'rating': return { type: 'number', optional: opt }
    case 'range': return m.multiple ? { type: 'json' } : { type: 'number', optional: opt }
    case 'tags': case 'checkboxes': return { type: 'string', multiple: true, ...(m.choices && !(m.kind === 'tags' && m.free) && { enum: m.choices.map((c) => c.value) }) }
    case 'segmented': return { type: 'string', enum: m.choices?.map((c) => c.value), optional: opt }
    case 'country': return { type: 'string', enum: COUNTRY_CODES, optional: opt }
    case 'currency': return { type: 'string', enum: currencies(m), optional: opt }
    case 'daterange': case 'address': case 'keyvalue': case 'list': return { type: 'json', optional: opt }
    default: return { type: 'string', ...(m.maxLength != null && m.kind !== 'rich' && { maxLength: m.maxLength }), ...(m.kind === 'password' && { secret: true }) }
  }
}

function controlsFor(m: FieldMeta, value: any, apply: (v: any) => void, seen: Map<string, SearchResult>, search?: Search): Record<string, Control<any, any>> {
  const commit = (v: any) => { const e = validateField(m, v); if (e) throw bad(e); apply(v) }
  const c: Record<string, Control<any, any>> = {
    set: {
      kind: 'set', ...(HINT[m.kind] && { label: HINT[m.kind]!(m) }),
      params: { value: paramFor(m), ...(m.kind === 'money' && !m.currency && { currency: { type: 'string', optional: true } }),
        ...(m.kind === 'rich' && { format: { type: 'string', enum: ['markdown', 'html'], optional: true } }) },
      run: (a: { value: unknown; currency?: string }) => {
        if (m.kind === 'file' || m.kind === 'image') throw bad('use upload({file}) for files')
        if (m.kind === 'rich') return commit(richFrom(String(a.value ?? ''), (a as { format?: 'html' | 'markdown' }).format))
        commit(fromApi(m, m.kind === 'money' ? { value: a.value, currency: a.currency ?? value?.currency ?? m.currency } : m.kind === 'json' ? a.value ?? null : a.value))
      },
    },
    clear: { kind: 'clear', run: () => apply(fromApi(m, null)) },
  }
  if (m.kind === 'choice') c.choose = { kind: 'select', params: { value: paramFor(m) }, run: (a: { value: string | string[] }) => commit(fromApi(m, a.value)) }
  inputsControls(m, value, c, commit, apply)
  const listed = m.relation && !m.relation.autocomplete && m.choices   // a <select>: choose from the listed rows, no search
  if ((m.kind === 'fk' || m.kind === 'm2m') && search && !listed) {
    c.search = { kind: 'input', params: { q: { type: 'string' }, page: { type: 'number', min: 1, optional: true } },
      run: async (a: { q: string; page?: number }) => {
        const r = await search(a.q ?? '', a.page ?? 1)
        for (const x of r.results) seen.set(x.pk, x)
        return r as unknown as Json
      } }
  }
  const ref = (pk: string): SearchResult => seen.get(String(pk)) ?? { pk: String(pk), text: m.choices?.find((x) => x.value === String(pk))?.label ?? String(pk) }
  const relParam = { type: 'string' as const, ...(listed && { enum: m.choices!.map((x) => x.value) }) }
  if (m.kind === 'fk') c.choose = { kind: 'select', params: { value: relParam }, run: (a: { value: string }) => commit(ref(a.value)) }
  if (m.kind === 'm2m') {
    const cur = (value ?? []) as SearchResult[]
    c.add = { kind: 'select', params: { value: relParam }, run: (a: { value: string }) => { if (!cur.some((x) => x.pk === String(a.value))) commit([...cur, ref(a.value)]) } }
    if (cur.length) c.remove = { kind: 'clear', params: { value: { type: 'string', enum: cur.map((x) => x.pk) } }, run: (a: { value: string }) => commit(cur.filter((x) => x.pk !== String(a.value))) }
  }
  if (m.kind === 'file' || m.kind === 'image') {
    c.upload = { kind: 'upload', params: { file: { type: 'file' } }, run: (a: { file: { name: string; type: string; dataBase64: string } }) => {
      const f = a.file
      if (!f || typeof f.name !== 'string' || typeof f.dataBase64 !== 'string') throw new WeftError('invalid_param', 'file: {name, type, dataBase64}', undefined, 'file')
      let bytes: Uint8Array
      try { bytes = Uint8Array.from(atob(f.dataBase64), (ch) => ch.charCodeAt(0)) } catch { throw new WeftError('invalid_param', 'dataBase64 is not valid base64', undefined, 'file') }
      commit(new File([bytes as BlobPart], f.name, { type: f.type ?? '' }))
    } }
  }
  return c
}

// Inputs pack verbs (forms.md table): toggle, choose, add/remove, append, read. All go through commit (= validate,
// then onChange), so an agent gets exactly the message a human sees.
function inputsControls(m: FieldMeta, value: any, c: Record<string, Control<any, any>>, commit: (v: any) => void, apply: (v: any) => void) {
  const k = m.kind
  if (k === 'switch') c.toggle = { kind: 'toggle', run: () => commit(!value) }
  if (k === 'segmented' || k === 'country' || k === 'currency') c.choose = { kind: 'select', params: { value: paramFor(m) }, run: (a: { value: string }) => commit(String(a.value ?? '')) }
  if (k === 'tags' || k === 'checkboxes') {
    const cur: string[] = value ?? [], one = { ...paramFor(m), multiple: undefined }
    c.add = { kind: 'select', params: { value: one }, run: (a: { value: string }) => { const t = String(a.value ?? '').trim(); if (!t) throw bad('value is empty'); if (!cur.includes(t)) commit([...cur, t]) } }
    if (cur.length) c.remove = { kind: 'clear', params: { value: { type: 'string', enum: cur } }, run: (a: { value: string }) => commit(cur.filter((x) => x !== a.value)) }
    if (k === 'checkboxes') c.toggle = { kind: 'toggle', params: { value: one }, run: (a: { value: string }) => commit(cur.includes(a.value) ? cur.filter((x) => x !== a.value) : [...cur, a.value]) }
  }
  if (k === 'keyvalue') {
    const rows: { key: string; value: string }[] = value ?? []
    c.add = { kind: 'set', label: 'Add or replace a key', params: { key: { type: 'string' }, value: { type: 'string' } }, run: (a: { key: string; value: string }) => {
      const key = String(a.key ?? '').trim(); if (!key) throw bad('Each row needs a key.')
      const i = rows.findIndex((r) => r.key.trim() === key), row = { key, value: String(a.value ?? '') }
      commit(i < 0 ? [...rows, row] : rows.map((r, j) => (j === i ? row : r)))
    } }
    if (rows.length) c.remove = { kind: 'clear', params: { key: { type: 'string', enum: rows.map((r) => r.key) } }, run: (a: { key: string }) => commit(rows.filter((r) => r.key !== a.key)) }
  }
  if (k === 'list') {
    const vs: unknown[] = value ?? [], sm = subMeta(m)
    c.add = { kind: 'set', params: { value: paramFor(sm) }, run: (a: { value: unknown }) => commit([...vs, fromApi(sm, a.value)]) }
    if (vs.length) c.remove = { kind: 'clear', params: { index: { type: 'number', min: 0, max: vs.length - 1, step: 1 } }, run: (a: { index: number }) => commit(vs.filter((_, i) => i !== Number(a.index))) }
  }
  if (k === 'rich' || k === 'markdown') {
    c.append = { kind: 'input', params: { markdown: { type: 'string' } }, run: (a: { markdown: string }) => {
      const add = String(a.markdown ?? '')
      if (k === 'markdown') return commit(value ? `${value}\n\n${add}` : add)
      commit(docHtml([...parseHtml(sanitizeHtml(value ?? '')), ...parseMarkdown(add)]))
    } }
  }
  if (k === 'rich') c.read = { kind: 'focus', label: 'Whole text as markdown', run: () => htmlToMarkdown(value ?? '') as Json }
  if (k === 'code' || k === 'markdown') c.read = { kind: 'focus', label: 'Whole text', run: () => String(value ?? '') as Json }
  if (k === 'signature') { delete c.set; c.clear = { kind: 'clear', run: () => apply(null) } }
}

export function Field(props: FieldProps) {
  const { meta: m, value, onChange, error, search, model, hideLabel, className, slots } = props
  const readOnly = !!(props.readOnly || m.readOnly)
  const seen = useRef(new Map<string, SearchResult>())   // search results an agent saw, so choose/add keep their text
  const s = stateOf(m, value, error)
  // Several steps in one `ui` call run before React re-renders: each run rebuilds its control from the LATEST value
  // (what the previous step set), so add + add keeps both.
  const latest = useRef(value); latest.current = value
  const build = () => controlsFor(m, latest.current, (v) => { latest.current = v; onChange(v) }, seen.current, search)
  const fresh = () => Object.fromEntries(Object.entries(build()).map(([k, c]) => [k, { ...c, run: (a: any, ctx: any) => {
    const now = build()[k]
    if (!now) throw bad(`${k} is not available now`)
    return now.run(a, ctx)
  } }]))
  const w = useWidget<FieldState>({
    id: `field:${m.name}`, name: m.name, kind: WKIND[m.kind] ?? 'input', label: m.label || m.name, state: s,
    ...(m.help && { summary: [m.help] }), sensitive: m.kind === 'password', disabled: readOnly, changesContent: true,
    ...(signLocked(m) && { humanOnly: SIGN_LOCK }),
    controls: readOnly ? {} : applyOverrides(fresh(), props.controls),
  })
  const uid = useId(), id = `${uid}-f`
  const describedBy = [m.help && `${uid}-h`, error && `${uid}-e`].filter(Boolean).join(' ') || undefined
  const W = fieldWidgetFor(m.kind, model, m.name) ?? BUILTIN[m.kind] ?? BUILTIN.text
  const wp = { meta: m, value, onChange, id, name: m.name, invalid: !!error, describedBy, readOnly, search, model, uploadImage: props.uploadImage }
  const label: ReactNode = <>{m.label}{m.required && !readOnly && <span className="tf-req" aria-hidden="true"> *</span>}</>
  return part('div', {
    ref: w.ref, ...w.props, className: 'tf-field', 'data-tvine-widget': 'field', 'data-kind': m.kind,
    'data-invalid': flag(error), 'data-required': flag(m.required), 'data-readonly': flag(readOnly),
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part(m.kind === 'choice' && !m.multiple && (m.choices?.length ?? 0) <= 4 && !readOnly ? 'span' : 'label',
        { htmlFor: id, id: `${uid}-l`, className: hideLabel ? 'tf-label tf-sr-only' : 'tf-label' }, slots?.label, s, label)}
      {part('div', { className: 'tf-control', 'aria-labelledby': undefined }, slots?.control, s, readOnly ? display(wp) : <W {...wp} />)}
      {m.help && part('p', { id: `${uid}-h`, className: 'tf-hint' }, slots?.help, s, m.help)}
      {error && part('p', { id: `${uid}-e`, className: 'tf-hint tf-hint-error', role: 'alert' }, slots?.error, s, error)}
    </AutoOff>
  </>)
}
