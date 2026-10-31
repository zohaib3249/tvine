import { z } from 'zod'
import { byDb, Field, type Opts } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class EnumField extends Field<string, boolean, 'enum', boolean> {
  readonly kind = 'enum' as const
  constructor(readonly values: readonly string[], opts?: Opts) { super(opts) }
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(255)' })] }
  zod() { return z.enum(this.values as [string, ...string[]]) }
}
