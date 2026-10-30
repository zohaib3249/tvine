// A dialect is thin: quoting, param style, transaction semantics, AST → SQL text.
// Per-DB column types and value conversions live on each Field (data/fields/*).
import { RAW, type SqlNode } from './ast.js'

export type Statement = { sql: string; params: unknown[] }   // the ONLY shape that reaches a driver

export interface Dialect {
  name: 'sqlite' | 'postgres' | 'mysql'
  quoteIdent(name: string): string
  param(i: number): string                     // '?' | '$1'
  render(node: SqlNode): Statement
  lowerFn: string                              // Unicode-aware lower(): 'tv_lower' | 'lower'
  transactionalDDL: boolean
  // TODO(6e): renderOperation(op, state) arrives with schema/operations.
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export function checkIdent(name: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`invalid SQL identifier ${JSON.stringify(name)}`)
  return name
}

// Shared AST → SQL walk. Every value becomes d.param(n); every name goes through d.quoteIdent.
export function renderNode(node: SqlNode, d: Dialect): Statement {
  const params: unknown[] = []
  const q = (n: string) => d.quoteIdent(n)
  const e = (x: SqlNode): string => {
    switch (x.t) {
      case 'col': return q(x.name)
      case 'param': params.push(x.value); return d.param(params.length)
      case 'fn': return `${checkIdent(x.name)}(${x.args.map(e).join(', ')})`
      case 'bin': return `(${e(x.l)} ${x.op} ${e(x.r)})`
      case 'not': return `NOT (${e(x.e)})`
      case 'and': return `(${x.es.map(e).join(' AND ')})`
      case 'or': return `(${x.es.map(e).join(' OR ')})`
      case 'isNull': return `${e(x.e)} IS ${x.negated ? 'NOT ' : ''}NULL`
      case 'in': return x.list.length ? `${e(x.e)} IN (${x.list.map(e).join(', ')})` : '0'
      // TODO(Task 20): ESCAPE '\' must become dialect-rendered — mysql treats backslash as a string escape
      case 'like': return `${x.ci ? `${checkIdent(d.lowerFn)}(${e(x.e)})` : e(x.e)} LIKE ${e(x.pattern)} ESCAPE '\\'`
      case 'raw':
        if (!(RAW as readonly string[]).includes(x.sql)) throw new Error('Raw accepts compile-time constants only')
        return x.sql
      case 'select': {
        let s = `SELECT ${x.cols?.length ? x.cols.map(e).join(', ') : '*'} FROM ${q(x.from)}`
        if (x.where) s += ` WHERE ${e(x.where)}`
        if (x.order?.length) s += ` ORDER BY ${x.order.map(o => `${e(o.e)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
        if (x.limit !== undefined) s += ` LIMIT ${e({ t: 'param', value: x.limit })}`
        return s
      }
      case 'insert': {
        const body = x.cols.length ? `(${x.cols.map(q).join(', ')}) VALUES (${x.values.map(e).join(', ')})` : 'DEFAULT VALUES'
        return `INSERT INTO ${q(x.into)} ${body}${x.returning ? ' RETURNING *' : ''}`
      }
      case 'update': return `UPDATE ${q(x.table)} SET ${x.set.map(([c, v]) => `${q(c)} = ${e(v)}`).join(', ')}${x.where ? ` WHERE ${e(x.where)}` : ''}`
      case 'delete': return `DELETE FROM ${q(x.from)}${x.where ? ` WHERE ${e(x.where)}` : ''}`
      case 'createTable': return `CREATE TABLE ${q(x.name)} (${x.columns.join(', ')})`
      case 'alterTable':
        if (x.addColumn) return `ALTER TABLE ${q(x.name)} ADD COLUMN ${x.addColumn}`
        if (x.dropColumn) return `ALTER TABLE ${q(x.name)} DROP COLUMN ${q(x.dropColumn)}`
        if (x.renameTo) return `ALTER TABLE ${q(x.name)} RENAME TO ${q(x.renameTo)}`
        throw new Error('alterTable needs an action')
      case 'dropTable': return `DROP TABLE ${q(x.name)}`
      case 'createIndex': return `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${q(x.table)} (${x.cols.map(q).join(', ')})`
    }
  }
  return { sql: e(node), params }
}
