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
import { fromApi, validateField } from './values.js'
import { BUILTIN, display } from './widgets.js'

export type FieldState = { kind: FieldKind; value?: Json; filled?: boolean; invalid?: string }
export type FieldProps = {
  meta: FieldMeta; value: any; onChange(v: any): void
  error?: string; readOnly?: boolean; search?: Search; model?: string
  hideLabel?: boolean                                  // tabular inlines: label kept for screen readers only
  controls?: ControlOverrides<Record<string, Control>>
  className?: SlotProps<FieldState>['className']; slots?: Slots<'root' | 'label' | 'control' | 'help' | 'error', FieldState>
}

const WKIND: Record<FieldKind, WidgetKind> = {
  text: 'input', email: 'input', url: 'input', slug: 'input', uuid: 'input', int: 'input', decimal: 'input', money: 'input', duration: 'input',
  password: 'input', textarea: 'textarea', json: 'textarea', rich: 'textarea', bool: 'checkbox', date: 'date', datetime: 'date', time: 'date',
  choice: 'select', fk: 'combobox', m2m: 'combobox', file: 'file', image: 'file',
}
const bad = (msg: string) => new WeftError('invalid_param', msg, undefined, 'value')
const isFile = (v: unknown): v is File => typeof File !== 'undefined' && v instanceof File

// Agent-visible state: JSON only, files as {name,type,size}, passwords never.
function stateOf(m: FieldMeta, v: any, error?: string): FieldState {
  const s: FieldState = { kind: m.kind }
  if (m.kind === 'password') s.filled = !!v
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
    default: return { type: 'string', ...(m.maxLength != null && { maxLength: m.maxLength }), ...(m.kind === 'password' && { secret: true }) }
  }
}

function controlsFor(m: FieldMeta, value: any, apply: (v: any) => void, seen: Map<string, SearchResult>, search?: Search): Record<string, Control<any, any>> {
  const commit = (v: any) => { const e = validateField(m, v); if (e) throw bad(e); apply(v) }
  const c: Record<string, Control<any, any>> = {
    set: {
      kind: 'set',
      params: { value: paramFor(m), ...(m.kind === 'money' && !m.currency && { currency: { type: 'string', optional: true } }) },
      run: (a: { value: unknown; currency?: string }) => {
        if (m.kind === 'file' || m.kind === 'image') throw bad('use upload({file}) for files')
        commit(fromApi(m, m.kind === 'money' ? { value: a.value, currency: a.currency ?? value?.currency ?? m.currency } : m.kind === 'json' ? a.value ?? null : a.value))
      },
    },
    clear: { kind: 'clear', run: () => apply(fromApi(m, null)) },
  }
  if (m.kind === 'choice') c.choose = { kind: 'select', params: { value: paramFor(m) }, run: (a: { value: string | string[] }) => commit(fromApi(m, a.value)) }
  if ((m.kind === 'fk' || m.kind === 'm2m') && search) {
    c.search = { kind: 'input', params: { q: { type: 'string' }, page: { type: 'number', min: 1, optional: true } },
      run: async (a: { q: string; page?: number }) => {
        const r = await search(a.q ?? '', a.page ?? 1)
        for (const x of r.results) seen.set(x.pk, x)
        return r as unknown as Json
      } }
  }
  const ref = (pk: string): SearchResult => seen.get(String(pk)) ?? { pk: String(pk), text: String(pk) }
  if (m.kind === 'fk') c.choose = { kind: 'select', params: { value: { type: 'string' } }, run: (a: { value: string }) => commit(ref(a.value)) }
  if (m.kind === 'm2m') {
    const cur = (value ?? []) as SearchResult[]
    c.add = { kind: 'select', params: { value: { type: 'string' } }, run: (a: { value: string }) => { if (!cur.some((x) => x.pk === String(a.value))) commit([...cur, ref(a.value)]) } }
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

export function Field(props: FieldProps) {
  const { meta: m, value, onChange, error, search, model, hideLabel, className, slots } = props
  const readOnly = !!(props.readOnly || m.readOnly)
  const seen = useRef(new Map<string, SearchResult>())   // search results an agent saw, so choose/add keep their text
  const s = stateOf(m, value, error)
  const w = useWidget<FieldState>({
    id: `field:${m.name}`, name: m.name, kind: WKIND[m.kind] ?? 'input', label: m.label || m.name, state: s,
    ...(m.help && { summary: [m.help] }), sensitive: m.kind === 'password', disabled: readOnly, changesContent: true,
    controls: readOnly ? {} : applyOverrides(controlsFor(m, value, onChange, seen.current, search), props.controls),
  })
  const uid = useId(), id = `${uid}-f`
  const describedBy = [m.help && `${uid}-h`, error && `${uid}-e`].filter(Boolean).join(' ') || undefined
  const W = fieldWidgetFor(m.kind, model, m.name) ?? BUILTIN[m.kind] ?? BUILTIN.text
  const wp = { meta: m, value, onChange, id, name: m.name, invalid: !!error, describedBy, readOnly, search, model }
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
