import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// sqlite: integer epoch ms; others: native timestamp. Always a Date in JS.
export class DatetimeField extends Field<Date, boolean, 'datetime', boolean> {
  readonly kind = 'datetime' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'TIMESTAMPTZ', mysql: 'DATETIME(3)' })] }
  zod() { return z.date() }
  // postgres/mysql branches (Date passthrough): untested until Task 20
  toDb(v: unknown, d: Dialect) { return [v == null ? null : d.name === 'sqlite' && v instanceof Date ? v.getTime() : v] }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    return v == null ? null : v instanceof Date ? v : new Date(v as number | string)
  }
}
