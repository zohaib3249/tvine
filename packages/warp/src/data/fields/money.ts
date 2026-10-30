import { z } from 'zod'
import { and, bin, FALSE, inList, isNull, not, or, param, type Expr, col as colNode } from '../sql/ast.js'
import { byDb, Field, type Money } from './base.js'
import type { Dialect } from '../sql/dialect.js'
import type { Op } from '../queryset.js'

// Two columns: integer cents `<name>` + `<name>Currency`. Filters and ordering use cents;
// eq/ne with a {value, currency} object compare both.
export class MoneyField extends Field<Money, boolean, 'money', boolean> {
  readonly kind = 'money' as const
  columns(name: string) { return [name, `${name}Currency`] }
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' }), byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(3)' })] }
  zod() { return z.object({ value: z.number().int(), currency: z.string().min(1) }) }
  toDb(v: unknown) {
    if (v == null) return [null, null]
    if (typeof v === 'object') { const m = v as Money; return [m.value ?? null, m.currency ?? null] }
    return [v, null]                                    // bare cents (filters / cursor keys)
  }
  fromDb(row: Record<string, unknown>, name: string) {
    return row[name] == null ? null : { value: row[name] as number, currency: row[`${name}Currency`] as string }
  }
  lookup(op: Op, col: Expr, value: unknown, d: Dialect): Expr {
    const both = value != null && typeof value === 'object' && !Array.isArray(value)
    if ((op === 'eq' || op === 'ne') && both) {
      const [cents, cur] = this.toDb(value)
      const eq = and(bin('=', col, param(cents)), bin('=', colNode(`${(col as { name: string }).name}Currency`), param(cur)))
      return op === 'eq' ? eq : or(isNull(col), not(eq))
    }
    if (op === 'in') return Array.isArray(value) && value.length ? inList(col, value.map(v => param(this.toDb(v)[0]))) : FALSE
    return super.lookup(op, col, both ? this.toDb(value)[0] : value, d)
  }
}
