// defineModel: one field definition → zod schema, columns, and Model.objects.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DomainError, zodErrors } from '../core/errors.js'
import { QuerySet } from './queryset.js'
import { aggregateRows, atomic, bulkUpdate, engineSource, existsRows, insertMany, insertRow } from './engine.js'
import { concrete, hasDefault, isAuto, keyOf, pkField, rowSchema, type Create, type Fields, type ModelMeta, type Row } from './fields.js'
import { defineChecked } from './registry.js'
import { prefetch, related, type RelatedManager } from './related.js'
import { checkIdent } from './sql/dialect.js'
import { trackMethods } from './pending.js'

// with or without await (pending.ts): every public call is tracked by the enclosing request / job / atomic()
trackMethods(QuerySet.prototype as never, ['page', 'all', 'fetchAll', 'first', 'last', 'count', 'exists', 'aggregate', 'inBulk'], false)
trackMethods(QuerySet.prototype as never, ['update', 'delete', 'getOrCreate', 'updateOrCreate', 'bulkCreate', 'bulkUpdate'], true)

export interface Model<F extends Fields = Fields, T extends object = Row<F>> {
  readonly name: string
  readonly fields: F
  readonly schema: z.ZodType<T>
  readonly objects: QuerySet<T>
  create(data: Create<F>): Promise<T>
  get(id: string | number): Promise<T | undefined>
  update(id: string | number, patch: Partial<Record<keyof T & string, unknown>>): Promise<T>
  delete(id: string | number): Promise<void>
  readonly meta: ModelMeta
  // m2m / reverse-fk manager: Product.related('tags', id).add(3) — orm-advanced.md §4
  related(name: string, id: string | number): RelatedManager
}

const registry = new Map<string, Model<any, any>>()
export const modelRegistry = (): Model<any, any>[] => [...registry.values()]   // last definition per name wins

export function defineModel<const F extends Fields>(name: string, fields: F, meta: ModelMeta = {}): Model<F> {
  const def = { name, fields, meta }
  const [pkName, pkF] = pkField(def)
  for (const [n, f] of Object.entries(fields)) (f as { bind?: (m: string, n: string, pk: { name: string; kind: string }) => void }).bind?.(name, n, { name: pkF.columns(pkName)[0]!, kind: pkF.kind })
  checkMeta(name, fields, meta)
  for (const [n, f] of Object.entries(fields)) if (f.kind === 'money' && f.opts.searchable) throw new Error(`${name}.${n}: a money field cannot be searchable`)
  const schema = rowSchema(def)
  const source = engineSource(def)
  const objects = new QuerySet<any>(source, undefined, Object.entries(fields).filter(([, f]) => f.opts.searchable).map(([n, f]) => keyOf(n, f)))
  const input = z.object(Object.fromEntries(concrete(fields).map(([n, f]) => {
    const k = keyOf(n, f)
    return [k, hasDefault(f) ? schema.shape[k].optional() : schema.shape[k]]
  }))).strict()

  // validated create data, defaults filled (uuid, auto datetime, default)
  const prepare = (data: Record<string, unknown>) => {
    const r = input.safeParse(data)
    if (!r.success) {
      const { errors, field } = zodErrors(r.error.issues as never)
      throw new DomainError('invalid_param', r.error.issues.map(i => `${name}.${i.path.join('.')}: ${i.message}`).join('; '), field, errors)
    }
    const row: Record<string, unknown> = { ...r.data }
    for (const [n, f] of concrete(fields)) {
      const k = keyOf(n, f)
      if (row[k] !== undefined) continue
      if (f.kind === 'uuid') row[k] = randomUUID()
      else if (isAuto(f.opts) && (f.kind === 'datetime' || f.kind === 'date')) row[k] = new Date()
      else if (f.opts.default !== undefined) row[k] = f.opts.default
    }
    return row
  }
  source.ext = {
    aggregate: (spec, aggs) => aggregateRows(def, spec, aggs),
    exists: spec => existsRows(def, spec),
    prefetch: (items, lookups) => prefetch(def, items, lookups),
    atomic: fn => atomic(fn),
    prepare,
    insert: async (row, ignoreConflicts) => insertRow(def, row, { ignoreConflicts }),
    insertMany: (rows, batch) => insertMany(def, rows, batch),
    bulkUpdate: (rows, fs, batch) => bulkUpdate(def, rows, fs, batch),
  }

  const model: Model<F> = {
    name, fields, meta, schema: schema as unknown as z.ZodType<Row<F>>, objects,
    create: async data => insertRow(def, prepare(data as Record<string, unknown>)),
    get: id => source.get(id),
    async update(id, patch) {
      // Django auto_now: Model.update is save(); a QuerySet.update() leaves the field alone (Django too)
      const now: Record<string, unknown> = {}
      for (const [n, f] of concrete(fields)) if (f.opts.autoNow && !(keyOf(n, f) in patch)) now[keyOf(n, f)] = new Date()
      const data = { ...now, ...patch }
      const n = Object.keys(data).length ? await objects.filter({ id }).update(data) : 1   // nothing to write (a form saved unchanged): still a save
      const row = n ? await source.get(id) : undefined
      if (!row) throw new DomainError('domain', `${name} ${id} not found`)
      return row
    },
    async delete(id) { await objects.filter({ id }).delete() },
    related: (rel, id) => { const m = related(def, rel, id, atomic); trackMethods(m as never, ['add', 'remove', 'set', 'clear'], true); return m },
  }
  trackMethods(model as never, ['get'], false)
  trackMethods(model as never, ['create', 'update', 'delete'], true)
  defineChecked(def, model)   // reverse-name clashes are a definition error (Django's system check)
  registry.set(name, model)
  return model
}

// Meta + fk options are checked when the model is defined, not when a migration first runs
function checkMeta(name: string, fields: Fields, meta: ModelMeta): void {
  const has = (f: string, where: string) => {
    const x = fields[f]
    if (!x) throw new Error(`${name} Meta ${where}: unknown field "${f}"`)
    if (x.kind === 'm2m') throw new Error(`${name} Meta ${where}: "${f}" is a many-to-many field (no column)`)
  }
  for (const f of meta.personalData ?? []) {
    has(f, 'personalData')
    // erase's default 'anonymize' blanks a field: nullable, or text-like (''); anything else needs Meta.onErase
    const x = fields[f]!
    if ((meta.onErase ?? 'anonymize') === 'anonymize' && !x.opts.optional && !['text', 'email', 'slug', 'url', 'encrypted'].includes(x.kind))
      throw new Error(`${name} Meta personalData: "${f}" (${x.kind}, not optional) cannot be anonymized: set Meta.onErase to 'delete' or a function`)
  }
  for (const [n, f] of Object.entries(fields)) {
    const od = f.opts.onDelete
    if (od !== undefined && f.kind !== 'fk') throw new Error(`${name}.${n}: onDelete is an fk option`)
    if (od === 'SET_NULL' && !f.opts.optional) throw new Error(`${name}.${n}: onDelete SET_NULL needs optional: true`)
    if (od === 'SET_DEFAULT' && f.opts.default === undefined) throw new Error(`${name}.${n}: onDelete SET_DEFAULT needs a default`)
    if (od !== undefined && !['CASCADE', 'PROTECT', 'SET_NULL', 'SET_DEFAULT', 'RESTRICT', 'DO_NOTHING'].includes(od)) throw new Error(`${name}.${n}: unknown onDelete ${JSON.stringify(od)}`)
    if (f.opts.relatedName !== undefined) checkIdent(f.opts.relatedName)
  }
  for (const ix of meta.indexes ?? []) {
    const d = Array.isArray(ix) ? { fields: ix } : ix
    if (!d.fields?.length) throw new Error(`${name} Meta indexes: an index needs fields`)
    d.fields.forEach(f => has(f, 'indexes'))
    if (d.name !== undefined && (checkIdent(d.name).length > 63)) throw new Error(`${name} Meta index name "${d.name}" is longer than 63 characters`)
  }
  for (const u of meta.unique ?? []) {
    if (!Array.isArray(u) || u.length < 1) throw new Error(`${name} Meta unique: each entry is a list of fields`)
    u.forEach(f => has(f, 'unique'))
  }
  for (const c of meta.constraints ?? []) {
    if (c.kind === 'unique') c.fields.forEach(f => has(f, `constraint ${c.name}`))
  }
  for (const o of meta.ordering ?? []) if (typeof o !== 'string') throw new Error(`${name} Meta ordering: field names ('-field' for descending)`)
}
