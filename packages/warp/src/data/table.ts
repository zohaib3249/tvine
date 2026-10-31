// A Table COLLECTS its fields: every statement is assembled from field.columns / toDb / fromDb /
// lookup / columnDDL. Output is only ever Statement = { sql, params }.
import { DomainError } from '../core/errors.js'
import { bin, col, inList, param, type Expr } from './sql/ast.js'
import { compile, resolve, whereOf, writeScope } from './sql/compile.js'
import type { Dialect, Statement } from './sql/dialect.js'
import { Expr as Delta, concrete, pkField, type Fields, type ModelDef } from './fields.js'
import type { QuerySpec, Where } from './queryset.js'
import { Expression, type QNode } from './expressions.js'

const cache = new WeakMap<Fields, Table>()

export class Table {
  private constructor(readonly name: string, readonly fields: Fields) {}
  static of(def: ModelDef): Table {
    let t = cache.get(def.fields)
    if (!t) cache.set(def.fields, (t = new Table(def.name, def.fields)))
    return t
  }

  private get entries() { return concrete(this.fields) }

  hydrate(row: Record<string, unknown>, d: Dialect): Record<string, unknown> {
    return Object.fromEntries(this.entries.map(([n, f]) => [f.key(n), f.fromDb(row, n, d)]))
  }

  // only the keys present in `data` (by property name); absent keys fall to column defaults
  private assignments(data: Record<string, unknown>, d: Dialect): [string, unknown][] {
    return this.entries.flatMap(([n, f]) => {
      const k = f.key(n)
      if (!(k in data) || data[k] === undefined) return []
      const vals = named(this.name, n, () => f.toDb(data[k], d))
      return f.columns(n).map((c, i): [string, unknown] => [c, vals[i]])
    })
  }

  insert(data: Record<string, unknown>, d: Dialect, ignoreConflicts = false): Statement {
    const a = this.assignments(data, d)
    return d.render({ t: 'insert', into: this.name, cols: a.map(([c]) => c), values: a.map(([, v]) => param(v)), returning: true, ...(ignoreConflicts ? { ignoreConflicts } : {}) })
  }

  columnsFor(data: Record<string, unknown>): string[] { return this.entries.flatMap(([n, f]) => (f.key(n) in data && data[f.key(n)] !== undefined ? f.columns(n) : [])) }

  // one multi-row INSERT; every row sets the same keys (engine.insertMany checks)
  insertMany(rows: Record<string, unknown>[], d: Dialect): Statement {
    const all = rows.map(r => this.assignments(r, d))
    return d.render({ t: 'insert', into: this.name, cols: all[0].map(([c]) => c), values: [], rows: all.map(a => a.map(([, v]) => param(v))), returning: true })
  }

  // UPDATE t SET col = CASE WHEN pk = ? THEN ? … ELSE col END … WHERE pk IN (…) (Django's bulk_update).
  // postgres types every param: the THEN values are CAST to the column type.
  bulkUpdate(rows: Record<string, unknown>[], fields: string[], d: Dialect): Statement {
    const [pk, pf] = pkField(this)
    const pkCol = col(pf.columns(pk)[0])
    const ids = rows.map(r => {
      const id = r[pf.key(pk)]
      if (id == null) throw new DomainError('invalid_param', `bulkUpdate: every ${this.name} row needs its ${pk}`)
      return id
    })
    const set: [string, Expr][] = []
    for (const name of fields) {
      const { f, field } = resolve(this, name)
      if (field === pk) throw new DomainError('invalid_param', `bulkUpdate cannot change ${this.name}.${pk}`, field)
      const types = f.dbType(d)
      const vals = rows.map(r => {
        const k = f.key(field)
        if (!(k in r)) throw new DomainError('invalid_param', `bulkUpdate: a ${this.name} row has no ${k}`, field)
        const ok = f.schema().safeParse(r[k])
        if (!ok.success) throw new DomainError('invalid_param', `${this.name}.${field}: ${ok.error.issues[0].message}`, field)
        return named(this.name, field, () => f.toDb(ok.data, d))
      })
      f.columns(field).forEach((c, ci) => {
        const v = (x: unknown): Expr => (d.name === 'postgres' ? { t: 'cast', e: param(x), to: { db: types[ci] } } : param(x))
        set.push([c, { t: 'case', whens: ids.map((id, i) => [bin('=', pkCol, param(pf.toDb(id, d)[0])), v(vals[i][ci])] as [Expr, Expr]), else: col(c) }])
      })
    }
    return d.render({ t: 'update', table: this.name, set, where: inList(pkCol, ids.map(id => param(pf.toDb(id, d)[0]))) })
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
  update(ws: Where[], patch: Record<string, unknown>, d: Dialect, q?: QNode[]): Statement | undefined {
    const set: [string, Expr][] = []
    for (const [name, v] of Object.entries(patch)) {
      const { f, field, col: c } = resolve(this, name)
      if (v instanceof Expression) {   // F / Case / Coalesce …: the first (amount) column; values convert through the field
        const x = writeScope(this, d).expr(v, f)
        if (x.agg) throw new DomainError('invalid_param', `${this.name}.${field}: update() cannot use an aggregate`, field)
        set.push([f.columns(field)[0], x.e])
        continue
      }
      if (v instanceof Delta) {
        if (f.kind !== 'int' && f.kind !== 'float') throw new DomainError('invalid_param', `${this.name}.${field} cannot use inc/dec`, field)
        set.push([f.columns(field)[0], bin(v.op === 'dec' ? '-' : '+', c, param(v.n))])
        continue
      }
      const r = f.schema().safeParse(v)
      if (!r.success) throw new DomainError('invalid_param', `${this.name}.${field}: ${r.error.issues[0].message}`, field)
      const vals = named(this.name, field, () => f.toDb(r.data, d))
      f.columns(field).forEach((cn, i) => set.push([cn, param(vals[i])]))
    }
    if (!set.length) return undefined
    return d.render({ t: 'update', table: this.name, set, where: whereOf(this, ws, d, undefined, q, 'write') })
  }

  delete(ws: Where[], d: Dialect, q?: QNode[]): Statement {
    return d.render({ t: 'delete', from: this.name, where: whereOf(this, ws, d, undefined, q, 'write') })
  }

  // CREATE TABLE + one CREATE INDEX per `index: true` field (tests / ad-hoc tables; migrations
  // render the same field DDL through schema/operations.ts).
  createSQL(d: Dialect): Statement[] {
    pkField(this)
    const columns = [...this.entries.flatMap(([n, f]) => f.columnDDL(n, d)), ...this.entries.flatMap(([n, f]) => f.tableConstraints(this.name, n, d))]
    // ponytail: tests / ad-hoc tables only — Meta indexes and constraints come from migrations
    const out = [d.render({ t: 'createTable', name: this.name, columns })]
    for (const [n, f] of this.entries) {
      if (f.opts.index) out.push(d.render({ t: 'createIndex', name: `${this.name}_${n}_idx`, table: this.name, cols: [f.columns(n)[0]] }))
    }
    return out
  }
}

// a field's own value error (a datetime out of the db's range) names the model field
function named<R>(model: string, field: string, fn: () => R): R {
  try { return fn() } catch (e) {
    if (e instanceof DomainError && e.code === 'invalid_param' && !e.field) throw new DomainError(e.code, `${model}.${field}: ${e.message}`, field)
    throw e
  }
}
