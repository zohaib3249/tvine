import { z } from 'zod'
import { byDb, Field, pkField, type ModelDef, type Opts } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// `<name>Id` column holding the target's pk; ON DELETE RESTRICT.
export class FkField extends Field<number | string, boolean, 'fk', boolean> {
  readonly kind = 'fk' as const
  constructor(readonly target: () => ModelDef, opts?: Opts) { super(opts) }
  key(name: string) { return `${name}Id` }
  columns(name: string) { return [`${name}Id`] }
  fromDb(row: Record<string, unknown>, name: string) { return (row[`${name}Id`] ?? null) as number | string | null }
  dbType(d: Dialect) {
    const intPk = pkField(this.target())[1].kind === 'id'
    return [intPk ? byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' }) : byDb(d, { sqlite: 'TEXT', postgres: 'UUID', mysql: 'CHAR(36)' })]
  }
  zod() { return z.union([z.number(), z.string()]) }
  references(d: Dialect) {
    const t = this.target()
    return ` REFERENCES ${d.quoteIdent(t.name)}(${d.quoteIdent(pkField(t)[0])}) ON DELETE RESTRICT`
  }
}
