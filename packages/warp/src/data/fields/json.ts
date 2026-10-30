import { z } from 'zod'
import { fn, param, type Expr } from '../sql/ast.js'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// stored as JSON text; postgres jsonb comes back already parsed (the mysql driver asks for JSON as text:
// mariadb's JSON is text anyway, and a parsed JSON string scalar could not be told from JSON text)
export class JsonField extends Field<unknown, boolean, 'json', boolean> {
  readonly kind = 'json' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'JSONB', mysql: 'JSON' })] }
  zod() { return z.unknown() }
  toDb(v: unknown) { return [v == null ? null : JSON.stringify(v)] }
  fromDb(row: Record<string, unknown>, name: string, d: Dialect) {
    const v = row[name]
    return v == null ? null : typeof v === 'string' && d.name !== 'postgres' ? JSON.parse(v) : v
  }
  // mysql compares a JSON column to a string param as JSON vs a JSON string: parse the param to JSON
  protected toParam(v: unknown, d: Dialect): Expr {
    return d.name === 'mysql' ? fn('JSON_EXTRACT', param(this.toDb(v)[0]), param('$')) : super.toParam(v, d)
  }
}
