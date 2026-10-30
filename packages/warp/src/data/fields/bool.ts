import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// sqlite has no boolean: stored 1/0. mysql: TINYINT(1) (its BOOLEAN alias), comes back 1/0.
export class BoolField extends Field<boolean, boolean, 'bool', boolean> {
  readonly kind = 'bool' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BOOLEAN', mysql: 'TINYINT(1)' })] }
  zod() { return z.boolean() }
  toDb(v: unknown, d: Dialect) { return [v == null ? null : d.name === 'sqlite' ? (v ? 1 : 0) : !!v] }
  fromDb(row: Record<string, unknown>, name: string) { return row[name] == null ? null : Boolean(row[name]) }
}
