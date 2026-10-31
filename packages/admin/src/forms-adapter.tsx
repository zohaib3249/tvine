'use client'
// THE ONE SEAM to `@tvine/weft/forms` (admin.md §4, part C). The admin only imports forms through this file.
// Agent ids (forms.md): `admin:form > form:<model> > field:<f>`, inline rows `… > inline:<n> > row:<pk|newN> > field:<f>`.
import type { ReactNode } from 'react'
import { ApiError, type ApiResult } from '@tvine/weft/api'
import { ModelForm as WeftModelForm, registerFieldWidget, type FieldWidgetProps, type ModelFormState } from '@tvine/weft/forms'
import type { Call } from './data.js'
import type { FormMeta, ObjectData } from './types.js'

export { registerFieldWidget, type FieldWidgetProps, type ModelFormState }

// A rejected submit is mapped by forms' mapServerErrors (invalid_param + field, `lines.0.qty`, or {errors}).
const reject = (r: Extract<ApiResult, { ok: false }>) => { throw Object.assign(new ApiError(r), (r as { errors?: unknown }).errors ? { errors: (r as { errors?: unknown }).errors } : {}) }

const hasFile = (v: unknown): boolean => typeof File !== 'undefined' && (v instanceof File || (Array.isArray(v) ? v.some(hasFile) : !!v && typeof v === 'object' && Object.values(v).some(hasFile)))
// New uploads are Files → multipart (contract §2): `params` = JSON without the files, each file under its path (`avatar`, `lines.0.doc`).
// ponytail: warp's /tvine/api multipart field layout is not pinned in the contract yet; adjust here when part A fixes it.
async function multipart(id: string, params: Record<string, unknown>): Promise<ApiResult> {
  const fd = new FormData()
  const strip = (v: unknown, path: string): unknown => {
    if (v instanceof File) { fd.append(path, v); return undefined }
    if (Array.isArray(v)) return v.map((x, i) => strip(x, `${path}.${i}`))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x, path ? `${path}.${k}` : k)]))
    return v
  }
  fd.append('params', JSON.stringify(strip(params, '')))
  const r = await fetch(`/tvine/api/${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-tvine-api': '1' }, body: fd })
  return (await r.json()) as ApiResult
}

export function AdminModelForm({ meta, model, obj, call, readOnly, onSaved, onDirty, actions }: {
  meta: FormMeta; model: string; obj?: ObjectData; call: Call; readOnly?: boolean
  onSaved(pk: string, payload: { values: Record<string, unknown> }): void; onDirty(d: boolean): void
  actions: (s: ModelFormState) => ReactNode
}) {
  const id = obj ? 'admin.update' : 'admin.create'
  const keyArgs = { model, ...(obj && { pk: obj.pk }) }
  return (
    <WeftModelForm form={meta} values={obj?.values} inlines={obj?.inlines as never} readOnly={readOnly} layout="aligned"
      name={model.split('.').pop()} label={obj ? `Change ${obj.display}` : 'Add'} model={model}
      search={async ({ model: from, field, q, page }) => {   // from = the inline's model for an inline row's field
        const r = await call('admin.autocomplete', { model: from ?? model, field, q, page })
        return r.ok ? (r.data as { results: { pk: string; text: string }[]; more: boolean }) : { results: [], more: false }
      }}
      call={{ id, args: keyArgs }}
      onDirtyChange={onDirty} actions={actions}
      onSubmit={async (payload) => {
        const params = { ...keyArgs, ...payload }
        const r = hasFile(payload) ? await multipart(id, params) : await call(id, params)
        if (!r.ok) reject(r)
        onSaved(String((r as { data?: { pk?: unknown } }).data?.pk ?? obj?.pk), payload as { values: Record<string, unknown> })
      }} />
  )
}
