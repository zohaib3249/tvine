import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// stored as the storage key (text)
export class ImageField extends Field<string, boolean, 'image', boolean> {
  readonly kind = 'image' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(512)' })] }
  zod() { return z.string() }
}
