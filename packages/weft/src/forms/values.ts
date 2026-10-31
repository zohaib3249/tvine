// Value shapes. API shape = what admin.get returns / admin.create|update take. FORM shape = what widgets edit
// (strings while typing, so "1." or "-" never get coerced away). fromApi: API → form; toPayload: form → API.
//   text-like, date, time, uuid, password, rich, choice : string ('' = empty)   choice+multiple: string[]
//   int, decimal : string → number          money : { amount: string, currency } → { value: number, currency }
//   datetime : local 'YYYY-MM-DDTHH:mm' → ISO (UTC)   duration : 'HH:MM:SS' → seconds
//   bool : boolean (nullable: true|false|null)          json : text → parsed
//   fk : { pk, text } | null → pk                       m2m : { pk, text }[] → pk[]
//   file/image : File (new) → File; null → null; anything else (the stored file) → key omitted (unchanged)
import { accepts } from '../widgets/file-upload.js'
import type { FieldMeta, FormMeta, Row } from './types.js'

const pad = (n: number) => String(n).padStart(2, '0')
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length)
const ref = (v: any) => v && typeof v === 'object' ? { pk: String(v.pk ?? v.id ?? v.value), text: String(v.text ?? v.display ?? v.label ?? v.pk ?? v.id) } : { pk: String(v), text: String(v) }

export function fromApi(m: FieldMeta, v: unknown): any {
  switch (m.kind) {
    case 'bool': return v == null ? (m.nullable ? null : false) : !!v
    case 'money': {
      const o = (v ?? {}) as { value?: number; amount?: number; currency?: string }
      const a = typeof v === 'number' ? v : o.value ?? o.amount
      return { amount: a == null ? '' : String(a), currency: o.currency ?? m.currency ?? '' }
    }
    case 'datetime': {
      if (empty(v)) return ''
      const d = new Date(String(v))
      return isNaN(+d) ? String(v) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    case 'date': return empty(v) ? '' : String(v).slice(0, 10)
    case 'duration': return typeof v === 'number' ? `${pad(Math.floor(v / 3600))}:${pad(Math.floor(v / 60) % 60)}:${pad(Math.floor(v % 60))}` : String(v ?? '')
    case 'json': return v === undefined || (v === null && !m.nullable) ? '' : JSON.stringify(v, null, 2)
    case 'fk': return empty(v) ? null : ref(v)
    case 'm2m': return Array.isArray(v) ? v.map(ref) : []
    case 'file': case 'image': return v ?? null
    case 'choice': return m.multiple ? (Array.isArray(v) ? v.map(String) : []) : v == null ? '' : String(v)
    default: return v == null ? '' : String(v)
  }
}

const DUR = /^(?:(\d+)\s+)?(\d+):([0-5]?\d)(?::([0-5]?\d))?$/   // "[D ]H:MM[:SS]" (Django)
export const durationSeconds = (s: string) => {
  const m = DUR.exec(s.trim()); if (!m) return NaN
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)
}

// One field, form → API. undefined = leave the key out.
export function fieldPayload(m: FieldMeta, v: any): unknown {
  switch (m.kind) {
    case 'int': case 'decimal': return empty(v) ? null : Number(v)
    case 'money': return empty(v?.amount) ? null : { value: Number(v.amount), currency: v.currency || m.currency || '' }
    case 'datetime': return empty(v) ? null : new Date(v).toISOString()
    case 'duration': return empty(v) ? null : durationSeconds(v)
    case 'bool': return v
    case 'json': return empty(v) ? null : JSON.parse(v)
    case 'fk': return v ? v.pk : null
    case 'm2m': return (v ?? []).map((r: { pk: string }) => r.pk)
    case 'file': case 'image': return typeof File !== 'undefined' && v instanceof File ? v : v === null ? null : undefined
    case 'choice': return m.multiple ? v ?? [] : empty(v) ? (m.nullable ? null : '') : v
    default: return empty(v) && m.nullable ? null : v ?? ''
  }
}

const out = (fields: Record<string, FieldMeta>, values: Record<string, any>, keep?: (n: string) => boolean) => {
  const r: Record<string, unknown> = {}
  for (const [n, m] of Object.entries(fields)) {
    if (m.readOnly || !(n in values) || (keep && !keep(n))) continue
    const p = fieldPayload(m, values[n])
    if (p !== undefined) r[n] = p
  }
  return r
}

// Whole form → admin.create/update params `{ values, inlines? }`. Inline rows keep `pk` and a `DELETE` flag (Django formsets).
export function toPayload(form: FormMeta | Record<string, FieldMeta>, values: Record<string, any>, inlines?: Record<string, Row[]>):
  { values: Record<string, unknown>; inlines?: Record<string, Record<string, unknown>[]> } {
  const fields = 'fields' in form && 'fieldsets' in form ? (form as FormMeta).fields : form as Record<string, FieldMeta>
  const res: ReturnType<typeof toPayload> = { values: out(fields, values) }
  const ims = 'inlines' in form ? (form as FormMeta).inlines : undefined
  if (inlines && ims) {
    res.inlines = Object.fromEntries(ims.map((im) => [im.name, (inlines[im.name] ?? []).map((row) => ({
      ...out(inlineFields(im.meta), row, (n) => im.fields.includes(n)), ...(row.pk != null && { pk: row.pk }), ...(row.DELETE && { DELETE: true }),
    }))]))
  }
  return res
}
export const inlineFields = (meta: Record<string, FieldMeta> | { fields: Record<string, FieldMeta> }): Record<string, FieldMeta> =>
  'fields' in meta && typeof (meta as { fields: unknown }).fields === 'object' && !('kind' in (meta as object)) ? (meta as { fields: Record<string, FieldMeta> }).fields : meta as Record<string, FieldMeta>

// ---- client validation (Django messages) ----
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLUG = /^[-a-zA-Z0-9_]+$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const isUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol) } catch { return false } }

export function validateField(m: FieldMeta, v: any): string | undefined {
  if (m.readOnly) return
  if (m.kind === 'bool') return m.required && (m.nullable ? v == null : v !== true) ? 'This field is required.' : undefined
  const blank = m.kind === 'money' ? empty(v?.amount) : empty(v)
  if (blank) return m.required ? 'This field is required.' : undefined
  const n = m.kind === 'money' ? v.amount : v
  switch (m.kind) {
    case 'int': case 'decimal': case 'money': {
      const s = String(n).trim()
      if (m.kind === 'int' ? !/^-?\d+$/.test(s) : !/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return m.kind === 'int' ? 'Enter a whole number.' : 'Enter a number.'
      const x = Number(s)
      if (m.max != null && x > m.max) return `Ensure this value is less than or equal to ${m.max}.`
      if (m.min != null && x < m.min) return `Ensure this value is greater than or equal to ${m.min}.`
      const dp = s.includes('.') ? s.split('.')[1]!.length : 0, maxDp = m.kind === 'money' ? m.decimals ?? 2 : m.decimals
      if (maxDp != null && dp > maxDp) return `Ensure that there are no more than ${maxDp} decimal place${maxDp === 1 ? '' : 's'}.`
      if (m.kind === 'money' && !v.currency && !m.currency) return 'Choose a currency.'
      return
    }
    case 'email': if (!EMAIL.test(v)) return 'Enter a valid email address.'; break
    case 'url': if (!isUrl(v)) return 'Enter a valid URL.'; break
    case 'slug': if (!SLUG.test(v)) return 'Enter a valid “slug” consisting of letters, numbers, underscores or hyphens.'; break
    case 'uuid': if (!UUID.test(v)) return 'Enter a valid UUID.'; break
    case 'duration': if (isNaN(durationSeconds(v))) return 'Enter a valid duration.'; break
    case 'date': if (isNaN(+new Date(v))) return 'Enter a valid date.'; break
    case 'datetime': if (isNaN(+new Date(v))) return 'Enter a valid date/time.'; break
    case 'json': try { JSON.parse(v) } catch { return 'Enter a valid JSON.' } break
    case 'choice': if (m.choices) {
      const bad = [v].flat().find((x: string) => !m.choices!.some((c) => c.value === x))
      if (bad !== undefined) return `Select a valid choice. ${bad} is not one of the available choices.`
    } break
    case 'file': case 'image':
      if (typeof File !== 'undefined' && v instanceof File && m.upload) {
        if (v.size > m.upload.maxBytes) return `Ensure this file is at most ${m.upload.maxBytes} bytes (it is ${v.size}).`
        if (!accepts(m.upload.accept, { name: v.name, type: v.type, size: v.size })) return `File type not allowed (${m.upload.accept}).`
      }
      break
  }
  if (typeof v === 'string' && m.maxLength != null && v.length > m.maxLength) return `Ensure this value has at most ${m.maxLength} characters (it has ${v.length}).`
  if (m.kind === 'm2m' && m.max != null && v.length > m.max) return `Select at most ${m.max}.`
}

export function validate(fields: Record<string, FieldMeta>, values: Record<string, any>): Record<string, string> {
  const errs: Record<string, string> = {}
  for (const [n, m] of Object.entries(fields)) { const e = validateField(m, values[n]); if (e) errs[n] = e }
  return errs
}

// ---- server errors → per field + non-field banner ----
// Accepts an ApiError / `{ok:false, code, field?, message}` (one field), an array of those, a
// `{ fields|errors: Record<field, string|string[]> }` envelope, or a bare Record. Inline row fields are
// `<inline>.<i>.<field>` (or `<inline>[i].<field>`); `__all__` / `nonField` / no field go to the banner.
export type ServerErrors = { fields: Record<string, string>; nonField: string[] }
export function mapServerErrors(err: unknown): ServerErrors {
  const r: ServerErrors = { fields: {}, nonField: [] }
  const put = (f: string | undefined, msg: unknown) => {
    const m = [msg].flat().map(String).join(' ')
    if (!m) return
    const key = f?.replace(/\[(\d+)\]/g, '.$1')
    if (!key || key === '__all__' || key === 'nonField' || key === 'non_field_errors') r.nonField.push(m)
    else r.fields[key] = r.fields[key] ? `${r.fields[key]} ${m}` : m
  }
  const walk = (e: any): void => {
    if (e == null) return
    if (typeof e === 'string') return put(undefined, e)
    if (Array.isArray(e)) return e.forEach(walk)
    if (typeof e !== 'object') return
    if ('code' in e || 'message' in e) {
      if (e.fields || e.errors) return walk(e.fields ?? e.errors)
      return put(e.field, e.message ?? e.code)
    }
    if (e.fields || e.errors) return walk(e.fields ?? e.errors)
    for (const [k, v] of Object.entries(e)) put(k, v)
  }
  walk(err)
  return r
}
