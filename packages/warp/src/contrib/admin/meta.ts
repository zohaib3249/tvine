// FieldMeta from ORM field definitions (contract §2), wire conversion of values, and input validation.
import { type Field, type Kind } from '../../data/fields.js'
import { pkField, type ModelDef } from '../../data/fields/index.js'

type AnyField = Field<any, boolean, Kind, boolean>
export type MetaKind = 'text' | 'textarea' | 'email' | 'url' | 'slug' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'datetime' | 'time' |
  'duration' | 'uuid' | 'json' | 'choice' | 'fk' | 'm2m' | 'file' | 'image' | 'password' | 'rich'
export interface FieldMeta {
  name: string; label: string; help?: string; kind: MetaKind; required: boolean; readOnly: boolean; nullable: boolean
  default?: unknown; choices?: { value: string; label: string }[]; max?: number; min?: number; maxLength?: number
  decimals?: number; currency?: string; multiple?: boolean
  relation?: { model: string; autocomplete: boolean; rawId: boolean }
  upload?: { accept: string; maxBytes?: number }
}

// 'createdAt' → 'Created at', 'shipTo' → 'Ship to' (Django verbose_name from the attribute name)
export const labelOf = (n: string) => {
  const s = n.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim()
  return s ? s[0]!.toUpperCase() + s.slice(1) : n
}
export const isPassword = (n: string, f: AnyField) => f.kind === 'text' && (n === 'password' || (!!f.opts.hidden && /password/i.test(n)))

function kindOf(n: string, f: AnyField): MetaKind {
  switch (f.kind) {
    case 'id': case 'int': return 'int'
    case 'float': return 'decimal'
    case 'enum': return 'choice'
    case 'text':
      if (isPassword(n, f)) return 'password'
      if (/email/i.test(n)) return 'email'
      if (/(^url|Url|URL)$/.test(n)) return 'url'
      if (n === 'slug') return 'slug'
      return 'text'
    default: return f.kind as MetaKind   // uuid bool money datetime json image fk m2m
  }
}

export interface MetaOpts {
  readonly: string[]; autocomplete: string[]; rawId: string[]
  overrides: Record<string, Partial<FieldMeta>>
  keyOf: (def: ModelDef) => string           // a related model's '<app>.<model>'
}
export function fieldMeta(n: string, f: AnyField, o: MetaOpts): FieldMeta {
  const kind = kindOf(n, f)
  const m: FieldMeta = {
    name: n, label: labelOf(n), kind,
    required: f.kind !== 'm2m' && f.kind !== 'bool' && !f.opts.optional && !f.opts.auto && f.kind !== 'id' && f.kind !== 'uuid',   // Django blank=False; a default is the add form's initial
    readOnly: o.readonly.includes(n) || f.kind === 'id' || !!f.opts.readOnly || !!f.opts.auto,
    nullable: !!f.opts.optional,
  }
  const d = f.opts.default
  if (d !== undefined && typeof d !== 'function' && kind !== 'password') m.default = d
  if (f.kind === 'enum') m.choices = (f.values ?? []).map((v) => ({ value: v, label: labelOf(v) }))
  if (f.kind === 'money') { m.decimals = 2; const c = (d as { currency?: string } | undefined)?.currency; if (c) m.currency = c }
  if (f.kind === 'fk' || f.kind === 'm2m') {
    m.relation = { model: o.keyOf(f.target!()), autocomplete: o.autocomplete.includes(n), rawId: o.rawId.includes(n) }
    if (f.kind === 'm2m') m.multiple = true
  }
  if (f.kind === 'image') m.upload = { accept: 'image/*' }
  if (f.kind === 'file') m.upload = { accept: 'application/pdf,image/*' }   // every type media sniffing knows
  if (f.kind === 'decimal') { m.decimals = (f as unknown as { places: number }).places; m.max = 10 ** ((f as unknown as { digits: number }).digits - m.decimals) - 10 ** -m.decimals }
  const ml = f.opts.maxLength ?? ({ email: 254, url: 200, slug: 50 } as Record<string, number>)[f.kind]
  if (ml) m.maxLength = ml
  return { ...m, ...o.overrides[f.kind], ...o.overrides[n] }
}

// a stored row value → JSON (fk = the related pk, money = {value, currency}, dates ISO)
export function toWire(f: AnyField, row: Record<string, unknown>, n: string): unknown {
  const v = row[f.key(n)]
  if (f.kind === 'duration' && typeof v === 'number') return v / 1000   // ORM ms → the form's seconds
  return v instanceof Date ? v.toISOString() : v ?? null
}

const intLike = (def: ModelDef) => pkField(def)[1].kind === 'id'
export function coercePk(def: ModelDef, v: unknown): string | number | undefined {
  const s = String(v ?? '')
  if (intLike(def)) return /^\d{1,15}$/.test(s) ? Number(s) : undefined
  return /^[0-9a-f-]{36}$/i.test(s) ? s : undefined
}

// one input value → the stored value, or an error text. '' on an optional field = null.
export function fromWire(n: string, f: AnyField, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if ((v === '' || v === null) && f.kind !== 'text') {
    if (f.opts.optional) return { ok: true, value: null }
    return { ok: false, error: 'This field is required.' }
  }
  let x = v
  if (f.kind === 'datetime' && typeof v === 'string') { x = new Date(v); if (Number.isNaN((x as Date).getTime())) return { ok: false, error: 'Enter a valid date/time.' } }
  if ((f.kind === 'int' || f.kind === 'float') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) x = Number(v)
  if (f.kind === 'duration' && v !== undefined && Number.isFinite(Number(v))) x = Number(v) * 1000   // seconds → ms
  if (f.kind === 'decimal' && typeof v === 'number') x = String(v)
  if (f.kind === 'bool' && typeof v === 'string') x = v === 'true' || v === '1' || v === 'on'
  if (f.kind === 'fk') {
    const pk = coercePk(f.target!(), v)
    if (pk === undefined) return { ok: false, error: 'Select a valid choice.' }
    x = pk
  }
  if (f.kind === 'm2m') {
    if (!Array.isArray(v) || v.length > 1000) return { ok: false, error: 'Enter a list of values.' }
    const pks = v.map((p) => coercePk(f.target!(), p))
    if (pks.some((p) => p === undefined)) return { ok: false, error: 'Select a valid choice.' }
    return { ok: true, value: pks }
  }
  const r = f.schema().safeParse(x)
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'Enter a valid value.' }
  if (f.kind === 'text' && !f.opts.optional && r.data === '' && n !== 'password') return { ok: false, error: 'This field is required.' }
  return { ok: true, value: r.data }
}
