'use client'
// THE ONE SEAM to `@tvine/weft/forms` (admin.md §4, part C). Until C ships, this file holds a minimal fallback with the
// same interface: <ModelForm meta values errors onSubmit>, <Field meta>, <InlineFormset kind>, registerFieldWidget().
// Swap = replace the bodies below with `export { ModelForm, Field, InlineFormset, registerFieldWidget } from '@tvine/weft/forms'`
// (keeping the prop names), nothing else in the admin changes.
// ponytail: fallback widgets are native inputs; fk/m2m autocomplete = datalist over admin.autocomplete, file/image show
// the current value only (no upload action in §2 yet).
import { createElement, useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react'
import type { FieldErrors, FieldMeta, FormMeta, InlineMeta } from './types.js'
import { Icon, Region, cx } from './ui.js'

export type Values = Record<string, unknown>
export type InlineRow = { pk?: string; values: Values; delete?: boolean }
export type FieldWidgetProps = { meta: FieldMeta; value: unknown; onChange(v: unknown): void; error?: string; id: string; search?: Search }
export type Search = (field: string, q: string) => Promise<{ pk: string; text: string }[]>
const widgets = new Map<string, ComponentType<FieldWidgetProps>>()
export function registerFieldWidget(kindOrPath: string, C: ComponentType<FieldWidgetProps>): void { widgets.set(kindOrPath, C) }

export type ModelFormProps = {
  id: string; model: string; meta: FormMeta; values: Values; inlines?: Record<string, { rows: Values[] }>; errors?: FieldErrors
  onSubmit(values: Values, inlines: Record<string, InlineRow[]>, submitter?: string): void
  onDirty?(dirty: boolean): void; search?: Search; children?: ReactNode; className?: string
}

export function ModelForm(p: ModelFormProps) {
  const [values, setValues] = useState<Values>(() => ({ ...defaults(p.meta.fields), ...p.values }))
  const [inl, setInl] = useState<Record<string, InlineRow[]>>(() => Object.fromEntries(p.meta.inlines.map((i) => [i.name, [
    ...(p.inlines?.[i.name]?.rows ?? []).map((r) => ({ pk: String(r.pk ?? r.id ?? ''), values: r })),
    ...Array.from({ length: i.extra }, () => ({ values: defaults(i.meta.fields) })),
  ]])))
  const touched = useRef(false)
  const dirty = () => { if (!touched.current) { touched.current = true; p.onDirty?.(true) } }
  const firstErr = Object.keys(p.errors ?? {})[0]
  useEffect(() => {   // focus the first invalid field after a server error
    if (firstErr) document.querySelector<HTMLElement>(`[data-field="${CSS.escape(firstErr)}"] :is(input,select,textarea)`)?.focus()
  }, [p.errors])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // React's createElement, not JSX: a plain <form> would become its own agent scope (`form:?`), and fields should read
    // `admin:form > field:email`. The submit buttons inside stay controllable.
    createElement('form', { id: p.id, noValidate: true, className: p.className, onSubmit: (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      const sub = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.name
      p.onSubmit(clean(values, p.meta.fields), Object.fromEntries(Object.entries(inl).map(([k, rows]) => [k, rows.filter((r) => r.pk || r.delete || touchedRow(r)).map((r) => ({ ...r, values: clean(r.values, p.meta.inlines.find((i) => i.name === k)!.meta.fields) }))])), sub)
    } }, <>
      {p.errors?.__all__ && <div role="alert" className="tva-card mb-4 border-danger/40 p-3 text-danger">{p.errors.__all__}</div>}
      {Object.keys(p.errors ?? {}).length > 0 && !p.errors?.__all__ && <div role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">Please correct the errors below.</div>}
      <div className="flex flex-col gap-4">
        {p.meta.fieldsets.map((fs, i) => (
          <Fieldset key={i} title={fs.title} collapse={fs.classes?.includes('collapse')} wide={fs.classes?.includes('wide')}>
            {fs.fields.map((n) => p.meta.fields[n] && (
              <Field key={n} model={p.model} meta={p.meta.fields[n]} value={values[n]} error={p.errors?.[n]} search={p.search}
                onChange={(v) => { dirty(); setValues((s) => ({ ...s, [n]: v })) }} />
            ))}
          </Fieldset>
        ))}
        {p.meta.inlines.map((i) => (
          <InlineFormset key={i.name} meta={i} rows={inl[i.name] ?? []} errors={p.errors} search={p.search}
            onChange={(rows) => { dirty(); setInl((s) => ({ ...s, [i.name]: rows })) }} />
        ))}
      </div>
      {p.children}
    </>)
  )
}

export function Fieldset({ title, collapse, wide, children }: { title: string | null; collapse?: boolean; wide?: boolean; children: ReactNode }) {
  const body = <div className={cx('grid gap-x-6 gap-y-4 p-4 sm:p-5', !wide && 'md:grid-cols-2')}>{children}</div>
  if (collapse) {
    return (
      <details agentId={`fieldset-${(title ?? 'more').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="tva-card group">
        <summary className="flex items-center gap-2 px-5 py-3 font-semibold select-none">
          <Icon name="chevron" className="transition-transform group-open:rotate-90" />{title ?? 'More'}
        </summary>
        <div className="border-t border-line">{body}</div>
      </details>
    )
  }
  return (
    <fieldset className="tva-card">
      {title && <legend className="sr-only">{title}</legend>}
      {title && <h2 aria-hidden className="border-b border-line px-5 py-3 font-semibold">{title}</h2>}
      {body}
    </fieldset>
  )
}

export function Field({ model, meta, value, onChange, error, search, scope = true }: { model?: string; meta: FieldMeta; value: unknown; onChange(v: unknown): void; error?: string; search?: Search; scope?: boolean }) {
  const id = `tva-f-${meta.name}`
  const W = (model && widgets.get(`${model}.${meta.name}`)) || widgets.get(meta.kind) || Native
  const wide = ['textarea', 'rich', 'json', 'm2m'].includes(meta.kind)
  const body = (
    <div data-field={meta.name} className={cx('flex flex-col gap-1.5', wide && 'md:col-span-2')}>
      {meta.kind !== 'bool' && <label htmlFor={id} className="text-[13px] font-medium">{meta.label}{meta.required && !meta.readOnly && <span className="text-danger" aria-hidden> *</span>}</label>}
      {meta.readOnly
        ? <div id={id} className="min-h-9 rounded-md bg-sunken px-3 py-2 text-muted">{value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</div>
        : <W meta={meta} value={value} onChange={onChange} error={error} id={id} search={search} />}
      {meta.help && <p className="text-xs text-muted">{meta.help}</p>}
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  )
  return scope ? <Region id={`field:${meta.name}`} label={meta.label} className="contents">{body}</Region> : body
}

function Native({ meta, value, onChange, error, id, search }: FieldWidgetProps) {
  const common = { id, name: meta.name, agentId: meta.name, 'aria-invalid': !!error, 'aria-required': meta.required, className: 'tva-input' }
  const v = value ?? ''
  switch (meta.kind) {
    case 'bool':
      return <label className="flex items-center gap-2 pt-1"><input {...common} className="tva-check" type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /><span className="text-[13px] font-medium">{meta.label}</span></label>
    case 'textarea': case 'rich':
      return <textarea {...common} rows={5} maxLength={meta.maxLength} value={String(v)} onChange={(e) => onChange(e.target.value)} />
    case 'json':
      return <textarea {...common} rows={6} spellCheck={false} className="tva-input font-mono text-xs" value={typeof v === 'string' ? v : JSON.stringify(v, null, 2)} onChange={(e) => onChange(e.target.value)} />
    case 'choice':
      return (
        <select {...common} multiple={meta.multiple} value={meta.multiple ? (Array.isArray(v) ? v.map(String) : []) : String(v)}
          onChange={(e) => onChange(meta.multiple ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value)}>
          {!meta.multiple && (!meta.required || v === '') && <option value="">———</option>}
          {meta.choices?.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )
    case 'fk': case 'm2m':
      return <Related meta={meta} value={value} onChange={onChange} common={common} search={search} />
    case 'file': case 'image':
      return <div className="text-sm text-muted">{v ? String(v) : 'No file'}</div>
    default: {
      const type = ({ int: 'number', decimal: 'number', money: 'number', email: 'email', url: 'url', date: 'date', datetime: 'datetime-local', time: 'time', password: 'password' } as Record<string, string>)[meta.kind] ?? 'text'
      const step = meta.kind === 'int' ? 1 : meta.decimals ? 1 / 10 ** meta.decimals : meta.kind === 'money' ? 0.01 : undefined
      return (
        <div className="flex items-center gap-2">
          <input {...common} type={type} step={step} min={meta.min} max={meta.max} maxLength={meta.maxLength} autoComplete={meta.kind === 'password' ? 'new-password' : undefined}
            value={meta.kind === 'datetime' && typeof v === 'string' ? v.slice(0, 16) : String(v)} onChange={(e) => onChange(e.target.value)} />
          {meta.kind === 'money' && meta.currency && <span className="text-sm text-muted">{meta.currency}</span>}
        </div>
      )
    }
  }
}

function Related({ meta, value, onChange, common, search }: { meta: FieldMeta; value: unknown; onChange(v: unknown): void; common: Record<string, unknown>; search?: Search }) {
  const [opts, setOpts] = useState<{ pk: string; text: string }[]>([])
  const list = `${common.id}-list`
  const text = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : typeof value === 'object' ? String((value as { pk?: unknown }).pk ?? '') : String(value)
  return (
    <>
      <input {...common} list={list} value={text} placeholder={meta.multiple || meta.kind === 'm2m' ? 'ids, comma separated' : 'Search or type an id'}
        onChange={(e) => {
          const t = e.target.value
          onChange(meta.kind === 'm2m' ? t.split(',').map((s) => s.trim()).filter(Boolean) : t)
          if (search && meta.relation?.autocomplete !== false) void search(meta.name, t.split(',').pop()!.trim()).then(setOpts)
        }} />
      <datalist id={list}>{opts.map((o) => <option key={o.pk} value={o.pk}>{o.text}</option>)}</datalist>
    </>
  )
}

export function InlineFormset({ meta, rows, onChange, errors, search }: { meta: InlineMeta; rows: InlineRow[]; onChange(r: InlineRow[]): void; errors?: FieldErrors; search?: Search }) {
  const fields = meta.fields.map((n) => meta.meta.fields[n]).filter(Boolean)
  const put = (i: number, r: Partial<InlineRow>) => onChange(rows.map((x, j) => (j === i ? { ...x, ...r } : x)))
  const canAdd = meta.max === undefined || rows.filter((r) => !r.delete).length < meta.max
  const title = (meta.meta as { namePlural?: string }).namePlural ?? meta.name
  const add = canAdd && <button type="button" agentId="add-row" className="tva-btn tva-btn-ghost text-brand" onClick={() => onChange([...rows, { values: defaults(meta.meta.fields) }])}><Icon name="plus" />Add another</button>
  const err = (i: number, f: string) => errors?.[`${meta.name}.${i}.${f}`]
  return (
    <Region id={`inline:${meta.name}`} label={String(title)} className="tva-card overflow-hidden">
      <h2 className="border-b border-line px-5 py-3 font-semibold">{title}</h2>
      {meta.kind === 'tabular' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>{fields.map((f) => <th key={f.name} className="tva-th">{f.label}</th>)}{meta.canDelete && <th className="tva-th w-16">Delete</th>}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <Region key={i} as="tr" id={`row:${r.pk || `new-${i}`}`} label={`Row ${i + 1}`} className={cx('tva-row', r.delete && 'opacity-50')}>
                  {fields.map((f) => (
                    <td key={f.name} className="tva-td min-w-32">
                      <Field meta={{ ...f, label: f.label }} scope={false} value={r.values[f.name]} error={err(i, f.name)} search={search} onChange={(v) => put(i, { values: { ...r.values, [f.name]: v } })} />
                    </td>
                  ))}
                  {meta.canDelete && <td className="tva-td text-center">{r.pk && <input type="checkbox" agentId="delete" aria-label="Delete row" className="tva-check" checked={!!r.delete} onChange={(e) => put(i, { delete: e.target.checked })} />}</td>}
                </Region>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r, i) => (
            <Region key={i} id={`row:${r.pk || `new-${i}`}`} label={`Row ${i + 1}`} className={cx('grid gap-4 p-5 md:grid-cols-2', r.delete && 'opacity-50')}>
              {fields.map((f) => <Field key={f.name} meta={f} scope={false} value={r.values[f.name]} error={err(i, f.name)} search={search} onChange={(v) => put(i, { values: { ...r.values, [f.name]: v } })} />)}
              {meta.canDelete && r.pk && <label className="flex items-center gap-2 text-sm text-danger"><input type="checkbox" agentId="delete" className="tva-check" checked={!!r.delete} onChange={(e) => put(i, { delete: e.target.checked })} />Delete</label>}
            </Region>
          ))}
        </div>
      )}
      {add && <div className="border-t border-line px-3 py-2">{add}</div>}
    </Region>
  )
}

const defaults = (fields: Record<string, FieldMeta>): Values => Object.fromEntries(Object.values(fields).filter((f) => f.default !== undefined).map((f) => [f.name, f.default]))
const touchedRow = (r: InlineRow) => Object.values(r.values).some((v) => v !== '' && v !== null && v !== undefined && v !== false)
// Inputs give strings: hand the server typed values (it validates everything again).
function clean(v: Values, fields: Record<string, FieldMeta>): Values {
  const out: Values = {}
  for (const [k, x] of Object.entries(v)) {
    const f = fields[k]
    if (!f || f.readOnly) continue
    if (x === '' && (f.nullable || !['text', 'textarea', 'email', 'url', 'slug', 'password', 'rich'].includes(f.kind))) { out[k] = null; continue }
    if (f.kind === 'int' && typeof x === 'string') out[k] = Number(x)
    else if (f.kind === 'json' && typeof x === 'string') { try { out[k] = JSON.parse(x) } catch { out[k] = x } }
    else out[k] = x
  }
  return out
}
