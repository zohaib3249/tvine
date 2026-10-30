// defineModel: one field definition → zod schema, columns, and Model.objects.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DomainError } from '../core/errors.js'
import { QuerySet } from './queryset.js'
import { engineSource, insertRow } from './engine.js'
import { hasDefault, keyOf, pkField, rowSchema, type Create, type Fields, type Row } from './fields.js'

export interface Model<F extends Fields = Fields, T extends object = Row<F>> {
  readonly name: string
  readonly fields: F
  readonly schema: z.ZodType<T>
  readonly objects: QuerySet<T>
  create(data: Create<F>): Promise<T>
  get(id: string | number): Promise<T | undefined>
  update(id: string | number, patch: Partial<Record<keyof T & string, unknown>>): Promise<T>
  delete(id: string | number): Promise<void>
}

const registry = new Map<string, Model<any, any>>()
export const modelRegistry = (): Model<any, any>[] => [...registry.values()]   // last definition per name wins

export function defineModel<const F extends Fields>(name: string, fields: F): Model<F> {
  const def = { name, fields }
  pkField(def)
  for (const [n, f] of Object.entries(fields)) if (f.kind === 'money' && f.opts.searchable) throw new Error(`${name}.${n}: a money field cannot be searchable`)
  const schema = rowSchema(def)
  const source = engineSource(def)
  const objects = new QuerySet<any>(source, undefined, Object.entries(fields).filter(([, f]) => f.opts.searchable).map(([n, f]) => keyOf(n, f)))
  const input = z.object(Object.fromEntries(Object.entries(fields).map(([n, f]) => {
    const k = keyOf(n, f)
    return [k, hasDefault(f) ? schema.shape[k].optional() : schema.shape[k]]
  }))).strict()

  const model: Model<F> = {
    name, fields, schema: schema as unknown as z.ZodType<Row<F>>, objects,
    async create(data) {
      const r = input.safeParse(data)
      if (!r.success) {
        const i = r.error.issues[0]
        throw new DomainError('invalid_param', `${name}.${i.path.join('.')}: ${i.message}`, String(i.path[0]))
      }
      const row: Record<string, unknown> = { ...r.data }
      for (const [n, f] of Object.entries(fields)) {
        const k = keyOf(n, f)
        if (row[k] !== undefined) continue
        if (f.kind === 'uuid') row[k] = randomUUID()
        else if (f.opts.auto && f.kind === 'datetime') row[k] = new Date()
        else if (f.opts.default !== undefined) row[k] = f.opts.default
      }
      return insertRow(def, row)
    },
    get: id => source.get(id),
    async update(id, patch) {
      const n = await objects.filter({ id }).update(patch)
      const row = n ? await source.get(id) : undefined
      if (!row) throw new DomainError('domain', `${name} ${id} not found`)
      return row
    },
    async delete(id) { await objects.filter({ id }).delete() },
  }
  registry.set(name, model)
  return model
}
