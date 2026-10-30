// A dialect is thin: quoting, param style, transaction semantics, AST → SQL text.
// Per-DB column types and value conversions live on each Field (data/fields/*).
import { RAW, type SqlNode } from './ast.js'
import type { Operation } from '../schema/operations.js'
import type { ProjectState } from '../schema/state.js'

export type Statement = { sql: string; params: unknown[] }   // the ONLY shape that reaches a driver

export interface Dialect {
  name: 'sqlite' | 'postgres' | 'mysql'
  quoteIdent(name: string): string
  param(i: number): string                     // '?' | '$1'
  render(node: SqlNode): Statement
  lowerFn: string                              // Unicode-aware lower(): 'tv_lower' | 'lower'
  transactionalDDL: boolean
  likeEscape: string                           // backslash as a string literal for LIKE … ESCAPE, as this DB reads it
  bool: readonly [string, string]              // how Raw '0' / '1' (false / true) are spelled
  nullsSmallest: boolean                       // false → ORDER BY spells NULLS FIRST/LAST so nulls sort smallest everywhere
  insertReturning: boolean                     // INSERT … RETURNING * (mysql has none: the engine reads the row back by pk)
  literal(v: unknown, type: string): string    // a DDL default (DDL cannot take params): a checked literal for a column of `type`
  // A migration operation as this database runs it (from = state before the op, to = after).
  // sqlite rebuilds tables for what it cannot ALTER; others use the shared defaultRender.
  renderOperation(op: Operation, from: ProjectState, to: ProjectState): Statement[]
}

// `<a>_<b>_<label>` trimmed to 63 bytes by shortening the longer of a / b one char at a time — pg's
// own makeObjectName; mysql reuses it for the names it must address later (64-char limit).
// Identifiers are ASCII (checkIdent).
export function pgObjectName(a: string, b: string, label: string): string {
  const avail = 63 - (label.length + 1) - 1
  let x = a.length, y = b.length
  while (x + y > avail) { if (x > y) x--; else y-- }
  return `${a.slice(0, x)}_${b.slice(0, y)}_${label}`
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
      case 'in': return x.list.length ? `${e(x.e)} IN (${x.list.map(e).join(', ')})` : d.bool[0]
      case 'like': return `${x.ci ? `${checkIdent(d.lowerFn)}(${e(x.e)})` : e(x.e)} LIKE ${e(x.pattern)} ESCAPE ${d.likeEscape}`
      case 'castText': return `CAST(${e(x.e)} AS ${d.name === 'mysql' ? 'CHAR' : 'TEXT'})`
      case 'raw':
        if (!(RAW as readonly string[]).includes(x.sql)) throw new Error('Raw accepts compile-time constants only')
        return x.sql === '0' ? d.bool[0] : x.sql === '1' ? d.bool[1] : x.sql
      case 'select': {
        let s = `SELECT ${x.cols?.length ? x.cols.map(e).join(', ') : '*'} FROM ${q(x.from)}`
        if (x.where) s += ` WHERE ${e(x.where)}`
        const nulls = (dir: string) => (d.nullsSmallest ? '' : dir === 'desc' ? ' NULLS LAST' : ' NULLS FIRST')
        if (x.order?.length) s += ` ORDER BY ${x.order.map(o => `${e(o.e)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}${nulls(o.dir)}`).join(', ')}`
        if (x.limit !== undefined) s += ` LIMIT ${e({ t: 'param', value: x.limit })}`
        return s
      }
      case 'insert': {
        const body = x.cols.length ? `(${x.cols.map(q).join(', ')}) VALUES (${x.values.map(e).join(', ')})` : 'DEFAULT VALUES'
        return `INSERT INTO ${q(x.into)} ${body}${x.returning && d.insertReturning ? ' RETURNING *' : ''}`
      }
      case 'update': return `UPDATE ${q(x.table)} SET ${x.set.map(([c, v]) => `${q(c)} = ${e(v)}`).join(', ')}${x.where ? ` WHERE ${e(x.where)}` : ''}`
      case 'delete': return `DELETE FROM ${q(x.from)}${x.where ? ` WHERE ${e(x.where)}` : ''}`
      case 'createTable': return `CREATE TABLE ${x.ifNotExists ? 'IF NOT EXISTS ' : ''}${q(x.name)} (${x.columns.join(', ')})`
      case 'alterTable':
        if (x.addColumn) return `ALTER TABLE ${q(x.name)} ADD COLUMN ${x.addColumn}`
        if (x.dropColumn) return `ALTER TABLE ${q(x.name)} DROP COLUMN ${q(x.dropColumn)}`
        if (x.renameTo) return `ALTER TABLE ${q(x.name)} RENAME TO ${q(x.renameTo)}`
        if (x.renameColumn) return `ALTER TABLE ${q(x.name)} RENAME COLUMN ${q(x.renameColumn.from)} TO ${q(x.renameColumn.to)}`
        if (x.alterColumn) return `ALTER TABLE ${q(x.name)} ALTER COLUMN ${q(x.alterColumn.name)} ${x.alterColumn.action}`
        if (x.addUnique) return `ALTER TABLE ${q(x.name)} ADD CONSTRAINT ${q(x.addUnique.constraint)} UNIQUE (${q(x.addUnique.col)})`
        if (x.dropConstraint) return `ALTER TABLE ${q(x.name)} DROP CONSTRAINT ${q(x.dropConstraint)}`
        throw new Error('alterTable needs an action')
      case 'dropTable': return `DROP TABLE ${q(x.name)}`
      case 'createIndex': return `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${q(x.table)} (${x.cols.map(q).join(', ')})`
      case 'dropIndex': return `DROP INDEX ${q(x.name)}`
      case 'copyRows': {
        const fill = x.fill ?? []
        const into = [...x.cols, ...fill.map(([c]) => c)].map(q).join(', ')
        return `INSERT INTO ${q(x.into)} (${into}) SELECT ${[...x.cols.map(q), ...fill.map(([, v]) => e(v))].join(', ')} FROM ${q(x.from)}`
      }
    }
  }
  return { sql: e(node), params }
}
