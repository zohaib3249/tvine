import { z } from 'zod'
import { and, bin, FALSE, inList, isNull, not, or, param, type Expr, col as colNode } from '../sql/ast.js'
import { byDb, Field, type Money } from './base.js'
import { DomainError } from '../../core/errors.js'
import type { Dialect } from '../sql/dialect.js'
import type { Op } from '../queryset.js'

// Major units ↔ integer cents. A value with ≤2 decimals survives x100 → round → /100 exactly
// (0.29*100 = 28.999… rounds to 29, and 29/100 is the same double as 0.29); anything finer does not.
// ponytail: every currency gets 2 minor digits; JPY (0) and KWD/BHD (3) are not handled yet —
// add a per-currency exponent table when a non-2-digit currency ships.
const isMajor = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(Math.round(v * 100)) && Math.round(v * 100) / 100 === v
const toCents = (v: unknown): number => {
  if (!isMajor(v)) throw new DomainError('invalid_param', `money value must be a number with at most 2 decimals, got ${JSON.stringify(v) ?? String(v)}`)
  return Math.round(v * 100)
}

// Two columns: integer cents `<name>` + `<name>Currency`. The API speaks major units
// ({value: 29.99, currency}); the field converts at toDb/fromDb. Filters and ordering use the
// amount; eq/ne with a {value, currency} object compare both.
export class MoneyField extends Field<Money, boolean, 'money', boolean> {
  readonly kind = 'money' as const
  columns(name: string) { return [name, `${name}Currency`] }
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' }), byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(3)' })] }
  zod() { return z.object({ value: z.number().refine(isMajor, 'money value must have at most 2 decimals'), currency: z.string().min(1) }) }
  toDb(v: unknown) {
    if (v == null) return [null, null]
    if (typeof v === 'object') { const m = v as Money; return [m.value == null ? null : toCents(m.value), m.currency ?? null] }
    return [toCents(v), null]                           // bare amount (filters)
  }
  fromDb(row: Record<string, unknown>, name: string) {
    return row[name] == null ? null : { value: (row[name] as number) / 100, currency: row[`${name}Currency`] as string }
  }
  lookup(op: Op, col: Expr, value: unknown, d: Dialect): Expr {
    const both = value != null && typeof value === 'object' && !Array.isArray(value)
    if ((op === 'eq' || op === 'ne') && both) {
      const [cents, cur] = this.toDb(value)
      const eq = and(bin('=', col, param(cents)), bin('=', colNode(`${(col as { name: string }).name}Currency`), param(cur)))
      return op === 'eq' ? eq : or(isNull(col), not(eq))
    }
    if (op === 'in') return Array.isArray(value) && value.length ? inList(col, value.map(v => param(this.toDb(v)[0]))) : FALSE
    return super.lookup(op, col, both ? (value as Money).value : value, d)   // base lookup calls toDb → cents
  }
}
