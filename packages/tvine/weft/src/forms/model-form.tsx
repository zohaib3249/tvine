'use client'
// <ModelForm form={ModelMeta.form} values onSubmit errors />: Django ModelForm/admin change form from field meta.
// Weft widget `form:<name>`; fields are `form:<name> > field:<f>`, inline rows `form:<name> > inline:<i> > row:<key> > field:<f>`.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useWidget } from '../widget/useWidget.js'
import type { Control, HeadlessMap, Json } from '../widget/types.js'
import { WeftError } from '../widget/hooks.js'
import { flag, part, type SlotProps, type Slots } from '../widgets/_parts.js'
import { Field } from './field.js'
import type { FieldMeta, FormMeta, InlineMeta, Row, Search, SearchResult } from './types.js'
import { fromApi, inlineFields, mapServerErrors, toPayload, validate } from './values.js'

export type FormSearch = (a: { model?: string; field: string; q: string; page: number }) => Promise<{ results: SearchResult[]; more: boolean }>
export type FormSubmit = (payload: ReturnType<typeof toPayload>, form: { values: Record<string, any>; inlines: Record<string, Row[]> }) => unknown
export type ModelFormState = { isDirty: boolean; submitting: boolean; submit(): void; reset(): void; errors: Record<string, string> }
export type ModelFormProps = {
  form: FormMeta
  values?: Record<string, unknown>                              // API shape (admin.get values)
  inlines?: Record<string, Row[] | { rows: Row[] }>              // API shape (admin.get inlines)
  onSubmit: FormSubmit                                           // a rejection is mapped like `errors`
  errors?: unknown                                               // server errors (see mapServerErrors)
  readOnly?: boolean
  layout?: 'stacked' | 'aligned'                                 // aligned = label beside input (Django admin) on wide screens
  name?: string; label?: string; model?: string                  // widget id form:<name>; model 'app.model' for overrides/search
  search?: FormSearch
  uploadImage?: (file: File, field: string) => Promise<string>    // rich text image button: upload, return the URL
  call?: { id: string; args?: Record<string, Json> }             // headless parity: submit = `do <id>` with args + values
  onDirtyChange?(dirty: boolean): void
  actions?: ReactNode | ((s: ModelFormState) => ReactNode)        // submit-row slot; default: one Save button
  top?: ReactNode | ((s: ModelFormState) => ReactNode)           // e.g. saveOnTop
  className?: SlotProps<ModelFormState>['className']
  slots?: Slots<'root' | 'banner' | 'fieldset' | 'legend' | 'actions' | 'inline', ModelFormState>
}

const fileSafe = (_k: string, v: unknown) => (typeof File !== 'undefined' && v instanceof File ? `file:${v.name}:${v.size}:${v.lastModified}` : v)
const same = (a: unknown, b: unknown) => JSON.stringify(a, fileSafe) === JSON.stringify(b, fileSafe)
const formValues = (fields: Record<string, FieldMeta>, api: Record<string, unknown> = {}, useDefaults = false) =>
  Object.fromEntries(Object.entries(fields).map(([n, m]) => [n, fromApi(m, n in api ? api[n] : useDefaults ? m.default : undefined)]))

let nextKey = 0
const newRow = (im: InlineMeta): Row => ({ ...formValues(inlineFields(im.meta), {}, true), _key: `new${++nextKey}`, _new: true })
function initialRows(im: InlineMeta, given?: Row[] | { rows: Row[] }): Row[] {
  const fs = inlineFields(im.meta)
  const rows: Row[] = (Array.isArray(given) ? given : given?.rows ?? []).map((r) => ({ ...formValues(fs, r), pk: r.pk, _key: `pk${r.pk}` }))
  for (let i = 0; i < im.extra && rows.length < im.max; i++) rows.push(newRow(im))
  while (rows.length < im.min) rows.push(newRow(im))
  return rows
}
// Django ignores an untouched extra form; a deleted new row is simply dropped.
const live = (rows: Row[]) => rows.filter((r) => !(r._new && (!r._touched || r.DELETE)))

export const slugify = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 50)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)   // Django capfirst

export function ModelForm(props: ModelFormProps) {
  const { form, onSubmit, readOnly, layout = 'stacked', name = 'model', model, search, call, actions, top, className, slots } = props
  const init = useMemo(() => formValues(form.fields, props.values), [form, props.values])
  const initInl = useMemo(() => Object.fromEntries((form.inlines ?? []).map((im) => [im.name, initialRows(im, props.inlines?.[im.name])])), [form, props.inlines])
  const [values, setValues] = useState(init)
  const [inl, setInl] = useState<Record<string, Row[]>>(initInl)
  const [base, setBase] = useState({ init, initInl })
  if (base.init !== init || base.initInl !== initInl) { setBase({ init, initInl }); setValues(init); setInl(initInl) }   // new record loaded
  const [tried, setTried] = useState(false)
  const [server, setServer] = useState(() => mapServerErrors(props.errors))
  useEffect(() => { setServer(mapServerErrors(props.errors)) }, [props.errors])
  const [submitting, setSubmitting] = useState(false)

  const isDirty = !same(values, init) || !same(inl, initInl)
  const dirtyCb = useRef(props.onDirtyChange); dirtyCb.current = props.onDirtyChange
  useEffect(() => { dirtyCb.current?.(isDirty) }, [isDirty])

  const client = tried ? validate(form.fields, values) : {}
  const inlineClient: Record<string, string> = {}
  if (tried) for (const im of form.inlines ?? []) {
    const fs = Object.fromEntries(im.fields.map((f) => [f, inlineFields(im.meta)[f]!]).filter(([, m]) => m))
    ;(inl[im.name] ?? []).forEach((r, i) => { if (live([r]).length && !r.DELETE) for (const [f, e] of Object.entries(validate(fs, r))) inlineClient[`${im.name}.${i}.${f}`] = e })
  }
  const errors: Record<string, string> = { ...server.fields, ...inlineClient, ...client }

  const setField = (n: string, v: unknown) => {
    setValues((s) => {
      const next = { ...s, [n]: v }
      // Django prepopulated_fields: a slugAuto field follows its source until someone edits it away from the generated slug
      for (const [k, f] of Object.entries(form.fields)) if (f.kind === 'slugAuto' && f.from === n && (!s[k] || s[k] === slugify(String(s[n] ?? '')))) next[k] = slugify(String(v ?? ''))
      return next
    })
    if (server.fields[n]) setServer((s) => { const f = { ...s.fields }; delete f[n]; return { ...s, fields: f } })
  }
  const submitRef = useRef<() => Promise<unknown>>(async () => undefined)
  submitRef.current = async () => {
    setTried(true)
    const live2 = Object.fromEntries(Object.entries(inl).map(([k, rs]) => [k, live(rs)]))
    const bad = Object.keys(validate(form.fields, values)).length || Object.keys(inlineClient).length
      || (form.inlines ?? []).some((im) => (live2[im.name] ?? []).some((r) => !r.DELETE && Object.keys(validate(Object.fromEntries(im.fields.map((f) => [f, inlineFields(im.meta)[f]!]).filter(([, m]) => m)), r)).length))
    if (bad) return { ok: false, code: 'invalid_param', message: 'Please correct the errors below.' }
    setSubmitting(true)
    try {
      const r = await onSubmit(toPayload(form, values, live2), { values, inlines: live2 })
      setServer({ fields: {}, nonField: [] })
      return r
    } catch (e) {
      const mapped = mapServerErrors(e)
      // Server row indexes are positions in the SENT rows; map them back to this form's rows.
      for (const k of Object.keys(mapped.fields)) {
        const m = /^([^.]+)\.(\d+)\.(.+)$/.exec(k), rows = m && inl[m[1]!]
        if (m && rows) { const sent = rows.filter((r) => live([r]).length), i = rows.indexOf(sent[+m[2]!]!); if (i >= 0 && String(i) !== m[2]) { mapped.fields[`${m[1]}.${i}.${m[3]}`] = mapped.fields[k]!; delete mapped.fields[k] } }
      }
      setServer(mapped)
      throw e
    } finally { setSubmitting(false) }
  }
  const reset = () => { setValues(init); setInl(initInl); setTried(false); setServer({ fields: {}, nonField: [] }) }
  const banner = [...server.nonField, ...(tried && Object.keys(errors).length ? ['Please correct the errors below.'] : [])]
  const st: ModelFormState = { isDirty, submitting, submit: () => { void submitRef.current().catch(() => {}) }, reset, errors }

  const controls: Record<string, Control<any, any>> = readOnly ? {} : {
    submit: { kind: 'submit', label: 'Save', run: async () => {
      let r: unknown
      try { r = await submitRef.current() } catch (e) {
        if (e instanceof WeftError) throw e
        const m = mapServerErrors(e), [f, msg] = Object.entries(m.fields)[0] ?? [undefined, m.nonField.join(' ')]
        throw new WeftError('invalid_param', msg || 'submit failed', undefined, f)
      }
      if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === false) throw new WeftError('invalid_param', (r as { message: string }).message)
      return (r ?? { ok: true }) as Json
    }, ...(call && { headless: { call: call.id, ...(call.args && { args: call.args }) } satisfies HeadlessMap }) },
    reset: { kind: 'clear', label: 'Reset', run: () => reset() },
  }
  const w = useWidget<Json>({
    id: `form:${name}`, name, kind: 'form', label: props.label ?? name, controls,
    state: { dirty: isDirty, ...(submitting && { pending: true }), ...(Object.keys(errors).length && { errors }), ...(banner.length && { banner }) },
  })
  const fieldSearch = (f: FieldMeta, mdl?: string): Search | undefined => search && f.relation ? (q, page) => search({ model: mdl, field: f.name, q, page }) : undefined
  const field = (n: string) => {
    const m = form.fields[n]
    if (!m) return null
    return <Field key={n} meta={m} value={values[n]} onChange={(v) => setField(n, v)} error={errors[n]} readOnly={readOnly} model={model} search={fieldSearch(m, model)}
      uploadImage={props.uploadImage && ((f: File) => props.uploadImage!(f, n))} />
  }
  const sets = form.fieldsets.length ? form.fieldsets : [{ title: null, fields: Object.keys(form.fields) }]
  const slot = (x: ReactNode | ((s: ModelFormState) => ReactNode)) => (typeof x === 'function' ? (x as (s: ModelFormState) => ReactNode)(st) : x)
  const defaultActions = !readOnly && <button type="submit" className="tf-btn tf-btn-primary" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</button>

  return <w.Scope>
    {part('form', {
      ref: w.ref, ...w.props, className: 'tf-form', 'data-tvine-widget': 'form', 'data-layout': layout, noValidate: true,
      'data-dirty': flag(isDirty), 'data-pending': flag(submitting), 'data-invalid': flag(banner.length), 'aria-busy': submitting || undefined,
      onSubmit: (e: FormEvent) => { e.preventDefault(); st.submit() },
    }, { className, ...slots?.root }, st, <>
      {w.embed}
      {top !== undefined && part('div', { className: 'tf-actions tf-actions-top' }, slots?.actions, st, slot(top))}
      {banner.length > 0 && part('div', { className: 'tf-banner', role: 'alert' }, slots?.banner, st, banner.map((b, i) => <p key={i}>{b}</p>))}
      {sets.map((fs, i) => <Fieldset key={fs.title ?? i} title={fs.title} classes={fs.classes} invalid={fs.fields.some((f) => errors[f])} slots={slots} st={st}>
        {fs.fields.map(field)}
      </Fieldset>)}
      {(form.inlines ?? []).map((im) => <InlineFormset key={im.name} meta={im} rows={inl[im.name] ?? []} readOnly={readOnly}
        onChange={(rows) => setInl((s) => ({ ...s, [im.name]: rows }))} search={search && ((a) => search({ ...a, model: im.model }))}
        errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`${im.name}.`)).map(([k, v]) => [k.slice(im.name.length + 1), v]))}
        className={slots?.inline?.className as string | undefined} />)}
      {part('div', { className: 'tf-actions' }, slots?.actions, st, actions === undefined ? defaultActions : slot(actions))}
    </>)}
  </w.Scope>
}

// Django fieldset; classes ['collapse'] → native <details> (opens itself when it holds an error).
export function Fieldset(p: { title?: string | null; classes?: string[]; invalid?: boolean; children: ReactNode; slots?: ModelFormProps['slots']; st?: ModelFormState; description?: string }) {
  const collapse = p.classes?.includes('collapse'), cls = ['tf-fieldset', ...(p.classes ?? []).map((c) => `tf-fs-${c}`)].join(' ')
  const st = p.st ?? ({} as ModelFormState)
  if (collapse) {
    return part('details', { className: cls, 'data-collapse': '', 'data-invalid': flag(p.invalid), open: p.invalid || undefined }, p.slots?.fieldset, st, <>
      {part('summary', { className: 'tf-legend' }, p.slots?.legend, st, p.title ?? 'Details')}
      <div className="tf-fields">{p.children}</div>
    </>)
  }
  return part('fieldset', { className: cls, 'data-invalid': flag(p.invalid) }, p.slots?.fieldset, st, <>
    {p.title && part('legend', { className: 'tf-legend' }, p.slots?.legend, st, p.title)}
    {p.description && <p className="tf-hint">{p.description}</p>}
    <div className="tf-fields">{p.children}</div>
  </>)
}

// <InlineFormset>: rows in FORM shape (pk, DELETE, _key, _new, _touched). Errors keyed `<rowIndex>.<field>`
// (and `<rowIndex>` for a row's non-field error). Weft widget `inline:<name>` with add / remove({row}).
export type InlineFormsetProps = {
  meta: InlineMeta; rows: Row[]; onChange(rows: Row[]): void
  kind?: 'tabular' | 'stacked'; errors?: Record<string, string>; readOnly?: boolean; search?: FormSearch; className?: string
}
export function InlineFormset(p: InlineFormsetProps) {
  const { meta: im, rows, onChange, errors = {}, readOnly } = p
  const kind = p.kind ?? im.kind
  const fs = inlineFields(im.meta), cols = im.fields.filter((f) => fs[f])
  const kept = rows.filter((r) => !r.DELETE).length
  const canAdd = !readOnly && rows.length < (im.max ?? Infinity)   // null = no limit
  const canRemove = (r: Row) => !readOnly && (r._new || im.canDelete) && (r.DELETE || kept > im.min)
  const add = () => { if (canAdd) onChange([...rows, newRow(im)]) }
  const remove = (key: string) => {
    const r = rows.find((x) => x._key === key)
    if (!r || !canRemove(r)) return
    onChange(r._new ? rows.filter((x) => x !== r) : rows.map((x) => (x === r ? { ...x, DELETE: !x.DELETE } : x)))
  }
  const set = (i: number, f: string, v: unknown) => onChange(rows.map((r, k) => (k === i ? { ...r, [f]: v, _touched: true } : r)))
  const controls: Record<string, Control<any, any>> = {}
  if (canAdd) controls.add = { kind: 'click', label: 'Add another', run: () => add() }
  const removable = rows.filter(canRemove).map((r) => r._key as string)
  if (removable.length) controls.remove = { kind: 'toggle', label: 'Delete row (toggles DELETE on saved rows)', params: { row: { type: 'string', enum: removable } }, run: (a: { row: string }) => remove(a.row) }
  const w = useWidget<Json>({
    id: `inline:${im.name}`, name: im.name, kind: 'list', label: im.name, controls,
    state: { rows: rows.length, deleted: rows.filter((r) => r.DELETE).length, max: im.max, min: im.min },
  })
  const fieldOf = (r: Row, i: number, f: string, hideLabel: boolean) => <Field key={f} meta={fs[f]!} value={r[f]} onChange={(v) => set(i, f, v)} error={errors[`${i}.${f}`]}
    readOnly={readOnly || r.DELETE} hideLabel={hideLabel} model={im.model} search={p.search && fs[f]!.relation ? (q, page) => p.search!({ field: f, q, page }) : undefined} />
  const del = (r: Row) => canRemove(r) || r.DELETE
    ? <button type="button" className="tf-btn tf-btn-ghost tf-del" aria-pressed={r._new ? undefined : !!r.DELETE} disabled={!canRemove(r)} onClick={() => remove(r._key)}>
        {r._new ? 'Remove' : r.DELETE ? 'Undo delete' : 'Delete'}</button>
    : null
  const rowErr = (i: number) => errors[String(i)] && <p className="tf-hint tf-hint-error" role="alert">{errors[String(i)]}</p>

  return <w.Scope>
    <section ref={w.ref} {...w.props} className={['tf-inline', p.className].filter(Boolean).join(' ')} data-tvine-widget="inline" data-kind={kind} aria-label={cap(im.verboseNamePlural ?? im.name)}>
      {w.embed}
      <h3 className="tf-legend">{cap(im.verboseNamePlural ?? im.name)}</h3>
      {kind === 'tabular'
        ? <div className="tf-table-wrap"><table className="tf-table">
            <thead><tr>{cols.map((c) => <th key={c} scope="col">{fs[c]!.label}{fs[c]!.required && <span className="tf-req" aria-hidden="true"> *</span>}</th>)}<th><span className="tf-sr-only">Delete</span></th></tr></thead>
            <tbody>{rows.map((r, i) => <Row key={r._key} k={r._key}>
              <tr data-deleted={flag(r.DELETE)} data-new={flag(r._new)}>{cols.map((c) => <td key={c}>{fieldOf(r, i, c, true)}</td>)}<td>{del(r)}{rowErr(i)}</td></tr>
            </Row>)}</tbody>
          </table></div>
        : rows.map((r, i) => <Row key={r._key} k={r._key}>
            <div className="tf-stacked-row" data-deleted={flag(r.DELETE)} data-new={flag(r._new)}>
              <div className="tf-row-head"><span>{r.pk != null ? `#${r.pk}` : 'New'}</span>{del(r)}</div>
              {rowErr(i)}
              <div className="tf-fields">{cols.map((c) => fieldOf(r, i, c, false))}</div>
            </div>
          </Row>)}
      {canAdd && <button type="button" className="tf-btn tf-btn-ghost tf-add" onClick={add}>+ Add another</button>}
    </section>
  </w.Scope>
}

// A row scope so its fields are `… > row:<key> > field:<f>` (key = pk, or newN for unsaved rows).
function Row({ k, children }: { k: string; children: ReactNode }) {
  const w = useWidget<Json>({ id: `row:${k}`, kind: 'card', label: k })
  return <w.Scope>{w.embed}{children}</w.Scope>
}
