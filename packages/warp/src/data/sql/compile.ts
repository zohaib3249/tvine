// QuerySpec + table → AST. Each clause is the FIELD's own lookup; this file adds the parts that
// are about the query, not the field: null-inclusive exclude(), search OR, keyset cursor, order.
import { DomainError } from '../../core/errors.js'
import { decodeCursor, type Order, type QuerySpec, type Where } from '../queryset.js'
import type { Field, Fields, Kind } from '../fields/index.js'
import { and, bin, col, fn, FALSE, isNotNull, isNull, not, or, param, raw, type Expr, type Select } from './ast.js'
import { containsExpr } from '../fields/base.js'
import type { Dialect } from './dialect.js'

type F = Field<any, boolean, Kind, boolean>
export interface TableDef { name: string; fields: Fields }

// field name as written by the caller (`vendor` or `vendorId`) → field + its first column
export function resolve(t: TableDef, name: string): { f: F; field: string; col: Expr } {
  for (const [n, f] of Object.entries(t.fields)) {
    if (n === name || f.key(n) === name) return { f, field: n, col: col(f.columns(n)[0]) }
  }
  throw new DomainError('invalid_param', `unknown field "${name}" on ${t.name}`, name)
}

export function cond(t: TableDef, w: Where, d: Dialect): Expr {
  const { f, col: c } = resolve(t, w.field)
  if (!w.not) return f.lookup(w.op, c, w.value, d)
  // null-inclusive negation (orm-queryset.md): missing values match exclude()
  if (w.op === 'ne') return f.lookup('eq', c, w.value, d)
  return or(isNull(c), not(f.lookup(w.op, c, w.value, d)))
}

export function whereOf(t: TableDef, ws: Where[], d: Dialect, search?: QuerySpec['search']): Expr | undefined {
  const parts = ws.map(w => cond(t, w, d))
  if (search?.term) parts.push(or(...search.fields.map(n => containsExpr(resolve(t, n).col, search.term))))
  return parts.length ? and(...parts) : undefined
}

// Keyset WHERE: rows strictly after the cursor row under `order`. Nulls are the smallest value:
// asc goes past them, desc ends with them. Compares the field's first (sort) column.
export function keyset(t: TableDef, order: Order[], cv: unknown[], d: Dialect): Expr {
  const cols = order.map(o => resolve(t, o.field))
  const vals = cv.map((v, i) => cols[i].f.toDb(v, d)[0])
  const same = (i: number) => (vals[i] == null ? isNull(cols[i].col) : bin('=', cols[i].col, param(vals[i])))
  const beyond = (i: number): Expr => order[i].dir === 'asc'
    ? (vals[i] == null ? isNotNull(cols[i].col) : bin('>', cols[i].col, param(vals[i])))
    : (vals[i] == null ? FALSE : or(bin('<', cols[i].col, param(vals[i])), isNull(cols[i].col)))
  return or(...order.map((_, i) => and(...Array.from({ length: i }, (_, j) => same(j)), beyond(i))))
}

// The read path: a count over the filter, plus the page (absent when limit <= 0).
export function compile(spec: QuerySpec, t: TableDef, d: Dialect): { count: Select; page?: Select } {
  const where = whereOf(t, spec.where, d, spec.search)
  const count: Select = { t: 'select', from: t.name, cols: [fn('count', raw('*'))], where }
  if (spec.limit <= 0) return { count }
  const order = spec.order ?? []
  let pw = where
  if (spec.cursor) {
    const cv = decodeCursor(spec.cursor)
    if (cv.length !== order.length) throw new Error('invalid cursor')
    const k = keyset(t, order, cv, d)
    pw = where ? and(where, k) : k
  }
  return { count, page: { t: 'select', from: t.name, where: pw, order: order.map(o => ({ e: resolve(t, o.field).col, dir: o.dir })), limit: spec.limit } }
}
