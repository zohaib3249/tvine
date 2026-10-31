import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

export class IdField extends Field<number, false, 'id', true> {
  readonly kind = 'id' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'INTEGER', postgres: 'BIGSERIAL', mysql: 'BIGINT' })] }
  zod() { return z.number().int() }
  columnDDL(name: string, d: Dialect) {
    const pk = byDb(d, { sqlite: 'PRIMARY KEY AUTOINCREMENT', postgres: 'PRIMARY KEY', mysql: 'AUTO_INCREMENT PRIMARY KEY' })
    return [`${d.quoteIdent(name)} ${this.dbType(d)[0]} ${pk}`]
  }
}
