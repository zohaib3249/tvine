// mysql / mariadb: `x` quoting, ? params, lower(), nulls already sort smallest, no INSERT … RETURNING
// (the engine reads the row back by pk). Tables are utf8mb4 + utf8mb4_bin, so = and unique compare
// exactly like sqlite / postgres; contains lowers both sides (case-insensitive, not accent-insensitive).
// The driver pins sql_mode (strict, no NO_BACKSLASH_ESCAPES), so '\\' is one backslash: LIKE … ESCAPE
// '\\' and the backslash-escaped DDL literals below rely on it.
// Migrations: native MODIFY COLUMN; DDL auto-commits (transactionalDDL false) — the runner applies and
// journals step by step (migrate.ts). Foreign keys are named table constraints (mysql ignores an
// inline REFERENCES); renames keep their names — and unique key names — in step.
import { createHash } from 'node:crypto'
import { renderNode, checkIdent, type Dialect, type Statement } from '../dialect.js'
import { ddlLiteral } from '../../fields/base.js'
import { fkName } from '../../fields/fk.js'
import { addAutoDatetime, alterGuard, defaultRender, indexDiff, indexesOf, type Operation } from '../../schema/operations.js'
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

// An fk needs an index led by its column, and mysql reuses whichever one exists (dropping its own), so
// DROP INDEX on that index is refused while the fk stands: lift the fk around it (re-adding recreates
// an index if none is left).
// ponytail: mysql DDL is not transactional, so between DROP FOREIGN KEY and ADD the fk is not enforced: a
// write in that window can insert a dangling reference, and the re-ADD then fails (migrate stops, journaled,
// resumable after fixing the row). Run such migrations in a quiet window; a lock-the-table variant if needed.
function liftFk(field: string | undefined, model: string, from: ProjectState, to: ProjectState, inner: Statement[]): Statement[] {
  const spec = field === undefined ? undefined : findModel(from, model)!.model.fields[field]
  const fk = spec?.kind === 'fk' && findModel(to, model)!.model.fields[field!] ? fks(to, model, model, field)[0] : undefined
  if (!fk) return inner
  return [alter(model, `DROP FOREIGN KEY ${q(fkName(model, fk.col))}`), ...inner, alter(model, `ADD ${fk.ddl}`)]
}

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
  const losesIndex = (was.opts.index && !now.opts.index) || (was.opts.unique && !now.opts.unique)
  // onDelete changed: drop + re-add the named fk (unless liftFk below already re-adds it)
  const odChanged = now.kind === 'fk' && (was.opts.onDelete ?? 'RESTRICT') !== (now.opts.onDelete ?? 'RESTRICT')
  if (odChanged && !losesIndex) {
    const fk = fks(to, op.model, op.model, op.name)[0]
    return [alter(op.model, `DROP FOREIGN KEY ${q(fkName(op.model, fk.col))}`), ...before, ...ix.drop, ...modify, ...after, ...ix.create, alter(op.model, `ADD ${fk.ddl}`)]
  }
  return liftFk(losesIndex ? op.name : undefined, op.model, from, to, [...before, ...ix.drop, ...modify, ...after, ...ix.create])
}

// mysql caps identifiers at 64 chars: a longer index name (<model>_<field>_idx) is cut and suffixed
// with a hash of the full name — stable, so a later DROP INDEX finds it
const fit = (name: string) => name.length <= 64 ? name : `${name.slice(0, 55)}_${createHash('sha1').update(name).digest('hex').slice(0, 8)}`

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
  render(node, o) {
    if (node.t === 'createTable') {
      const s = renderNode(node, mysql, o)
      return { ...s, sql: `${s.sql} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` }
    }
    if (node.t === 'insert' && !node.cols.length) return raw(`INSERT INTO ${q(node.into)} () VALUES ()`)
    if (node.t === 'dropIndex') return raw(`DROP INDEX ${q(fit(node.name))}${node.table ? ` ON ${q(node.table)}` : ''}`)
    if (node.t === 'createIndex') {
      if (node.where) throw new Error(`index ${node.name}: mysql has no partial (conditional) indexes; drop the condition or use postgres / sqlite`)
      return renderNode({ ...node, name: fit(node.name) }, mysql, o)
    }
    return renderNode(node, mysql, o)
  },
  lowerFn: 'lower',
  transactionalDDL: false,
  likeEscape: "'\\\\'",
  bool: ['0', '1'],
  nullsSmallest: true,
  insertReturning: false,
  // backslash is an escape in a mysql string literal; LONGTEXT / JSON defaults must be an expression
  literal(v, type) {
    const s = typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : ddlLiteral(v)
    return /^(LONGTEXT|JSON)$/.test(type) ? `(${s})` : s
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
      case 'removeIndex': case 'alterUniqueTogether': case 'removeConstraint': case 'addConstraint': {
        // a dropped index led by an fk column may be the fk's own index (mysql drops its implicit one
        // once another usable index exists): lift the fk around the drop
        const gone = new Set(indexesOf(to, op.model).map(i => i.name))
        const lead = indexesOf(from, op.model).filter(i => !gone.has(i.name)).map(i => i.cols[0])
        const fk = Object.entries(findModel(from, op.model)!.model.fields).find(([n, f]) => f.kind === 'fk' && lead.includes(fieldOf(f, from).columns(n)[0]))
        return liftFk(fk?.[0], op.model, from, to, defaultRender(op, mysql, from, to))
      }
      default: return defaultRender(op, mysql, from, to)
    }
  },
}
