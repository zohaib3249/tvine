// sqlite: "x" quoting, ? params, tv_lower() (registered by sqliteDriver; sqlite's lower() is ASCII-only).
// Migrations: sqlite cannot ALTER a column, so alterField / removeField (and an addField that ADD
// COLUMN refuses) rebuild the table; the runner runs that with foreign keys off + foreign_key_check.
import { bin, col, param, type SqlNode } from '../ast.js'
import { checkIdent, renderNode, type Dialect, type Statement } from '../dialect.js'
import { columnsChanged, columnsOf, createTable, defaultRender, indexesOf, type Operation } from '../../schema/operations.js'
import { fieldOf, findModel, modelDef, type FieldSpec, type ProjectState } from '../../schema/state.js'

// ADD COLUMN needs a usable default for existing rows and cannot add UNIQUE
const canAddColumn = (f: FieldSpec) => (f.opts.optional || f.opts.default !== undefined) && !f.opts.unique

type FieldOp = Extract<Operation, { kind: 'removeField' | 'alterField' | 'addField' }>

// create new, copy, keep the AUTOINCREMENT high-water mark, drop, rename, re-index
function rebuild(op: FieldOp, from: ProjectState, to: ProjectState): Statement[] {
  const model = op.model, tmp = `__new_${model}`
  const r = (n: SqlNode) => sqlite.render(n)
  const old = new Set(columnsOf(from, model)), next = columnsOf(to, model)
  // defense in depth: only removeField may lose columns (the autodetector already refuses the rest)
  const allowed = op.kind === 'removeField' ? fieldOf(findModel(from, model)!.model.fields[op.name], from).columns(op.name) : []
  const lost = [...old].filter(c => !next.includes(c) && !allowed.includes(c))
  if (lost.length) {
    throw new Error(`${op.kind} ${model}.${op.name} would drop column(s) ${lost.join(', ')}: write removeField + addField or a runSQL data migration`)
  }
  const def = modelDef(to, model)
  // a new auto datetime column is backfilled with the migration time
  const fill = Object.entries(def.fields)
    .filter(([n, f]) => f.kind === 'datetime' && f.opts.auto && !old.has(n))
    .map(([n, f]): [string, ReturnType<typeof param>] => [n, param(f.toDb(new Date(), sqlite)[0])])
  // ids are never reused after a rebuild: copy the old table's sqlite_sequence row
  const seq: Statement[] = def.fields.id?.kind === 'id' ? [
    r({ t: 'delete', from: 'sqlite_sequence', where: bin('=', col('name'), param(tmp)) }),
    { sql: 'INSERT INTO "sqlite_sequence" ("name", "seq") SELECT ?, "seq" FROM "sqlite_sequence" WHERE "name" = ?', params: [tmp, model] },
  ] : []
  return [
    createTable(sqlite, to, model, tmp),
    r({ t: 'copyRows', from: model, into: tmp, cols: next.filter(c => old.has(c)), fill }),
    ...seq,
    r({ t: 'dropTable', name: model }),
    r({ t: 'alterTable', name: tmp, renameTo: model }),
    ...indexesOf(to, model).map(i => r({ t: 'createIndex', ...i })),
  ]
}

export const sqlite: Dialect = {
  name: 'sqlite',
  quoteIdent: n => `"${checkIdent(n)}"`,
  param: () => '?',
  render: node => renderNode(node, sqlite),
  lowerFn: 'tv_lower',
  transactionalDDL: true,
  likeEscape: "'\\'",
  bool: ['0', '1'],
  nullsSmallest: true,
  renderOperation(op, from, to) {
    switch (op.kind) {
      case 'removeField': return rebuild(op, from, to)
      case 'alterField': return columnsChanged(op, sqlite, from, to) ? rebuild(op, from, to) : defaultRender(op, sqlite, from, to)
      case 'addField': return canAddColumn(op.field) ? defaultRender(op, sqlite, from, to) : rebuild(op, from, to)
      default: return defaultRender(op, sqlite, from, to)
    }
  },
}
