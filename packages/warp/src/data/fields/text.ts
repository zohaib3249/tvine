import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class TextField extends Field<string, boolean, 'text', boolean> {
  readonly kind = 'text' as const
  // ponytail: mysql VARCHAR(255) so unique/index work; long text on mysql needs its own kind
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(255)' })] }
  zod() { return z.string() }
}
