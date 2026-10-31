// A dialect is thin: quoting, param style, transaction semantics, AST → SQL text.
// Per-DB column types and value conversions live on each Field (data/fields/*).
import { createHash } from 'node:crypto'
import { RAW, type CastTo, type Func, type OrderTerm, type Select, type SqlNode, type TruncUnit } from './ast.js'
import type { Operation } from '../schema/operations.js'
import type { ProjectState } from '../schema/state.js'

export type Statement = { sql: string; params: unknown[] }   // the ONLY shape that reaches a driver

export interface Dialect {
  name: 'sqlite' | 'postgres' | 'mysql'
  quoteIdent(name: string): string
  param(i: number): string                     // '?' | '$1'
  lowerFn: string                              // Unicode-aware lower(): 'tv_lower' | 'lower'
  transactionalDDL: boolean
  likeEscape: string                           // backslash as a string literal for LIKE … ESCAPE, as this DB reads it
  bool: readonly [string, string]              // how Raw '0' / '1' (false / true) are spelled
  nullsSmallest: boolean                       // false → ORDER BY spells NULLS FIRST/LAST so nulls sort smallest everywhere
  insertReturning: boolean                     // INSERT … RETURNING * (mysql has none: the engine reads the row back by pk)
  literal(v: unknown, type: string): string    // a DDL default (DDL cannot take params): a checked literal for a column of `type`
  render(node: SqlNode, opts?: RenderOpts): Statement
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

// a generated object name (index / unique / through table) that fits every engine: ≤63 bytes (pg),
// longer ones cut and suffixed with a hash of the full name — the same name on every engine
export function shortName(full: string, max = 63): string {
  return full.length <= max ? full : `${full.slice(0, max - 9)}_${createHash('sha1').update(full).digest('hex').slice(0, 8)}`
}
// `<model>_<cols>_<suffix>` (Django's create_index_name, minus its always-on hash)
export const objectName = (model: string, cols: string[], suffix: string) => {
  const full = `${model}_${cols.join('_')}_${suffix}`
  return full.length <= 63 ? full : `${shortName(`${model}_${cols.join('_')}`, 63 - suffix.length - 1)}_${suffix}`
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export function checkIdent(name: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`invalid SQL identifier ${JSON.stringify(name)}`)
  return name
}

// ---- per-dialect spellings of the advanced nodes (fixed tables: nothing here comes from a caller) ----
const FUNC: Record<Dialect['name'], Record<Func, string>> = {
  sqlite: { lower: 'tv_lower', upper: 'tv_upper', length: 'length', coalesce: 'coalesce', abs: 'abs' },
  postgres: { lower: 'lower', upper: 'upper', length: 'char_length', coalesce: 'coalesce', abs: 'abs' },
  mysql: { lower: 'lower', upper: 'upper', length: 'char_length', coalesce: 'coalesce', abs: 'abs' },
}
const CAST: Record<Dialect['name'], Record<'int' | 'float' | 'text', string>> = {
  sqlite: { int: 'INTEGER', float: 'REAL', text: 'TEXT' },
  postgres: { int: 'BIGINT', float: 'DOUBLE PRECISION', text: 'TEXT' },
  mysql: { int: 'SIGNED', float: 'DOUBLE', text: 'CHAR' },
}
const DB_TYPE = /^[A-Z][A-Z0-9 ]*(\(\d+(, ?\d+)?\))?$/          // a Field.dbType spelling (BIGINT, VARCHAR(255), DOUBLE PRECISION)
function castType(to: CastTo, d: Dialect): string {
  if (typeof to === 'string') return CAST[d.name][to]
  if (d.name !== 'postgres' || !DB_TYPE.test(to.db)) throw new Error(`cannot CAST to ${JSON.stringify(to.db)} on ${d.name}`)
  return to.db === 'BIGSERIAL' ? 'BIGINT' : to.db
}
// UTC truncation. sqlite stores epoch ms; postgres TIMESTAMPTZ; mysql DATETIME(3) holding UTC.
const SQLITE_START = { year: 'start of year', month: 'start of month', day: 'start of day' } as const
const MYSQL_FMT = { year: '%Y-01-01 00:00:00', month: '%Y-%m-01 00:00:00', day: '%Y-%m-%d 00:00:00' } as const
function trunc(unit: TruncUnit, inner: string, d: Dialect): string {
  if (!(unit in SQLITE_START)) throw new Error(`unknown truncation unit ${JSON.stringify(unit)}`)
  if (d.name === 'sqlite') return `(CAST(strftime('%s', (${inner}) / 1000, 'unixepoch', '${SQLITE_START[unit]}') AS INTEGER) * 1000)`
  if (d.name === 'postgres') return `date_trunc('${unit}', ${inner}, 'UTC')`
  return `DATE_FORMAT(${inner}, '${MYSQL_FMT[unit]}')`
}

export interface RenderOpts {
  // DDL cannot take params (CHECK constraints, partial-index conditions): values render as the
  // dialect's checked literals instead (numbers / quote-escaped strings / booleans / null / dates)
  inline?: boolean
}

// Shared AST → SQL walk. Every value becomes d.param(n); every name goes through d.quoteIdent.
export function renderNode(node: SqlNode, d: Dialect, opts: RenderOpts = {}): Statement {
  const params: unknown[] = []
  const q = (n: string) => d.quoteIdent(n)
  const order = (o: OrderTerm): string => {
    const dir = o.dir === 'desc' ? 'DESC' : 'ASC'
    if (o.nulls && d.name === 'mysql') return `(${e(o.e)} IS NULL) ${o.nulls === 'first' ? 'DESC' : 'ASC'}, ${e(o.e)} ${dir}`
    if (o.nulls) return `${e(o.e)} ${dir} NULLS ${o.nulls === 'first' ? 'FIRST' : 'LAST'}`
    return `${e(o.e)} ${dir}${d.nullsSmallest ? '' : o.dir === 'desc' ? ' NULLS LAST' : ' NULLS FIRST'}`
  }
  const select = (x: Select): string => {
    if (x.distinctOn?.length && d.name !== 'postgres') throw new Error(`distinct(fields) is postgres-only (${d.name} has no DISTINCT ON)`)
    const head = x.distinctOn?.length ? `DISTINCT ON (${x.distinctOn.map(e).join(', ')}) ` : x.distinct ? 'DISTINCT ' : ''
    const from = typeof x.from === 'string' ? q(x.from) : `(${select(x.from)})`
    let s = `SELECT ${head}${x.cols?.length ? x.cols.map(e).join(', ') : '*'} FROM ${from}${x.as ? ` AS ${q(x.as)}` : ''}`
    for (const j of x.joins ?? []) s += ` ${j.inner ? 'INNER' : 'LEFT'} JOIN ${q(j.table)} AS ${q(j.alias)} ON ${e(j.on)}`
    if (x.where) s += ` WHERE ${e(x.where)}`
    if (x.groupBy?.length) s += ` GROUP BY ${x.groupBy.map(e).join(', ')}`
    if (x.having) s += ` HAVING ${e(x.having)}`
    if (x.order?.length) s += ` ORDER BY ${x.order.map(order).join(', ')}`
    if (x.limit !== undefined) s += ` LIMIT ${e({ t: 'param', value: x.limit })}`
    if (x.forUpdate && d.name !== 'sqlite') {   // sqlite: no-op — BEGIN IMMEDIATE already holds its single writer lock
      const f = x.forUpdate
      s += ` FOR UPDATE${f.of?.length ? ` OF ${f.of.map(q).join(', ')}` : ''}${f.nowait ? ' NOWAIT' : f.skipLocked ? ' SKIP LOCKED' : ''}`
    }
    return s
  }
  const e = (x: SqlNode): string => {
    switch (x.t) {
      case 'col': return x.table ? `${q(x.table)}.${q(x.name)}` : q(x.name)
      case 'param':
        if (opts.inline) return d.literal(x.value instanceof Date ? x.value.toISOString() : x.value, '')
        params.push(x.value); return d.param(params.length)
      case 'func': return `${FUNC[d.name][x.fn]}(${x.args.map(e).join(', ')})`
      case 'case': return `CASE ${x.whens.map(([c, v]) => `WHEN ${e(c)} THEN ${e(v)}`).join(' ')}${x.else ? ` ELSE ${e(x.else)}` : ''} END`
      case 'cast': return `CAST(${e(x.e)} AS ${castType(x.to, d)})`
      case 'agg': {
        if (!['sum', 'count', 'avg', 'min', 'max'].includes(x.fn)) throw new Error(`unknown aggregate ${x.fn}`)
        return `${x.fn.toUpperCase()}(${x.distinct ? 'DISTINCT ' : ''}${x.e ? e(x.e) : '*'})`
      }
      case 'trunc': return trunc(x.unit, e(x.e), d)
      case 'sub': return `(${select(x.q)})`
      case 'exists': return `EXISTS (${select(x.q)})`
      case 'inSub': return `${e(x.e)} IN (${select(x.q)})`
      case 'star': return x.table ? `${q(x.table)}.*` : '*'
      case 'as': return `${e(x.e)} AS ${q(x.alias)}`
      case 'ordinal':
        if (!Number.isInteger(x.n) || x.n < 1) throw new Error('bad ordinal')
        return String(x.n)
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
      case 'select': return select(x)
      case 'insert': {
        const rows = x.rows ?? [x.values]
        const body = x.cols.length ? `(${x.cols.map(q).join(', ')}) VALUES ${rows.map(r => `(${r.map(e).join(', ')})`).join(', ')}` : 'DEFAULT VALUES'
        if (x.ignoreConflicts && d.name === 'mysql') throw new Error('ON CONFLICT DO NOTHING is not available on mysql')
        return `INSERT INTO ${q(x.into)} ${body}${x.ignoreConflicts ? ' ON CONFLICT DO NOTHING' : ''}${x.returning && d.insertReturning ? ' RETURNING *' : ''}`
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
      case 'createIndex': return `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${q(x.table)} (${x.cols.map(q).join(', ')})${x.where ? ` WHERE ${e(x.where)}` : ''}`
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
