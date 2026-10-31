'use client'
import { useEffect, useState } from 'react'
import { toast } from '@tvine/weft/widgets'
import { href, urlFor } from './routes.js'
import type { FieldErrors, ModelMeta, ObjectData } from './types.js'
import { ModelForm, type Search } from './forms-adapter.js'
import { Icon, Region, Slotted, cx, slotClass, useAdmin } from './ui.js'

// Server errors → per-field map. invalid_param carries one `field` + message; a backend may add `errors: {field: msg}`.
export function fieldErrors(r: { field?: string; message: string; errors?: FieldErrors }): FieldErrors {
  if (r.errors && typeof r.errors === 'object') return r.errors
  return r.field ? { [r.field]: r.message } : { __all__: r.message }
}

export function ChangeForm({ meta, obj }: { meta: ModelMeta; obj?: ObjectData }) {
  const { call, base, navigate, setDirty, prefs, route } = useAdmin()
  const [errors, setErrors] = useState<FieldErrors>()
  const [busy, setBusy] = useState(false)
  const [gen, setGen] = useState(0)   // "save and add another" → a fresh form
  const adding = !obj
  const perms = obj?.perms ?? meta.perms
  const readOnly = !adding && !perms.change
  useEffect(() => () => setDirty(false), [setDirty])
  useEffect(() => {
    if (!obj) return
    const recent = prefs.get<{ model: string; pk: string; display: string }[]>('recent', []).filter((r) => !(r.model === meta.key && r.pk === obj.pk))
    prefs.set('recent', [{ model: meta.key, pk: obj.pk, display: obj.display }, ...recent].slice(0, 8))
  }, [obj?.pk])   // eslint-disable-line react-hooks/exhaustive-deps
  const search: Search = async (field, q) => {
    const r = await call('admin.autocomplete', { model: meta.key, field, q })
    return r.ok ? (r.data as { results: { pk: string; text: string }[] }).results : []
  }
  const objUrls = (meta.urls ?? []).filter((u) => u.path.includes('<') && obj)
  const link = (to: string, label: string, id: string, icon: string, cls = '') => (
    <a href={to} agentId={id} onClick={(e) => { e.preventDefault(); navigate(to) }} className={cx('tva-btn', cls)}><Icon name={icon} />{label}</a>
  )
  return (
    <Slotted slot="form" meta={meta}>
      <Region id="admin:form" label={adding ? `Add ${meta.name}` : `Change ${meta.name}`} state={{ mode: adding ? 'add' : 'change', pk: obj?.pk ?? null }} className={slotClass('form')}>
        <div className="mb-5 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{adding ? `Add ${meta.name}` : readOnly ? `View ${meta.name}` : `Change ${meta.name}`}</h1>
            {obj && <p className="truncate text-muted">{obj.display}</p>}
          </div>
          {obj && <div className="flex flex-wrap gap-2">
            {objUrls.map((u) => link(urlFor(base, meta.key, u.path, { id: obj.pk, pk: obj.pk, object_id: obj.pk }), u.title, `url-${u.name}`, 'ext'))}
            {link(href(base, { name: 'history', model: meta.key, pk: obj.pk }), 'History', 'history', 'clock')}
          </div>}
        </div>
        <ModelForm key={gen} id="tva-form" model={meta.key} meta={readOnly ? { ...meta.form, fields: Object.fromEntries(Object.entries(meta.form.fields).map(([k, f]) => [k, { ...f, readOnly: true }])) } : meta.form}
          values={obj?.values ?? {}} inlines={obj?.inlines} errors={errors} search={search} onDirty={setDirty}
          onSubmit={async (values, inlines, submitter) => {
            setBusy(true)
            const r = await call(adding ? 'admin.create' : 'admin.update', { model: meta.key, ...(obj && { pk: obj.pk }), values, inlines })
            setBusy(false)
            if (!r.ok) {
              setErrors(fieldErrors(r as never))
              if (r.code !== 'invalid_param') toast({ kind: 'error', title: 'Not saved', description: r.message })
              return
            }
            setErrors(undefined); setDirty(false)
            const pk = String((r.data as { pk?: unknown })?.pk ?? obj?.pk)
            const name = String(values[Object.keys(values)[0]] ?? pk)
            toast({ kind: 'success', title: adding ? `${meta.name} added` : `${meta.name} changed`, description: obj?.display ?? name })
            if (submitter === '_continue') navigate(href(base, { name: 'change', model: meta.key, pk }), { replace: adding })
            else if (submitter === '_addanother') { if (route.name === 'add') setGen((g) => g + 1); else navigate(href(base, { name: 'add', model: meta.key })) }
            else navigate(href(base, { name: 'changelist', model: meta.key }))
          }}>
          {!readOnly && (
            <div className="sticky bottom-0 z-[1] mt-5 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface/95 p-3 shadow-lg backdrop-blur">
              {obj && perms.delete && link(href(base, { name: 'delete', model: meta.key, pk: obj.pk }), 'Delete', 'delete', 'trash', 'tva-btn-danger tva-btn-ghost')}
              <div className="flex-1" />
              {meta.perms.add && <button type="submit" name="_addanother" agentId="save-add" disabled={busy} className="tva-btn hidden sm:inline-flex">Save and add another</button>}
              <button type="submit" name="_continue" agentId="save-continue" disabled={busy} className="tva-btn">Save and continue</button>
              <button type="submit" name="_save" agentId="save" disabled={busy} className="tva-btn tva-btn-primary">{busy ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </ModelForm>
      </Region>
    </Slotted>
  )
}
