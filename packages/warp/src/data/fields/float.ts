import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class FloatField extends Field<number, boolean, 'float', boolean> {
  readonly kind = 'float' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'REAL', postgres: 'DOUBLE PRECISION', mysql: 'DOUBLE' })] }
  zod() { return z.number() }
}
