import { z } from 'zod'
import { byDb, Field } from './base.js'
import { DomainError } from '../../core/errors.js'
import type { Dialect } from '../sql/dialect.js'

// sqlite: integer epoch ms; postgres: TIMESTAMPTZ (µs precision, so every JS ms survives exactly;
// pg returns a Date). mysql: DATETIME(3) holding UTC, sent and read as 'YYYY-MM-DD HH:MM:SS.mmm' text
// (the driver asks for date strings), so no server / session / process time zone ever applies.
// Always a Date in JS.
export class DatetimeField extends Field<Date, boolean, 'datetime', boolean> {
  readonly kind = 'datetime' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'TIMESTAMPTZ', mysql: 'DATETIME(3)' })] }
  zod() { return z.date() }
  toDb(v: unknown, d: Dialect) {
    if (v == null) return [null]
    if (d.name === 'sqlite' && v instanceof Date) return [v.getTime()]
    if (d.name === 'mysql') {
      const t = v instanceof Date ? v : new Date(v as string)
      if (!Number.isNaN(t.getTime())) {
        const y = t.getUTCFullYear()
        if (y < 1000 || y > 9999) throw new DomainError('invalid_param', `datetime ${t.toISOString()} is outside years 1000–9999`)
        return [t.toISOString().slice(0, 23).replace('T', ' ')]
      }
    }
    return [v]
  }
  fromDb(row: Record<string, unknown>, name: string, d: Dialect) {
    const v = row[name]
    if (v == null) return null
    if (v instanceof Date) return v
    return new Date(d.name === 'mysql' && typeof v === 'string' ? `${v.replace(' ', 'T')}Z` : (v as number | string))
  }
}
