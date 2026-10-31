import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class UuidField extends Field<string, boolean, 'uuid', boolean> {
  readonly kind = 'uuid' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'UUID', mysql: 'CHAR(36)' })] }
  zod() { return z.string() }
  columnDDL(name: string, d: Dialect) {
    return name === 'id' ? [`${d.quoteIdent(name)} ${this.dbType(d)[0]} PRIMARY KEY NOT NULL`] : super.columnDDL(name, d)
  }
}
