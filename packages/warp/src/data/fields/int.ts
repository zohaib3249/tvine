import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class IntField extends Field<number, boolean, 'int', boolean> {
  readonly kind = 'int' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' })] }
  zod() { return z.number().int() }
}
