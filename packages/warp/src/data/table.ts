// A Table COLLECTS its fields: every statement is assembled from field.columns / toDb / fromDb /
// lookup / columnDDL. Output is only ever Statement = { sql, params }.
import { DomainError } from '../core/errors.js'
import { bin, col, param, type Expr } from './sql/ast.js'
import { compile, resolve, whereOf } from './sql/compile.js'
import type { Dialect, Statement } from './sql/dialect.js'
import { Expr as Delta, pkField, type Fields, type ModelDef } from './fields.js'
import type { QuerySpec, Where } from './queryset.js'

const cache = new WeakMap<Fields, Table>()

export class Table {
  private constructor(readonly name: string, readonly fields: Fields) {}
  static of(def: ModelDef): Table {
    let t = cache.get(def.fields)
    if (!t) cache.set(def.fields, (t = new Table(def.name, def.fields)))
    return t
  }

  private get entries() { return Object.entries(this.fields) }

  hydrate(row: Record<string, unknown>, d: Dialect): Record<string, unknown> {
    return Object.fromEntries(this.entries.map(([n, f]) => [f.key(n), f.fromDb(row, n, d)]))
  }

  // only the keys present in `data` (by property name); absent keys fall to column defaults
  private assignments(data: Record<string, unknown>, d: Dialect): [string, unknown][] {
    return this.entries.flatMap(([n, f]) => {
      const k = f.key(n)
      if (!(k in data) || data[k] === undefined) return []
      const vals = f.toDb(data[k], d)
      return f.columns(n).map((c, i): [string, unknown] => [c, vals[i]])
    })
  }

  insert(data: Record<string, unknown>, d: Dialect): Statement {
    const a = this.assignments(data, d)
    return d.render({ t: 'insert', into: this.name, cols: a.map(([c]) => c), values: a.map(([, v]) => param(v)), returning: true })
  }

  get(id: unknown, d: Dialect): Statement {
    const [n, f] = pkField(this)
    return d.render({ t: 'select', from: this.name, where: f.lookup('eq', col(n), id, d), limit: 1 })
  }

  query(spec: QuerySpec, d: Dialect): { count: Statement; page?: Statement } {
    const { count, page } = compile(spec, this, d)
    return { count: d.render(count), page: page && d.render(page) }
  }

  // undefined = nothing to set. Values are validated by each field; inc/dec become `col ± ?`.
  update(ws: Where[], patch: Record<string, unknown>, d: Dialect): Statement | undefined {
    const set: [string, Expr][] = []
    for (const [name, v] of Object.entries(patch)) {
      const { f, field, col: c } = resolve(this, name)
      if (v instanceof Delta) {
        if (f.kind !== 'int' && f.kind !== 'float') throw new DomainError('invalid_param', `${this.name}.${field} cannot use inc/dec`, field)
        set.push([f.columns(field)[0], bin(v.op === 'dec' ? '-' : '+', c, param(v.n))])
        continue
      }
      const r = f.schema().safeParse(v)
      if (!r.success) throw new DomainError('invalid_param', `${this.name}.${field}: ${r.error.issues[0].message}`, field)
      const vals = f.toDb(r.data, d)
      f.columns(field).forEach((cn, i) => set.push([cn, param(vals[i])]))
    }
    if (!set.length) return undefined
    return d.render({ t: 'update', table: this.name, set, where: whereOf(this, ws, d) })
  }

  delete(ws: Where[], d: Dialect): Statement {
    return d.render({ t: 'delete', from: this.name, where: whereOf(this, ws, d) })
  }

  // CREATE TABLE + one CREATE INDEX per `index: true` field (tests / ad-hoc tables; migrations
  // render the same field DDL through schema/operations.ts).
  createSQL(d: Dialect): Statement[] {
    pkField(this)
    const columns = [...this.entries.flatMap(([n, f]) => f.columnDDL(n, d)), ...this.entries.flatMap(([n, f]) => f.tableConstraints(this.name, n, d))]
    const out = [d.render({ t: 'createTable', name: this.name, columns })]
    for (const [n, f] of this.entries) {
      if (f.opts.index) out.push(d.render({ t: 'createIndex', name: `${this.name}_${n}_idx`, table: this.name, cols: [f.columns(n)[0]] }))
    }
    return out
  }
}
