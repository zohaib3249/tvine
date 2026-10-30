import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// stored as JSON text; postgres jsonb comes back already parsed
export class JsonField extends Field<unknown, boolean, 'json', boolean> {
  readonly kind = 'json' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'JSONB', mysql: 'JSON' })] }
  zod() { return z.unknown() }
  toDb(v: unknown) { return [v == null ? null : JSON.stringify(v)] }
  // postgres branch (already-parsed jsonb): untested until Task 20
  fromDb(row: Record<string, unknown>, name: string, d: Dialect) {
    const v = row[name]
    return v == null ? null : typeof v === 'string' && d.name !== 'postgres' ? JSON.parse(v) : v
  }
}
