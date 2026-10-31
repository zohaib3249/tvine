// The admin API (contract §2): admin.site / meta / list / get / create / update / delete / deletePreview /
// action / autocomplete / history / listEdit. Every action: staff (rules.permissions, run by dispatch) + the
// model permission (ModelAdmin.has*Permission). Request values are checked against the ModelAdmin's options
// (whitelists); the ORM binds every value as a param.
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, ActionDef } from '../../core/types.js'
import type { Field, Fields, Kind, ModelDef } from '../../data/fields/index.js'
import { hasDefault } from '../../data/fields.js'
import type { Model } from '../../data/model.js'
import { Count, Max, Min, Q, type QNode } from '../../data/expressions.js'
import type { QuerySet } from '../../data/queryset.js'
import { modelNamed, referencesTo } from '../../data/registry.js'
import { staffGuard } from './hardening.js'
import { scoped as scopedBy } from '../../security/scope.js'
import { DiskStorage, filePartsOf, storePart } from '../../media/index.js'
import { sanitizeHtml } from '../../shape/rich.js'
import { refuseHumanOnly } from '../../data/fields/inputs.js'
import { makePassword, validatePassword } from '../auth/passwords.js'
import { coercePk, fieldMeta, fromWire, isPassword, labelOf, toWire, type FieldMeta } from './meta.js'
import { ADDITION, AdminPref, CHANGE, DELETION, LogEntry, REPR_MAX } from './models.js'
import {
  checkPerm, displayOf, isFilterClass, type ActionResult, type AdminAction, type Ctx, type InlineModelAdmin, type ListFilterClass,
  type ListParams, type ModelAdmin,
} from './options.js'
import { autodiscover, fkTo, site } from './sites.js'

type AnyModel = Model<any, any>
type AnyField = Field<any, boolean, Kind, boolean>
type Row = Record<string, any>
type Base = ModelAdmin | InlineModelAdmin

const forbidden = () => new DomainError('forbidden', 'forbidden: not allowed')
const bad = (field: string, msg: string) => new DomainError('invalid_param', `${field}: ${msg}`, field)
const MAX_PKS = 1000

// discover() hook (views/discover.ts): load every app's admin.ts and register the getUrls() views
export const discoverViews = (o: { appsDir: string; installed: readonly string[] }): Promise<ActionDef[]> => autodiscover(o.appsDir, o.installed)

// ---- lookup + permission gate -----------------------------------------------------------------------
const modelKey = z.string().regex(/^[a-z][a-z0-9_]*\.[a-zA-Z0-9_]+$/).max(100)
const pkParam = z.union([z.string().max(64), z.number()])

async function gate(ctx: Ctx, key: string, need: 'view' | 'add' | 'change' | 'delete' | 'module'): Promise<ModelAdmin> {
  const a = site.adminFor(key)
  if (!a) throw new DomainError('not_found', `no admin for model ${key}`)
  if (a.agents === false && ctx.request.agent.is) throw new DomainError('forbidden', 'forbidden: this model is not for agents')
  const ok = need === 'module' ? await a.hasModulePermission(ctx) : await checkPerm(a, ctx, need)
  if (!ok) throw forbidden()
  return a
}
async function objectOf(a: ModelAdmin, ctx: Ctx, pk: unknown): Promise<Row> {
  const id = coercePk(a.model, pk)
  if (id === undefined) throw bad('pk', 'not a valid primary key')
  const obj = await a.getObject(ctx, id)
  if (!obj) throw new DomainError('not_found', `${a._key} ${String(pk)} not found`)
  return obj as Row
}
const perms = async (a: Base, ctx: Ctx, obj?: object) => ({
  view: !!(await a.hasViewPermission(ctx, obj)), add: !!(await a.hasAddPermission(ctx, obj)),
  change: !!(await a.hasChangePermission(ctx, obj)), delete: !!(await a.hasDeletePermission(ctx, obj)),
})
const repr = (a: Base | undefined, def: ModelDef, obj: Row): string =>
  a ? a.str(obj) : (['name', 'title', 'username', 'email'].map((k) => obj[k]).find((v) => typeof v === 'string' && v) ?? `${def.name} object (${String(obj.id)})`)
const adminOfDef = (def: ModelDef) => site.admins().find((x) => x.model.name === def.name)
// THE row scope of the admin: an admin's (or inline's) getQueryset; a related model's own admin's getQueryset, the
// bare model only when it has no admin. Every row read below comes from here (a test pins it).
function scoped(x: Base | ModelDef, ctx: Ctx): QuerySet<any> {
  if ('getQueryset' in x) return scopedBy(x, ctx)
  const ta = adminOfDef(x)
  return ta ? scopedBy(ta, ctx) : modelNamed<AnyModel>(x.name)!.objects   // scope: ok (no admin, no scope hook)
}

export async function logAction(ctx: Ctx, key: string, pk: unknown, objectRepr: string, actionFlag: number, changeMessage: unknown[]): Promise<void> {
  await LogEntry.create({
    userId: String(ctx.request.user.id ?? ''), contentType: key, objectId: String(pk),
    objectRepr: objectRepr.slice(0, REPR_MAX), actionFlag, changeMessage,
  })
}

// ---- form fields ------------------------------------------------------------------------------------
// the editable + read-only fields of the form (Django get_fields): hidden fields only when a password
function formFields(a: Base): string[] {
  const all = Object.entries(a.model.fields as Fields).filter(([n, f]) => f.kind !== 'id' && (!f.opts.hidden || isPassword(n, f)) && !(f.opts.auto && !a.readonlyFields.includes(n)))
  const fs = (a as ModelAdmin).fieldsets?.flatMap(([, f]) => f.fields) ?? a.fields ?? all.map(([n]) => n)
  return fs.filter((n) => !a.exclude.includes(n))
}
const metaOpts = (a: Base) => ({ readonly: a.readonlyFields, autocomplete: a.autocompleteFields, rawId: a.rawIdFields, overrides: a.formfieldOverrides, keyOf: (d: ModelDef) => site.keyOf(d) })
function formMeta(a: Base): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = {}
  for (const n of formFields(a)) {
    const f = a.model.fields[n]
    out[n] = f ? fieldMeta(n, f, metaOpts(a)) : { name: n, label: labelOf(n), kind: 'text', required: false, readOnly: true, nullable: true }
    if (isPassword(n, f!)) out[n]!.required = false
  }
  return out
}

// Django ModelChoiceField: an fk / m2m that is neither autocomplete nor raw-id is a <select> of the related rows
// ponytail: first 500 rows; use autocompleteFields for a big related table (Django loads them all)
const RELATED_CHOICES = 500
async function withChoices(a: Base, ctx: Ctx, fields: Record<string, FieldMeta>): Promise<Record<string, FieldMeta>> {
  for (const m of Object.values(fields)) {
    if (!m.relation || m.relation.autocomplete || m.relation.rawId || m.readOnly) continue
    const t = a.model.fields[m.name]!.target!(), ta = adminOfDef(t)
    const qs = scoped(t, ctx).order(...(ta?.ordering ?? ['id']))
    m.choices = (await qs.all(RELATED_CHOICES)).map((r: Row) => ({ value: String(r.id), label: repr(ta, t, r) }))
  }
  return fields
}

// stored row → form values (never a hidden field, so never a password hash)
async function valuesOf(a: Base, ctx: Ctx, obj: Row): Promise<Row> {
  const out: Row = {}
  for (const n of formFields(a)) {
    const f = a.model.fields[n]
    if (!f) { const fn = (a as unknown as Row)[n]; out[n] = typeof fn === 'function' ? await fn.call(a, obj) : null; continue }
    if (f.opts.hidden) continue
    if (f.kind === 'm2m') { out[n] = (await a.model.related(n, obj.id).all().fetchAll()).map((r: Row) => r.id); continue }
    out[n] = toWire(f, obj, n)
    if (f.kind === 'fk' && out[n] != null) {   // { pk, text }: the form's chip shows the related object's name (forms take a bare pk too)
      // ponytail: one query per fk per row; batch like relatedReprs if inlines grow large
      const t = f.target!(), rel = (await scoped(t, ctx).inBulk([out[n]]))[String(out[n])] as Row | undefined
      out[n] = { pk: String(out[n]), text: rel ? repr(adminOfDef(t), t, rel) : String(out[n]) }
    }
  }
  return out
}

// input values → { data (row keys), m2m, errors }; only form fields that are not read-only
// `changed` (the LogEntry message) lists only fields whose value differs from `old` (Django form.changed_data)
function clean(a: Base, values: Row, creating: boolean, only?: string[], old?: Row, agent = false) {
  const errors: Record<string, string> = {}
  const data: Row = {}, m2m: Record<string, unknown[]> = {}, changed: string[] = []
  const editable = (only ?? formFields(a)).filter((n) => a.model.fields[n] && !a.readonlyFields.includes(n))
  for (const k of Object.keys(values ?? {})) if (!editable.includes(k)) errors[k] = 'Unknown or read-only field.'
  refuseHumanOnly(Object.fromEntries(editable.map((n) => [n, a.model.fields[n]!])), values, agent, old)   // field humanOnly: agents never set it
  for (const n of editable) {
    const f = a.model.fields[n]!
    const meta = fieldMeta(n, f, metaOpts(a))
    if (meta.readOnly) continue
    if (!(n in (values ?? {}))) {
      if (creating && meta.required && !hasDefault(f) && !isPassword(n, f)) errors[n] = 'This field is required.'   // an omitted field with a default gets it
      continue
    }
    if (isPassword(n, f) && (values[n] === '' || values[n] == null)) continue   // blank = keep the password
    const r = fromWire(n, f, meta.kind === 'rich' && typeof values[n] === 'string' ? sanitizeHtml(values[n], { allowRemoteImages: !!f.opts.allowRemoteImages }) : values[n])   // never trust the browser's sanitizer
    if (!r.ok) { errors[n] = r.error; continue }
    if (f.kind === 'm2m') m2m[n] = r.value as unknown[]
    else data[f.key(n)] = r.value
    if (!old || f.kind === 'm2m' || JSON.stringify(old[f.key(n)] ?? null) !== JSON.stringify(r.value ?? null)) changed.push(n)
  }
  return { data, m2m, errors, changed }
}
// Django ModelChoiceField: an fk / m2m pk must be a row that exists and that this user can see (the related admin's
// getQueryset, like autocomplete; the model's rows when it has no admin)
async function cleanChoices(a: Base, ctx: Ctx, c: Awaited<ReturnType<typeof clean>>, obj?: Row): Promise<void> {
  for (const [n, f] of Object.entries(a.model.fields as Fields)) {
    // a password field (any model): stored through the auth hasher (settings.auth.hashers[0]), never as typed
    // and checked by settings.auth.passwordValidators first (Django's admin forms run them too)
    if (isPassword(n, f) && typeof c.data[f.key(n)] === 'string') {
      const problems = validatePassword(c.data[f.key(n)], ctx.settings, { ...obj, ...c.data })
      if (problems.length) c.errors[n] = problems.join(' ')
      else c.data[f.key(n)] = await makePassword(c.data[f.key(n)], ctx.settings)
    }
    if (f.kind !== 'fk' && f.kind !== 'm2m') continue
    const v = f.kind === 'm2m' ? c.m2m[n] : c.data[f.key(n)]
    if (v == null || c.errors[n]) continue
    const ids = [...new Set((Array.isArray(v) ? v : [v]) as (string | number)[])]
    if (!ids.length) continue
    const t = f.target!(), ta = adminOfDef(t)
    const qs = scoped(t, ctx)
    if ((await qs.filter({ id__in: ids }).count()) !== ids.length) c.errors[n] = 'Select a valid choice. That choice is not one of the available choices.'
  }
}
// every bad field (Django ValidationError dict): `errors` per input (inline rows `lines.0.qty`), `field` = the first
const fieldErrors = (errors: Record<string, string>, prefix = ''): DomainError => {
  const list = Object.entries(errors).map(([k, message]) => ({ field: prefix + k, message }))
  return new DomainError('invalid_param', list.map((e) => `${e.field}: ${e.message}`).join('; '), list[0]!.field, list)
}

// ---- changelist ---------------------------------------------------------------------------------------
type Spec = { name: string; label: string; kind: 'choice' | 'boolean' | 'date' | 'related' | 'custom'; cls?: ListFilterClass; field?: string }
function filterSpecs(a: ModelAdmin): Spec[] {
  return a.listFilter.map((f): Spec => {
    if (isFilterClass(f)) { const i = new f(); return { name: i.parameterName, label: i.title || labelOf(i.parameterName), kind: 'custom', cls: f } }
    const k = a.model.fields[f]!.kind
    return { name: f, label: labelOf(f), field: f, kind: k === 'bool' ? 'boolean' : k === 'datetime' || k === 'date' ? 'date' : k === 'fk' ? 'related' : 'choice' }
  })
}
const DATE_CHOICES: [string, string][] = [['today', 'Today'], ['past7', 'Past 7 days'], ['month', 'This month'], ['year', 'This year']]
async function choicesOf(a: ModelAdmin, ctx: Ctx, s: Spec): Promise<[string, string][]> {
  if (s.cls) return (await new s.cls().lookups(ctx, a)).map(([v, l]) => [String(v), String(l)])
  const f = a.model.fields[s.field!]!
  const nulls: [string, string][] = f.opts.optional ? [['null', s.kind === 'date' ? 'No date' : 'Unknown']] : []
  if (s.kind === 'boolean') return [['true', 'Yes'], ['false', 'No'], ...nulls]
  if (s.kind === 'date') return [...DATE_CHOICES, ...nulls]
  if (f.kind === 'enum') return [...(f.values ?? []).map((v: string): [string, string] => [v, labelOf(v)]), ...nulls]
  if (s.kind === 'related') {
    const t = f.target!()
    return [...(await scoped(t, ctx).all(200)).map((r: Row): [string, string] => [String(r.id), repr(adminOfDef(t), t, r)]), ...nulls]
  }
  // AllValuesFieldListFilter: the distinct values in use
  const key = f.key(s.field!)
  const vals = await scoped(a, ctx).values(key).distinct().order(key).all(200)   // Django: model_admin.get_queryset(request)
  return vals.map((r: Row) => r[key]).filter((v: unknown) => v != null).map((v: unknown): [string, string] => [v instanceof Date ? v.toISOString() : String(v), String(v)])
}
// Django DateFieldListFilter on calendar days (UTC): __date for a datetime, the value itself for a date
function dateRange(a: ModelAdmin, s: Spec, v: string): Record<string, string> {
  const n = s.field!, f = a.model.fields[n]!, key = f.key(n)
  const day = (d: Date) => d.toISOString().slice(0, 10), t = new Date(), today = day(t)
  const from = v === 'today' ? today : v === 'past7' ? day(new Date(t.getTime() - 6 * 86_400_000)) : v === 'month' ? today.slice(0, 8) + '01' : v === 'year' ? today.slice(0, 5) + '01-01' : undefined
  if (!from) throw bad(`filters.${n}`, 'not a choice')
  const k = f.kind === 'date' ? key : `${key}__date`
  return { [`${k}__gte`]: from, [`${k}__lte`]: today }
}
// one query per filter: GROUP BY the column (choice / boolean / related / all values), one conditional COUNT per
// date range; a custom filter's queryset() is opaque, so one COUNT per lookup (Django does the same)
async function facetCounts(a: ModelAdmin, ctx: Ctx, base: QuerySet<any>, s: Spec, ch: [string, string][]): Promise<number[]> {
  if (s.cls) return Promise.all(ch.map(async ([v]) => (await applyFilter(a, ctx, base, s, v)).count()))
  const f = a.model.fields[s.field!]!, key = f.key(s.field!)
  if (s.kind === 'date') {
    const aggs = Object.fromEntries(ch.map(([v], i) => [`c${i}`, Count('*', { filter: v === 'null' ? { [key]: null } : dateRange(a, s, v) })]))
    const r = await base.aggregate(aggs)
    return ch.map((_, i) => Number(r[`c${i}`] ?? 0))
  }
  const rows = await base.values(key).annotate({ _n: Count('*') }).order().all(1000)
  const by = new Map(rows.map((r: Row) => [r[key] == null ? 'null' : r[key] instanceof Date ? r[key].toISOString() : String(r[key]), Number(r._n)]))
  return ch.map(([v]) => by.get(v) ?? 0)
}
async function applyFilter(a: ModelAdmin, ctx: Ctx, qs: QuerySet<any>, s: Spec, v: string): Promise<QuerySet<any>> {
  if (v.length > 200) throw bad(`filters.${s.name}`, 'value too long')
  if (s.cls) return (await new s.cls(v).queryset(ctx, qs)) ?? qs
  const n = s.field!, f = a.model.fields[n]!, key = f.key(n)
  if (v === 'null' && f.opts.optional) return qs.filter({ [key]: null })
  if (s.kind === 'boolean') { if (v !== 'true' && v !== 'false') throw bad(`filters.${n}`, 'expected true or false'); return qs.filter({ [key]: v === 'true' }) }
  if (s.kind === 'date') return qs.filter(dateRange(a, s, v))
  if (f.kind === 'enum' && !(f.values ?? []).includes(v)) throw bad(`filters.${n}`, 'not a choice')
  if (s.kind === 'related') { const pk = coercePk(f.target!(), v); if (pk === undefined) throw bad(`filters.${n}`, 'not a valid key'); return qs.filter({ [key]: pk }) }
  const r = fromWire(n, f, v)
  if (!r.ok) throw bad(`filters.${n}`, r.error)
  return qs.filter({ [key]: r.value })
}
// dateHierarchy drill-down: filters `<field>__year`, `__month`, `__day`
function applyHierarchy(a: ModelAdmin, qs: QuerySet<any>, filters: Record<string, string>): QuerySet<any> {
  const dh = a.dateHierarchy
  if (!dh) return qs
  const num = (k: string, lo: number, hi: number) => {
    const v = filters[`${dh}__${k}`]
    if (v === undefined) return undefined
    if (!/^\d{1,4}$/.test(v) || +v < lo || +v > hi) throw bad(`filters.${dh}__${k}`, 'out of range')
    return +v
  }
  const y = num('year', 1, 9999), m = num('month', 1, 12), d = num('day', 1, 31)
  if (y === undefined) return qs
  const key = a.model.fields[dh]!.key(dh)   // the ORM's __year/__month/__day lookups (UTC)
  return qs.filter({ [`${key}__year`]: y, ...(m !== undefined && { [`${key}__month`]: m, ...(d !== undefined && { [`${key}__day`]: d }) }) })
}
// Django get_search_results: every term matches some field (^ startswith, = exact, @ full text → contains)
function applySearch(a: ModelAdmin, qs: QuerySet<any>, q: string): QuerySet<any> {
  if (!q.trim() || !a.searchFields.length) return qs
  const terms = q.trim().split(/\s+/).slice(0, 10)
  for (const term of terms) {
    if (term.length > 200) throw bad('q', 'search term too long')
    let any: QNode | undefined
    for (const s of a.searchFields) {
      const path = s.replace(/^[\^=@]/, ''), f = a.model.fields[path]
      const col = f && f.kind !== 'fk' ? f.key(path) : path
      const op = s[0] === '^' ? 'istartswith' : s[0] === '=' ? 'exact' : 'icontains'
      const leaf = Q({ [`${col}__${op}`]: term })
      any = any ? any.or(leaf) : leaf
    }
    qs = qs.filter(any!)
  }
  return qs
}

// listDisplay column → { name, label, sortable, kind, order? (the order key), get(row) }
type Col = { name: string; label: string; sortable: boolean; kind: string; order?: string; boolean?: boolean; get: (r: Row) => unknown }
function columns(a: ModelAdmin): Col[] {
  return a.listDisplay.map((c): Col => {
    const self = a as unknown as Row
    if (typeof c === 'function' || (typeof c === 'string' && typeof self[c] === 'function')) {
      const fn = (typeof c === 'function' ? c : self[c]) as (o: Row) => unknown
      const d = displayOf(fn) ?? {}
      const name = typeof c === 'string' ? c : fn.name
      return { name, label: d.description ?? labelOf(name), sortable: !!d.ordering, order: d.ordering, kind: d.boolean ? 'bool' : 'computed', get: (r) => fn.call(a, r) }
    }
    if (c === '__str__') return { name: '__str__', label: a.verboseName ?? labelOf(a._key.split('.')[1]!), sortable: false, kind: 'text', get: (r) => a.str(r) }
    const f = a.model.fields[c]!
    const sortable = f.kind !== 'json' && (!a.sortableBy || a.sortableBy.includes(c))
    return { name: c, label: labelOf(c), sortable, order: f.key(c), kind: fieldMeta(c, f, metaOpts(a)).kind, get: (r) => toWire(f, r, c) }
  })
}

async function changelistQs(a: ModelAdmin, ctx: Ctx, p: ListParams, skip?: string): Promise<QuerySet<any>> {
  let qs = applySearch(a, scoped(a, ctx), p.q ?? '')
  const specs = filterSpecs(a)
  const filters = p.filters ?? {}
  for (const [k, v] of Object.entries(filters)) {
    if (a.dateHierarchy && k.startsWith(`${a.dateHierarchy}__`)) continue
    const s = specs.find((x) => x.name === k)
    if (!s) throw bad(`filters.${k}`, 'not a list filter of this model')
    if (k !== skip) qs = await applyFilter(a, ctx, qs, s, String(v))
  }
  return applyHierarchy(a, qs, filters)
}

function orderOf(a: ModelAdmin, qs: QuerySet<any>, ordering: string[] | undefined): QuerySet<any> {
  const cols = columns(a)
  let keys: string[]
  if (ordering?.length) {
    if (ordering.length > 5) throw bad('ordering', 'at most 5 columns')
    keys = ordering.map((o) => {
      const desc = o.startsWith('-'), c = cols.find((x) => x.name === (desc ? o.slice(1) : o))
      if (!c?.sortable || !c.order) throw bad('ordering', `"${o}" is not a sortable column`)
      return (desc ? '-' : '') + c.order
    })
  } else keys = a.ordering ?? a.model.meta.ordering ?? ['-id']
  // display ordering 'rel__count' (Django ordering on an annotation): annotate the count first
  for (const [i, k] of keys.entries()) {
    const m = /^(-?)(\w+)__count$/.exec(k)
    if (!m) continue
    const alias = `_n_${m[2]}`
    qs = qs.annotate({ [alias]: Count(m[2]!) })
    keys[i] = m[1] + alias
  }
  return qs.order(...keys)
}

async function relatedReprs(a: ModelAdmin, ctx: Ctx, rows: Row[], cols: Col[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  for (const c of cols) {
    const f = a.model.fields[c.name]
    if (f?.kind !== 'fk') continue
    const t = f.target!(), ids = [...new Set(rows.map((r) => r[f.key(c.name)]).filter((v) => v != null))]
    const objs = ids.length ? await scoped(t, ctx).inBulk(ids) : {}
    out.set(c.name, new Map(Object.entries(objs).map(([k, o]) => [k, repr(adminOfDef(t), t, o as Row)])))
  }
  return out
}

// dateHierarchy facets (the UI's drill-down): `<f>__year` counts, then `__month` once a year is chosen, then `__day`
async function hierarchyFacets(a: ModelAdmin, ctx: Ctx, p: ListParams): Promise<Record<string, { value: string; label: string; count: number }[]>> {
  const dh = a.dateHierarchy!, key = a.model.fields[dh]!.key(dh), f = p.filters ?? {}
  const base = applyHierarchy(a, await changelistQs(a, ctx, { ...p, filters: Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith(`${dh}__`))) }), {})
  // one query per level: a conditional COUNT per bucket (≤ 50 years, 12 months, 31 days)
  const counts = async (buckets: Record<string, number>[]) => {
    const r = await base.aggregate(Object.fromEntries(buckets.map((o, i) => [`c${i}`, Count('*', { filter: Object.fromEntries(Object.entries(o).map(([k, n]) => [`${key}__${k}`, n])) })])))
    return buckets.map((_, i) => Number(r[`c${i}`] ?? 0))
  }
  const y = f[`${dh}__year`], m = f[`${dh}__month`]
  const level = async (name: string, buckets: Record<string, number>[], label: (o: Record<string, number>) => string, part: string) => {
    const n = await counts(buckets)
    return { [`${dh}__${name}`]: buckets.flatMap((o, i) => (n[i] ? [{ value: String(o[part]), label: label(o), count: n[i]! }] : [])) }
  }
  if (y === undefined) {
    const { lo, hi } = await base.aggregate({ lo: Min(key), hi: Max(key) })
    if (!lo) return { [`${dh}__year`]: [] }
    const last = new Date(hi).getUTCFullYear(), years = []
    for (let yr = Math.max(new Date(lo).getUTCFullYear(), last - 49); yr <= last; yr++) years.push({ year: yr })
    return level('year', years, (o) => String(o.year), 'year')
  }
  if (m === undefined) return level('month', Array.from({ length: 12 }, (_, i) => ({ year: +y, month: i + 1 })), (o) => new Date(+y, o.month! - 1, 1).toLocaleString('en', { month: 'long' }), 'month')
  return level('day', Array.from({ length: new Date(+y, +m, 0).getDate() }, (_, i) => ({ year: +y, month: +m, day: i + 1 })), (o) => String(o.day), 'day')
}

// ---- delete collector (Django NestedObjects) --------------------------------------------------------------
type Tree = { model: string; pk: string; repr: string; children: Tree[] }
type Prot = { model: string; pk: string; repr: string; field: string }
async function collect(def: ModelDef, objs: Row[], depth = 0): Promise<{ tree: Tree[]; protectedRows: Prot[]; counts: Record<string, number> }> {
  const counts: Record<string, number> = {}
  const protectedRows: Prot[] = []
  const nodes = new Map<string, Tree>(objs.map((o) => [String(o.id), { model: site.keyOf(def), pk: String(o.id), repr: repr(adminOfDef(def), def, o), children: [] }]))
  counts[site.keyOf(def)] = objs.length
  if (depth > 8 || !objs.length) return { tree: [...nodes.values()], protectedRows, counts }
  for (const r of referencesTo(def)) {
    const od = r.f.opts.onDelete ?? 'RESTRICT', key = r.f.key(r.field)
    if (od === 'SET_NULL' || od === 'SET_DEFAULT' || od === 'DO_NOTHING') continue
    const src = modelNamed<AnyModel>(r.source.name)
    if (!src) continue
    // Django NestedObjects: a cascade sees every row, scoped or not
    const rows = await src.objects.filter({ [`${key}__in`]: objs.map((o) => o.id) }).all(od === 'CASCADE' ? MAX_PKS : 20)   // scope: ok
    if (od !== 'CASCADE') {   // PROTECT / RESTRICT (the fk default): the database refuses, so nothing is deleted
      for (const x of rows) protectedRows.push({ model: site.keyOf(r.source), pk: String(x.id), repr: repr(adminOfDef(r.source), r.source, x), field: r.field })
      continue
    }
    const sub = await collect(r.source, rows, depth + 1)
    protectedRows.push(...sub.protectedRows)
    for (const [k, n] of Object.entries(sub.counts)) counts[k] = (counts[k] ?? 0) + n
    for (const t of sub.tree) {
      const parent = rows.find((x) => String(x.id) === t.pk)?.[key]
      nodes.get(String(parent))?.children.push(t)
    }
  }
  return { tree: [...nodes.values()], protectedRows, counts }
}

async function selected(a: ModelAdmin, ctx: Ctx, pks: unknown[]): Promise<Row[]> {
  if (pks.length > MAX_PKS) throw bad('pks', `at most ${MAX_PKS}`)
  const ids = pks.map((p) => { const id = coercePk(a.model, p); if (id === undefined) throw bad('pks', `"${String(p)}" is not a valid key`); return id })
  if (!ids.length) return []
  return scoped(a, ctx).filter({ id__in: ids }).all(MAX_PKS)
}

async function deleteRows(a: ModelAdmin, ctx: Ctx, objs: Row[]): Promise<{ deleted: number; protected?: Prot[] }> {
  for (const o of objs) if (!(await a.hasDeletePermission(ctx, o))) throw forbidden()
  const c = await collect(a.model, objs)
  if (c.protectedRows.length) return { deleted: 0, protected: c.protectedRows }
  for (const o of objs) {
    await a.deleteModel(ctx, o)
    await logAction(ctx, a._key, o.id, a.str(o), DELETION, [])
  }
  return { deleted: objs.length }
}

// ---- inlines ---------------------------------------------------------------------------------------------
const inlineName = (i: InlineModelAdmin) => i.name ?? i._key.split('.')[1]!
// contract: inlines = Record<inlineName, Row[]>, Row = { pk?, DELETE?: true, ...values }; errors keyed `<inline>.<i>.<field>`
type InlineRow = Row & { pk?: string | number; DELETE?: boolean }
async function saveInlines(a: ModelAdmin, ctx: Ctx, parent: Row, given: Record<string, InlineRow[]> | undefined, msg: unknown[]): Promise<void> {
  const inl = site.inlinesOf(a)
  for (const name of Object.keys(given ?? {})) if (!inl.some((i) => inlineName(i) === name)) throw bad(name, 'not an inline of this model')
  for (const i of inl) {
    const name = inlineName(i), rows = given?.[name]
    if (!rows) continue
    if (!Array.isArray(rows) || rows.length > MAX_PKS) throw bad(name, 'rows must be a list')
    const fk = fkTo(i, a.model)!, fkKey = i.model.fields[fk]!.key(fk)
    const own = scoped(i, ctx).filter({ [fkKey]: parent.id })
    for (const [n, r] of rows.entries()) {
      const at = `${name}.${n}.`
      const existing = r.pk !== undefined ? await own.filter({ id: coercePk(i.model, r.pk) ?? -1 }).first() : undefined
      if (r.pk !== undefined && !existing) throw bad(`${at}pk`, 'not a row of this object')
      const { pk: _pk, DELETE, ...vals } = r
      if (DELETE) {
        if (!existing) continue
        if (!i.canDelete || !(await i.hasDeletePermission(ctx, parent))) throw forbidden()
        const prot = (await collect(i.model, [existing])).protectedRows   // Django: the formset refuses a protected row
        if (prot.length) throw fieldErrors({ DELETE: `Deleting ${i.str(existing)} would require deleting the following protected related objects: ${prot.map((x) => `${x.model} ${x.repr}`).join(', ')}` }, at)
        await i.model.delete(existing.id)
        msg.push({ deleted: { name: i.verboseName ?? labelOf(name), object: i.str(existing) } })
        continue
      }
      if (!(await (existing ? i.hasChangePermission(ctx, parent) : i.hasAddPermission(ctx, parent)))) throw forbidden()
      const c = clean(i, vals, !existing, formFields(i).filter((x) => x !== fk), existing ?? undefined)
      await cleanChoices(i, ctx, c, existing ?? undefined)
      if (Object.keys(c.errors).length) throw fieldErrors(c.errors, at)
      const row = existing ? await i.model.update(existing.id, c.data) : await i.model.create({ ...c.data, [fkKey]: parent.id })
      for (const [m, ids] of Object.entries(c.m2m)) await i.model.related(m, row.id).set(ids as (string | number)[])
      if (existing && !c.changed.length) continue
      msg.push(existing ? { changed: { name: i.verboseName ?? labelOf(name), object: i.str(row), fields: c.changed.map(labelOf) } } : { added: { name: i.verboseName ?? labelOf(name), object: i.str(row) } })
    }
    const total = await own.count()
    if (i.maxNum !== null && total > i.maxNum) throw bad(name, `at most ${i.maxNum} rows`)
    if (total < i.minNum) throw bad(name, `at least ${i.minNum} rows`)
  }
}

// =========================================================================================================
const staff = { permissions: [staffGuard] }   // staff + settings.admin allowIps / require2fa / idleMs
// agents = 'confirm' (auth.User / auth.Group by default): an agent's write answers confirm_required by 'human'
const agentConfirm = (p: { model: string }, ctx: ActionCtx) =>
  ctx.request.agent.is && site.adminFor(p.model)?.agents === 'confirm' ? { by: 'human' as const, message: `Change ${p.model}? (accounts and permissions)` } : undefined
const write = { ...staff, confirm: agentConfirm }
const read = { ...staff, readOnly: true }

export const siteAction = defineAction('site', z.object({}), async (_p, ctx) => {
  const apps = new Map<string, { label: string; name: string; models: unknown[] }>()
  for (const a of site.admins()) {
    if (a.agents === false && ctx.request.agent.is) continue
    if (!(await a.hasModulePermission(ctx))) continue
    const [app, short] = a._key.split('.') as [string, string]
    const g = apps.get(app) ?? { label: app, name: labelOf(app), models: [] }
    g.models.push({ key: a._key, name: a.verboseName ?? labelOf(short), namePlural: a.verboseNamePlural ?? `${a.verboseName ?? labelOf(short)}s`, perms: await perms(a, ctx) })
    apps.set(app, g)
  }
  const u = ctx.request.user
  const may = async (p?: string) => !p || !!u.isSuperuser || (!!u.hasPerm && (await u.hasPerm(p)))
  const pages = [], widgets = []
  for (const p of site.pages) if (await may(p.permission)) pages.push(p)
  for (const w of site.widgets) if (await may(w.permission)) widgets.push({ id: w.id, title: w.title, size: w.size, data: w.data.id, ...(w.component && { component: w.component }) })
  const s = ctx.settings.admin
  return {
    header: site.siteHeader, title: s.title ?? site.siteTitle, indexTitle: site.indexTitle, siteUrl: site.siteUrl, path: s.path, theme: s.theme,
    apps: [...apps.values()].sort((x, y) => x.label.localeCompare(y.label)), pages, widgets,
  }
}, read)

export const meta = defineAction('meta', z.object({ model: modelKey }), async ({ model }, ctx) => {
  const a = await gate(ctx, model, 'module')
  const [, short] = a._key.split('.') as [string, string]
  const fields = await withChoices(a, ctx, formMeta(a))
  const inlines = []
  for (const i of site.inlinesOf(a)) {
    const fk = fkTo(i, a.model)!
    inlines.push({
      name: inlineName(i), verboseName: i.verboseName ?? labelOf(i._key.split('.')[1]!), verboseNamePlural: i.verboseNamePlural ?? `${i.verboseName ?? labelOf(i._key.split('.')[1]!)}s`, kind: i.kind, model: i._key, fk, fields: formFields(i).filter((x) => x !== fk), extra: i.extra, max: i.maxNum ?? 1000, min: i.minNum,   // Django's default max_num is 1000
     
      canDelete: i.canDelete, meta: await withChoices(i, ctx, Object.fromEntries(Object.entries(formMeta(i)).filter(([n]) => n !== fk))), perms: await perms(i, ctx),
    })
  }
  const specs = filterSpecs(a)
  const filters = []
  for (const s of specs) filters.push({ name: s.name, label: s.label, kind: s.kind, choices: (await choicesOf(a, ctx, s)).map(([value, label]) => ({ value, label })) })
  const cols = columns(a)
  const actions = []
  for (const x of a.getActions(ctx)) if (await allowed(a, ctx, x)) actions.push({ name: x.name, description: x.description, confirm: x.confirm ?? false })
  return {
    key: a._key, name: a.verboseName ?? labelOf(short), namePlural: a.verboseNamePlural ?? `${a.verboseName ?? labelOf(short)}s`, pk: 'id',
    display: {
      listDisplay: cols.map(({ name, label, sortable, kind }) => ({ name, label, sortable, kind })),
      listDisplayLinks: a.listDisplayLinks ?? [cols[0]!.name], listEditable: a.listEditable, listPerPage: a.listPerPage, listMaxShowAll: a.listMaxShowAll,
      dateHierarchy: a.dateHierarchy, searchHelp: a.searchFields.length ? a.searchHelpText ?? `Search by ${a.searchFields.map((s) => labelOf(s.replace(/^[\^=@]/, '').replace(/__/g, ' '))).join(', ')}` : null,
      search: a.searchFields.length > 0, showFullResultCount: a.showFullResultCount, sortableBy: a.sortableBy, showFacets: a.showFacets, emptyValueDisplay: a.emptyValueDisplay, actions, filters, saveOnTop: a.saveOnTop, actionsOnTop: a.actionsOnTop,
    },
    form: { fieldsets: (a.fieldsets ?? [[null, { fields: formFields(a) }]]).map(([title, f]) => ({ title, classes: f.classes ?? [], description: f.description ?? null, fields: f.fields })), fields, inlines },
    perms: await perms(a, ctx), urls: site.customUrlMeta(a), agents: a.agents,
  }
}, read)

const listParams = z.object({
  model: modelKey, q: z.string().max(1000).optional(), filters: z.record(z.string().max(200)).optional(), ordering: z.array(z.string().max(100)).max(5).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).optional(), pageSize: z.coerce.number().int().min(1).max(10_000).optional(), all: z.coerce.boolean().optional(),
})
export const list = defineAction('list', listParams, async (p, ctx) => {
  const a = await gate(ctx, p.model, 'view')
  const cols = columns(a)
  const size = p.all ? a.listMaxShowAll : Math.min(p.pageSize ?? a.listPerPage, a.listMaxShowAll)
  const page = p.page ?? 1
  let rows: Row[], count: number
  if (a.changelist) ({ rows, count } = await a.changelist(ctx, { ...p, page, pageSize: size }))
  else {
    const qs = await changelistQs(a, ctx, p)
    count = await qs.count()
    if (p.all && count > a.listMaxShowAll) throw bad('all', `more than ${a.listMaxShowAll} rows`)
    if (page > 1 && (page - 1) * size >= count) throw bad('page', 'no such page')
    rows = await orderOf(a, qs, p.ordering).slice((page - 1) * size, page * size).all()   // LIMIT/OFFSET
  }
  const rel = await relatedReprs(a, ctx, rows, cols)
  const out = []
  for (const r of rows) {
    const values: Row = {}
    for (const c of cols) {
      const f = a.model.fields[c.name]
      values[c.name] = f?.kind === 'fk' ? (r[f.key(c.name)] == null ? null : rel.get(c.name)?.get(String(r[f.key(c.name)])) ?? String(r[f.key(c.name)])) : await c.get(r)
      if (values[c.name] instanceof Date) values[c.name] = (values[c.name] as Date).toISOString()
    }
    for (const n of a.listEditable) values[n] = toWire(a.model.fields[n]!, r, n)   // editable cells carry the raw value
    out.push({ pk: String(r.id), values })
  }
  let facets: Record<string, { value: string; label: string; count: number }[]> | undefined
  if (a.showFacets && !a.changelist && a.listFilter.length) {
    facets = {}
    for (const s of filterSpecs(a)) {
      const base = await changelistQs(a, ctx, p, s.name)
      const ch = (await choicesOf(a, ctx, s)).slice(0, 50)
      const n = await facetCounts(a, ctx, base, s, ch)
      facets[s.name] = ch.map(([value, label], i) => ({ value, label, count: n[i]! }))
    }
  }
  if (a.dateHierarchy && !a.changelist) (facets ??= {}) && Object.assign(facets, await hierarchyFacets(a, ctx, p))
  const filtered = !!(p.q?.trim() || Object.keys(p.filters ?? {}).length)
  const fullCount = a.showFullResultCount && filtered && !a.changelist ? await scoped(a, ctx).count() : undefined
  return { rows: out, count, page, pages: Math.max(1, Math.ceil(count / size)), ...(fullCount !== undefined && { fullCount }), ...(facets && { facets }) }
}, read)

export const get = defineAction('get', z.object({ model: modelKey, pk: pkParam }), async ({ model, pk }, ctx) => {
  const a = await gate(ctx, model, 'module')
  const obj = await objectOf(a, ctx, pk)
  if (!(await a.hasViewPermission(ctx, obj))) throw forbidden()
  const inlines: Record<string, { rows: Row[] }> = {}
  for (const i of site.inlinesOf(a)) {
    if (!(await i.hasViewPermission(ctx, obj))) continue
    const fk = fkTo(i, a.model)!
    const rows = await scoped(i, ctx).filter({ [i.model.fields[fk]!.key(fk)]: obj.id }).order(...(i.ordering ?? ['id'])).all(MAX_PKS)
    const vs = []
    for (const r of rows) { const v = await valuesOf(i, ctx, r); delete v[fk]; vs.push({ pk: String(r.id), ...v }) }   // the payload's Row shape: { pk, ...values }
    inlines[inlineName(i)] = { rows: vs }
  }
  return { pk: String(obj.id), values: await valuesOf(a, ctx, obj), display: a.str(obj), inlines, perms: await perms(a, ctx, obj) }
}, read)

const saveParams = z.object({ model: modelKey, pk: pkParam.optional(), values: z.record(z.unknown()).default({}), inlines: z.record(z.array(z.object({ pk: pkParam.optional(), DELETE: z.boolean().optional() }).passthrough()).max(MAX_PKS)).optional() })
// multipart file parts (transport/api.ts): `<field>` or `<inline>.<i>.<field>`, each checked against its field's
// upload limits (FieldMeta.upload: accept, maxBytes) and stored; the value becomes the storage key
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const FILE_MAX = 5 * 1024 * 1024
const typesOf = (accept: string) => accept.split(',').map((t) => t.trim()).flatMap((t) => (t === 'image/*' ? IMAGE_TYPES : [t]))
async function storeFiles(a: ModelAdmin, ctx: Ctx, p: z.infer<typeof saveParams>, stored: string[]): Promise<void> {
  for (const part of filePartsOf(ctx.request)) {
    const m = /^(?:(\w+)\.(\d{1,4})\.)?(\w+)$/.exec(part.field)
    const owner: Base | undefined = !m ? undefined : m[1] ? site.inlinesOf(a).find((i) => inlineName(i) === m[1]) : a
    const f = owner && formFields(owner).includes(m![3]!) ? owner.model.fields[m![3]!] : undefined
    const up = f && fieldMeta(m![3]!, f, metaOpts(owner!)).upload
    if (!up) throw bad(part.field, 'not a file field of this form')
    if (m![1] && !p.inlines?.[m![1]]?.[+m![2]!]) throw bad(part.field, 'no such inline row')   // the row's values come in params
    const file = await storePart(part, { maxBytes: up.maxBytes ?? FILE_MAX, types: typesOf(up.accept), uploadTo: f!.opts.uploadTo }, ctx.settings.media)
    stored.push(file.key)
    if (!m![1]) p.values[m![3]!] = file.key
    else {
      p.inlines![m![1]]![+m![2]!]![m![3]!] = file.key
    }
  }
}
async function save(p: z.infer<typeof saveParams>, ctx: Ctx, creating: boolean) {
  const a = await gate(ctx, p.model, 'module')
  const obj = creating ? undefined : await objectOf(a, ctx, p.pk)
  if (!(await (creating ? a.hasAddPermission(ctx) : a.hasChangePermission(ctx, obj)))) throw forbidden()
  const stored: string[] = []
  try { return await saveChecked(a, p, ctx, creating, obj, stored) } catch (e) {
    const disk = new DiskStorage(ctx.settings.media.dir, ctx.settings.media.route)
    await Promise.all(stored.map((k) => disk.delete(k)))   // the request rolled back: no orphan files
    throw e
  }
}
async function saveChecked(a: ModelAdmin, p: z.infer<typeof saveParams>, ctx: Ctx, creating: boolean, obj: Row | undefined, stored: string[]) {
  await storeFiles(a, ctx, p, stored)
  const c = clean(a, p.values, creating, undefined, obj, ctx.request.agent.is)
  await cleanChoices(a, ctx, c, obj)
  if (Object.keys(c.errors).length) throw fieldErrors(c.errors)
  const row = (await a.saveModel(ctx, obj as never, c.data)) as Row
  for (const [n, ids] of Object.entries(c.m2m)) await a.model.related(n, row.id).set(ids as (string | number)[])
  const msg: unknown[] = creating ? [{ added: {} }] : c.changed.length ? [{ changed: { fields: c.changed.map(labelOf) } }] : []
  await saveInlines(a, ctx, row, p.inlines, msg)
  await logAction(ctx, a._key, row.id, a.str(row), creating ? ADDITION : CHANGE, msg)
  return { ok: true, pk: String(row.id) }
}
// files ride as multipart (transport/api.ts); 50 MB per request, each file capped by its field
const MULTIPART = {
  maxBytes: 50 * 1024 * 1024,
  // one file part may be as big as the largest upload field any admin has (default 5 MB): the transport stops past it
  // ponytail: recomputed per multipart request; cache it if admins get large
  get partBytes() {
    let m = FILE_MAX
    for (const a of site.admins()) for (const b of [a as Base, ...site.inlinesOf(a)]) for (const n of formFields(b)) {
      const f = b.model.fields[n], up = f && fieldMeta(n, f, metaOpts(b)).upload
      if (up) m = Math.max(m, up.maxBytes ?? FILE_MAX)
    }
    return m
  },
}
export const create = Object.assign(defineAction('create', saveParams.omit({ pk: true }), (p, ctx) => save(p, ctx, true), write), { multipart: MULTIPART })
export const update = Object.assign(defineAction('update', saveParams.required({ pk: true }), (p, ctx) => save(p, ctx, false), write), { multipart: MULTIPART })

const pksParams = z.object({ model: modelKey, pks: z.array(pkParam).max(MAX_PKS) })
export const remove = defineAction('delete', pksParams, async ({ model, pks }, ctx) => {
  const a = await gate(ctx, model, 'delete')
  return deleteRows(a, ctx, await selected(a, ctx, pks))
}, { ...write, destructive: true })

export const deletePreview = defineAction('deletePreview', pksParams, async ({ model, pks }, ctx) => {
  const a = await gate(ctx, model, 'delete')
  const c = await collect(a.model, await selected(a, ctx, pks))
  // Django perms_needed: cascaded models (with an admin) this user cannot delete
  const permsNeeded = []
  for (const k of Object.keys(c.counts)) { const x = site.adminFor(k); if (x && !(await x.hasDeletePermission(ctx))) permsNeeded.push(k) }
  return { objects: c.tree, protected: c.protectedRows, summary: c.counts, permsNeeded }
}, read)

async function allowed(a: ModelAdmin, ctx: Ctx, x: AdminAction): Promise<boolean> {
  if (x.humanOnly && ctx.request.agent.is) return false
  for (const p of x.permissions ?? []) if (!(await checkPerm(a, ctx, p))) return false
  return true
}
export const action = defineAction('action', z.object({
  model: modelKey, action: z.string().max(100), pks: z.array(pkParam).max(MAX_PKS).optional(), selectAll: z.boolean().optional(),
  q: z.string().max(1000).optional(), filters: z.record(z.string().max(200)).optional(),
}), async (p, ctx): Promise<ActionResult> => {
  const a = await gate(ctx, p.model, 'view')
  const x = a.getActions(ctx).find((y) => y.name === p.action)
  if (!x) throw bad('action', 'not an action of this model')
  if (!(await allowed(a, ctx, x))) throw forbidden()
  let pks: string[]
  if (p.selectAll) {
    pks = a.changelist ? (await a.changelist(ctx, { q: p.q, filters: p.filters, page: 1, pageSize: MAX_PKS })).rows.map((r) => String((r as Row).id))
      : (await (await changelistQs(a, ctx, p)).valuesList('id', { flat: true }).all(MAX_PKS)).map(String)
  } else pks = (p.pks ?? []).map(String)
  if (!pks.length) return { message: 'Items must be selected in order to perform actions on them. No items have been changed.', level: 'warning' }
  if (x.name === 'deleteSelected') {
    const r = await deleteRows(a, ctx, await selected(a, ctx, pks))
    return r.protected ? { message: `Cannot delete: ${r.protected.length} related object(s) are protected.`, level: 'error' } : { message: `Successfully deleted ${r.deleted} ${a.verboseNamePlural ?? labelOf(a._key.split('.')[1]!)}.`, level: 'success' }
  }
  const ids = a.changelist ? pks : (await selected(a, ctx, pks)).map((r) => String(r.id))
  // always the selected rows only (options.ts AdminActionFn): a custom changelist's pks narrow the queryset too
  const qs = scoped(a, ctx).filter({ id__in: ids.map((i) => coercePk(a.model, i)).filter((k) => k !== undefined) })
  const res = (await x.fn(a, ctx, qs, ids)) ?? {}
  for (const id of ids) await logAction(ctx, a._key, id, `${a._key} ${id}`, CHANGE, [{ action: x.name }])
  return { message: res.message ?? `${x.description}: ${ids.length} item(s).`, level: res.level ?? 'success', ...(res.download && { download: res.download }) }
}, write)

export const autocomplete = defineAction('autocomplete', z.object({ model: modelKey, field: z.string().max(100), q: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(1000).default(1) }), async (p, ctx) => {
  // the source: the model's admin or an inline of some admin (Django AutocompleteJsonView.process_request)
  const src = site.admins().flatMap((a) => [a as Base, ...site.inlinesOf(a)]).find((a) => a._key === p.model)
  const f = src?.model.fields[p.field]
  if (!src || !f || (f.kind !== 'fk' && f.kind !== 'm2m')) throw bad('field', 'not a relation field of a registered model')
  if (!src.autocompleteFields.includes(p.field)) throw bad('field', 'not in autocompleteFields')   // Django: only those fields get the endpoint
  const target = adminOfDef(f.target!())
  if (!target) throw bad('field', 'the related model has no admin')
  if (!(await target.hasViewPermission(ctx))) throw forbidden()
  if (target.agents === false && ctx.request.agent.is) throw forbidden()
  const size = 20
  const qs = applySearch(target, scoped(target, ctx), p.q).order(...(target.ordering ?? ['id']))
  const rows = await qs.slice((p.page - 1) * size, p.page * size + 1).all()   // one extra row tells `more`
  return { results: rows.slice(0, size).map((r: Row) => ({ pk: String(r.id), text: target.str(r) })), more: rows.length > size }
}, read)

export const history = defineAction('history', z.object({ model: modelKey, pk: pkParam }), async ({ model, pk }, ctx) => {
  const a = await gate(ctx, model, 'module')
  // Django history_view: get_object None → not found (a deleted row too: no model-perm fallback that would show
  // another tenant's LogEntry rows)
  const obj = await objectOf(a, ctx, pk)
  if (!(await a.hasViewPermission(ctx, obj))) throw forbidden()
  const rows = await LogEntry.objects.filter({ contentType: a._key, objectId: String(pk) }).order('actionTime', 'id').all(MAX_PKS)
  const User = modelNamed<AnyModel>('auth_user')
  const ids = [...new Set(rows.map((r) => r.userId).filter((x) => /^\d+$/.test(x)))].map(Number)
  const users = User && ids.length ? await User.objects.inBulk(ids) : {}
  const FLAG = { 1: 'add', 2: 'change', 3: 'delete' } as Record<number, string>
  return rows.map((r) => ({
    id: r.id, actionTime: r.actionTime.toISOString(), user: { id: r.userId, name: (users[r.userId] as Row | undefined)?.username ?? r.userId },
    actionFlag: r.actionFlag, action: FLAG[r.actionFlag], objectRepr: r.objectRepr, changeMessage: r.changeMessage,
  }))
}, read)

export const listEdit = defineAction('listEdit', z.object({ model: modelKey, rows: z.array(z.object({ pk: pkParam, values: z.record(z.unknown()) })).max(MAX_PKS) }), async (p, ctx) => {
  const a = await gate(ctx, p.model, 'change')
  const objs = await selected(a, ctx, p.rows.map((r) => r.pk))
  const work = []
  const errors: Record<string, string> = {}   // `rows.<i>.<field>`, like an inline row's errors in create/update
  for (const [i, r] of p.rows.entries()) {
    const obj = objs.find((o) => String(o.id) === String(r.pk))
    if (!obj) { errors[`rows.${i}.pk`] = 'Not found.'; continue }
    if (!(await a.hasChangePermission(ctx, obj))) throw forbidden()
    const c = clean(a, r.values, false, a.listEditable, obj, ctx.request.agent.is)
    await cleanChoices(a, ctx, c, obj)
    for (const [f, m] of Object.entries(c.errors)) errors[`rows.${i}.${f}`] = m
    if (!Object.keys(c.errors).length) work.push({ obj, c })
  }
  if (Object.keys(errors).length) throw fieldErrors(errors)   // Django formset: one invalid row saves nothing
  for (const { obj, c } of work) {
    if (!c.changed.length) continue
    const row = (await a.saveModel(ctx, obj as never, c.data)) as Row
    await logAction(ctx, a._key, row.id, a.str(row), CHANGE, [{ changed: { fields: c.changed.map(labelOf) } }])
  }
  return { ok: true, updated: work.filter((w) => w.c.changed.length).length }
}, write)


// ---- dashboard + palette + per-user prefs ---------------------------------------------------------------
const FLAGS: Record<number, string> = { 1: 'add', 2: 'change', 3: 'delete' }
// the current user's recent LogEntry rows (Django admin index "Recent actions")
export const recent = defineAction('recent', z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }), async ({ limit }, ctx) => {
  const rows = await LogEntry.objects.filter({ userId: String(ctx.request.user.id ?? '') }).order('-actionTime', '-id').all(limit)
  return rows.map((r) => ({ id: r.id, actionTime: r.actionTime.toISOString(), model: r.contentType, pk: r.objectId, objectRepr: r.objectRepr, actionFlag: r.actionFlag, action: FLAGS[r.actionFlag], changeMessage: r.changeMessage }))
}, read)

// ⌘K palette: every model with searchFields this user may view, top N each (getQueryset-scoped)
export const search = defineAction('search', z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(20).default(5) }), async ({ q, limit }, ctx) => {
  const out = []
  for (const a of site.admins()) {
    if (!a.searchFields.length || a.changelist || (a.agents === false && ctx.request.agent.is) || !(await a.hasViewPermission(ctx))) continue
    const rows = await applySearch(a, scoped(a, ctx), q).order(...(a.ordering ?? ['-id'])).all(limit)
    if (rows.length) out.push({ model: a._key, name: a.verboseNamePlural ?? `${a.verboseName ?? labelOf(a._key.split('.')[1]!)}s`, results: rows.map((r: Row) => ({ pk: String(r.id), text: a.str(r) })) })
  }
  return { results: out }
}, read)

// per-user prefs (saved filters, column choices): get → every key; set → one key (value null deletes)
const PREF_BYTES = 16 * 1024, PREF_KEYS = 100
export const prefs = defineAction('prefs', z.object({ key: z.string().regex(/^[\w.:-]{1,100}$/).optional(), value: z.unknown().optional() }), async ({ key, value }, ctx) => {
  const userId = String(ctx.request.user.id ?? '')
  if (!userId) throw forbidden()
  const mine = AdminPref.objects.filter({ userId })
  if (key !== undefined && value !== undefined) {
    const prev = await mine.filter({ key }).first()
    if (value === null) { if (prev) await AdminPref.delete(prev.id) }
    else {
      const size = Buffer.byteLength(JSON.stringify(value))
      if (size > PREF_BYTES) throw bad('value', `at most ${PREF_BYTES} bytes`)
      if (prev) await AdminPref.update(prev.id, { value, updatedAt: new Date() })
      else {
        if ((await mine.count()) >= PREF_KEYS) throw bad('key', `at most ${PREF_KEYS} saved preferences`)
        await AdminPref.create({ userId, key, value })
      }
    }
  }
  return Object.fromEntries((await mine.all(PREF_KEYS)).map((r) => [r.key, r.value]))
}, staff)
