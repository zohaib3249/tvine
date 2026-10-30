import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class TextField extends Field<string, boolean, 'text', boolean> {
  readonly kind = 'text' as const
  // mysql cannot index or unique a TEXT column: a unique / indexed text field is VARCHAR(255) there
  // (values longer than 255 chars are refused by strict mode); plain text stays TEXT (64 KB)
  dbType(d: Dialect) {
    return [byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: this.opts.unique || this.opts.index ? 'VARCHAR(255)' : 'TEXT' })]
  }
  zod() { return z.string() }
}
