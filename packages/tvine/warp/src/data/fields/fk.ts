import { z } from 'zod'
import { byDb, Field, pkField, type ModelDef, type OnDelete, type Opts } from './base.js'
import { pgObjectName, type Dialect } from '../sql/dialect.js'

// mysql's fk constraint name (per database, so it carries the table); dialects/mysql.ts keeps it in
// step with renames so removeField can drop it
export const fkName = (table: string, col: string) => pgObjectName(table, col, 'fk')

const ACTION: Record<OnDelete, string> = {
  CASCADE: 'CASCADE', SET_NULL: 'SET NULL', SET_DEFAULT: 'SET DEFAULT', RESTRICT: 'RESTRICT', PROTECT: 'RESTRICT', DO_NOTHING: 'NO ACTION',
}
// the DB-level ON DELETE action. PROTECT = RESTRICT in the DB + an ORM check with a readable error;
// mysql (InnoDB) rejects SET DEFAULT: RESTRICT there, the ORM sets the default before deleting (related.ts)
export function onDeleteSql(a: OnDelete | undefined, d: Dialect): string {
  const action = a ?? 'RESTRICT'
  if (!(action in ACTION)) throw new Error(`unknown onDelete ${JSON.stringify(a)} (CASCADE, PROTECT, SET_NULL, SET_DEFAULT, RESTRICT, DO_NOTHING)`)
  return action === 'SET_DEFAULT' && d.name === 'mysql' ? 'RESTRICT' : ACTION[action]
}

// `<name>Id` column holding the target's pk; ON DELETE per opts.onDelete (default RESTRICT). mysql
// ignores an inline REFERENCES, so there the fk is a named table-level constraint.
export class FkField extends Field<number | string, boolean, 'fk', boolean> {
  readonly kind = 'fk' as const
  constructor(readonly target: () => ModelDef, opts?: Opts) { super(opts) }
  fkDDL(d: Dialect): string {
    const t = this.target()
    return `REFERENCES ${d.quoteIdent(t.name)}(${d.quoteIdent(pkField(t)[0])}) ON DELETE ${onDeleteSql(this.opts.onDelete, d)}`
  }
  key(name: string) { return `${name}Id` }
  columns(name: string) { return [`${name}Id`] }
  fromDb(row: Record<string, unknown>, name: string) { return (row[`${name}Id`] ?? null) as number | string | null }
  dbType(d: Dialect) {
    const intPk = pkField(this.target())[1].kind === 'id'
    return [intPk ? byDb(d, { sqlite: 'INTEGER', postgres: 'BIGINT', mysql: 'BIGINT' }) : byDb(d, { sqlite: 'TEXT', postgres: 'UUID', mysql: 'CHAR(36)' })]
  }
  zod() { return z.union([z.number(), z.string()]) }
  references(d: Dialect) {
    if (d.name === 'mysql') return ''
    return ` ${this.fkDDL(d)}`
  }
  tableConstraints(table: string, name: string, d: Dialect) {
    if (d.name !== 'mysql') return []
    const c = this.columns(name)[0], q = d.quoteIdent
    return [`CONSTRAINT ${q(fkName(table, c))} FOREIGN KEY (${q(c)}) ${this.fkDDL(d)}`]
  }
}
