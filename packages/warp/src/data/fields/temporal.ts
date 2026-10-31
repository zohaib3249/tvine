// date / time / duration (Django DateField, TimeField, DurationField). JS has no date-only or
// time-only type, so values are ISO strings; a duration is a number of milliseconds.
import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (s: string) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
// a Date → its UTC calendar day (the zone every datetime here is stored and truncated in)
const utcDay = (d: Date) => d.toISOString().slice(0, 10)

// 'YYYY-MM-DD'. sqlite: TEXT (Django's own sqlite storage, so text order = date order); postgres / mysql: DATE.
// A Date given on write or in a filter means its UTC day.
export class DateField extends Field<string, boolean, 'date', boolean> {
  readonly kind = 'date' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'DATE', mysql: 'DATE' })] }
  zod() { return z.preprocess(v => (v instanceof Date && !Number.isNaN(v.getTime()) ? utcDay(v) : v), z.string().refine(isDate, 'expected a date YYYY-MM-DD')) }
  toDb(v: unknown) { return [v == null ? null : v instanceof Date ? utcDay(v) : v] }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    if (v == null) return null
    // pg's driver parses DATE as LOCAL midnight: read it back with local getters (exact, any process zone)
    if (v instanceof Date) return `${String(v.getFullYear()).padStart(4, '0')}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    return String(v).slice(0, 10)
  }
}

// 'HH:MM:SS' or 'HH:MM:SS.ffffff' (microseconds only when not zero, like Python's isoformat). Input may
// also be 'HH:MM'. sqlite: TEXT in that normal form; postgres TIME; mysql TIME(6).
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?$/
export const normTime = (s: string): string | undefined => {
  const m = TIME_RE.exec(s)
  if (!m) return undefined
  const us = (m[4] ?? '').padEnd(6, '0')
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}${us && us !== '000000' ? `.${us}` : ''}`
}
export class TimeField extends Field<string, boolean, 'time', boolean> {
  readonly kind = 'time' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'TIME', mysql: 'TIME(6)' })] }
  zod() { return z.string().refine(s => normTime(s) !== undefined, 'expected a time HH:MM[:SS[.ffffff]]').transform(s => normTime(s)!) }
  toDb(v: unknown) { return [v == null ? null : typeof v === 'string' ? normTime(v) ?? v : v] }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    return v == null ? null : normTime(String(v)) ?? String(v)
  }
}

// milliseconds (a number; fractions keep microseconds). Stored as BIGINT microseconds on every engine
// (Django's non-postgres storage; one integer form keeps sums, ordering and comparisons exact everywhere,
// where a pg INTERVAL would need its own parser).
export class DurationField extends Field<number, boolean, 'duration', boolean> {
  readonly kind = 'duration' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' })] }
  zod() { return z.number().finite() }
  toDb(v: unknown) { return [typeof v === 'number' ? Math.round(v * 1000) : v ?? null] }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    return v == null ? null : Number(v) / 1000
  }
}
