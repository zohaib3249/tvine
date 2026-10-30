// mysql / mariadb: `x` quoting, ? params, lower(), nulls already sort smallest, no INSERT … RETURNING
// (the engine reads the row back by pk). Tables are utf8mb4 + utf8mb4_bin, so = and unique compare
// exactly like sqlite / postgres; contains lowers both sides (case-insensitive, not accent-insensitive).
// The driver pins sql_mode (strict, no NO_BACKSLASH_ESCAPES), so '\\' is one backslash: LIKE … ESCAPE
// '\\' and the backslash-escaped DDL literals below rely on it.
// Migrations: native MODIFY COLUMN; DDL auto-commits (transactionalDDL false) — the runner applies and
// journals step by step (migrate.ts). Foreign keys are named table constraints (mysql ignores an
// inline REFERENCES); renames keep their names — and unique key names — in step.
import { renderNode, checkIdent, type Dialect, type Statement } from '../dialect.js'
import { ddlLiteral } from '../../fields/base.js'
import { fkName } from '../../fields/fk.js'
import { addAutoDatetime, alterGuard, defaultRender, indexDiff, type Operation } from '../../schema/operations.js'
import { fieldOf, findModel, type FieldSpec, type ProjectState } from '../../schema/state.js'

const q = (n: string) => `\`${checkIdent(n)}\``
const raw = (sql: string): Statement => ({ sql, params: [] })
const alter = (table: string, action: string) => raw(`ALTER TABLE ${q(table)} ${action}`)

// a column definition for MODIFY COLUMN: everything but UNIQUE (that is a separate key here)
const modifyDDL = (spec: FieldSpec, name: string, state: ProjectState) =>
  fieldOf({ ...spec, opts: { ...spec.opts, unique: false } }, state).columnDDL(name, mysql)

// the fk constraint(s) a model's fk fields carry on `table`
const fks = (state: ProjectState, model: string, table: string, only?: string) =>
  Object.entries(findModel(state, model)!.model.fields)
    .filter(([n, f]) => f.kind === 'fk' && (!only || n === only))
    .map(([n, f]) => ({ col: fieldOf(f, state).columns(n)[0], ddl: fieldOf(f, state).tableConstraints(table, n, mysql)[0] }))

type Op<K extends Operation['kind']> = Extract<Operation, { kind: K }>

function alterField(op: Op<'alterField'>, from: ProjectState, to: ProjectState): Statement[] {
  const { was, now } = alterGuard(op, mysql, from, to)
  const wasSpec = findModel(from, op.model)!.model.fields[op.name]
  const a = modifyDDL(wasSpec, op.name, from), b = modifyDDL(op.field, op.name, to)
  const col = now.columns(op.name)[0]                       // mysql names an inline UNIQUE key after its column
  const before: Statement[] = [], modify: Statement[] = [], after: Statement[] = []
  if (was.opts.unique && !now.opts.unique) before.push(alter(op.model, `DROP INDEX ${q(col)}`))
  b.forEach((c, i) => { if (c !== a[i]) modify.push(alter(op.model, `MODIFY COLUMN ${c}`)) })
  if (!was.opts.unique && now.opts.unique) after.push(alter(op.model, `ADD UNIQUE KEY ${q(col)} (${q(col)})`))
  const ix = indexDiff(mysql, from, op.model, to, op.model)
  return [...before, ...ix.drop, ...modify, ...after, ...ix.create]
}

function addField(op: Op<'addField'>, from: ProjectState, to: ProjectState): Statement[] {
  const o = op.field.opts
  const main = op.field.kind === 'datetime' && o.auto && !o.optional && o.default === undefined
    ? addAutoDatetime(op, mysql, from, to, alter(op.model, `MODIFY COLUMN ${modifyDDL(op.field, op.name, to)[0]}`))
    : defaultRender(op, mysql, from, to)
  return [...main, ...fks(to, op.model, op.model, op.name).map(f => alter(op.model, `ADD ${f.ddl}`))]
}

// rename: mysql keeps index / constraint names, so the ones derived from the column / table move with it
function rename(op: Op<'renameField' | 'renameModel'>, from: ProjectState, to: ProjectState): Statement[] {
  const out = defaultRender(op, mysql, from, to)
  if (op.kind === 'renameField') {
    const spec = findModel(from, op.model)!.model.fields[op.from]
    const f = fieldOf(spec, from), [c0, c1] = [f.columns(op.from)[0], f.columns(op.to)[0]]
    if (spec.opts.unique) out.push(alter(op.model, `RENAME INDEX ${q(c0)} TO ${q(c1)}`))
    if (spec.kind === 'fk') {
      out.push(alter(op.model, `DROP FOREIGN KEY ${q(fkName(op.model, c0))}`))
      out.push(...fks(to, op.model, op.model, op.to).map(x => alter(op.model, `ADD ${x.ddl}`)))
    }
    return out
  }
  for (const x of fks(from, op.from, op.to)) out.push(alter(op.to, `DROP FOREIGN KEY ${q(fkName(op.from, x.col))}`))
  out.push(...fks(to, op.to, op.to).map(x => alter(op.to, `ADD ${x.ddl}`)))
  return out
}

export const mysql: Dialect = {
  name: 'mysql',
  quoteIdent: q,
  param: () => '?',
  render(node) {
    if (node.t === 'createTable') {
      const s = renderNode(node, mysql)
      return { ...s, sql: `${s.sql} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` }
    }
    if (node.t === 'insert' && !node.cols.length) return raw(`INSERT INTO ${q(node.into)} () VALUES ()`)
    if (node.t === 'dropIndex') return raw(`DROP INDEX ${q(node.name)}${node.table ? ` ON ${q(node.table)}` : ''}`)
    return renderNode(node, mysql)
  },
  lowerFn: 'lower',
  transactionalDDL: false,
  likeEscape: "'\\\\'",
  bool: ['0', '1'],
  nullsSmallest: true,
  insertReturning: false,
  // backslash is an escape in a mysql string literal; TEXT / JSON defaults must be an expression
  literal(v, type) {
    const s = typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : ddlLiteral(v)
    return /^(TEXT|JSON)$/.test(type) ? `(${s})` : s
  },
  renderOperation(op, from, to) {
    switch (op.kind) {
      case 'alterField': return alterField(op, from, to)
      case 'addField': return addField(op, from, to)
      case 'renameField': case 'renameModel': return rename(op, from, to)
      case 'removeField': {
        const spec = findModel(from, op.model)!.model.fields[op.name]
        const drop = spec.kind === 'fk' ? [alter(op.model, `DROP FOREIGN KEY ${q(fkName(op.model, fieldOf(spec, from).columns(op.name)[0]))}`)] : []
        return [...drop, ...defaultRender(op, mysql, from, to)]
      }
      default: return defaultRender(op, mysql, from, to)
    }
  },
}
