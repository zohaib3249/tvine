// postgres: "x" quoting, $1..$n params, lower() (Unicode-aware under a UTF-8 database), TRUE/FALSE,
// NULLS FIRST/LAST so nulls sort smallest like sqlite (the keyset cursor relies on it).
// LIKE … ESCAPE E'\\': an escape-string literal reads the same whatever standard_conforming_strings is.
// Migrations: native ALTER COLUMN — never a rebuild; the whole migration runs in one transaction.
import { isNull, param, type SqlNode } from '../ast.js'
import { checkIdent, renderNode, type Dialect, type Statement } from '../dialect.js'
import { ddlLiteral } from '../../fields/base.js'
import { defaultRender, indexDiff, type Operation } from '../../schema/operations.js'
import { fieldOf, findModel, type FieldSpec, type ProjectState } from '../../schema/state.js'

type AlterOp = Extract<Operation, { kind: 'alterField' }>
type AddOp = Extract<Operation, { kind: 'addField' }>

// pg's own name for an object it names (makeObjectName): `<a>_<b>_<label>`, trimmed to 63 bytes
// by shortening the longer of a / b one char at a time. Identifiers are ASCII (checkIdent).
export function pgObjectName(a: string, b: string, label: string): string {
  const avail = 63 - (label.length + 1) - 1
  let x = a.length, y = b.length
  while (x + y > avail) { if (x > y) x--; else y-- }
  return `${a.slice(0, x)}_${b.slice(0, y)}_${label}`
}
// the inline UNIQUE constraint pg created for a column; renames below keep it in step
const uniqueName = (table: string, col: string) => pgObjectName(table, col, 'key')

function alterField(op: AlterOp, from: ProjectState, to: ProjectState): Statement[] {
  const r = (n: SqlNode) => postgres.render(n)
  const was = fieldOf(findModel(from, op.model)!.model.fields[op.name], from), now = fieldOf(op.field, to)
  const a = was.columns(op.name), b = now.columns(op.name)
  const lost = a.filter(c => !b.includes(c))
  if (lost.length || a.length !== b.length) {
    throw new Error(`alterField ${op.model}.${op.name} would drop column(s) ${lost.join(', ')}: write removeField + addField or a runSQL data migration`)
  }
  if (was.references(postgres) !== now.references(postgres)) {
    throw new Error(`alterField ${op.model}.${op.name} changes its foreign key target; write removeField + addField or a runSQL migration`)
  }
  // casts that would silently change stored values (1.5 → 2) need a hand-written data migration
  const LOSSY: [string, string][] = [['DOUBLE PRECISION', 'BIGINT']]
  was.dbType(postgres).forEach((t, i) => {
    const t2 = now.dbType(postgres)[i]
    if (LOSSY.some(([x, y]) => x === t && y === t2)) {
      throw new Error(`alterField ${op.model}.${op.name} changes ${t} → ${t2}, which would round stored values: write a runSQL data migration`)
    }
  })
  const out: Statement[] = []
  const alter = (name: string, action: string) => out.push(r({ t: 'alterTable', name: op.model, alterColumn: { name, action } }))
  const [ta, tb] = [was.dbType(postgres), now.dbType(postgres)]
  const da = was.opts.default === undefined ? [] : was.toDb(was.opts.default, postgres)
  const db = now.opts.default === undefined ? [] : now.toDb(now.opts.default, postgres)
  b.forEach((c, i) => {
    const defChanged = da[i] !== db[i] || ta[i] !== tb[i]
    if (defChanged && da[i] !== undefined) alter(c, 'DROP DEFAULT')            // an old default may not cast to the new type
    if (ta[i] !== tb[i]) alter(c, `TYPE ${tb[i]} USING ${postgres.quoteIdent(c)}::${tb[i]}`)
    if (defChanged && db[i] !== undefined) alter(c, `SET DEFAULT ${ddlLiteral(db[i])}`)
    if (!!was.opts.optional !== !!now.opts.optional) alter(c, now.opts.optional ? 'DROP NOT NULL' : 'SET NOT NULL')
  })
  if (!!was.opts.unique !== !!now.opts.unique) {
    out.push(r(now.opts.unique
      ? { t: 'alterTable', name: op.model, addUnique: { constraint: uniqueName(op.model, b[0]), col: b[0] } }
      : { t: 'alterTable', name: op.model, dropConstraint: uniqueName(op.model, b[0]) }))
  }
  const ix = indexDiff(postgres, from, op.model, to, op.model)
  return [...ix.drop, ...out, ...ix.create]
}

// a required auto datetime on a table that may hold rows: add nullable, backfill the migration time, then NOT NULL
function addAutoDatetime(op: AddOp, from: ProjectState, to: ProjectState): Statement[] {
  const r = (n: SqlNode) => postgres.render(n)
  const nullable: FieldSpec = { ...op.field, opts: { ...op.field.opts, optional: true } }
  const f = fieldOf(nullable, to)
  return [
    ...f.columnDDL(op.name, postgres).map(c => r({ t: 'alterTable', name: op.model, addColumn: c })),
    r({ t: 'update', table: op.model, set: [[op.name, param(f.toDb(new Date(), postgres)[0])]], where: isNull({ t: 'col', name: op.name }) }),
    r({ t: 'alterTable', name: op.model, alterColumn: { name: op.name, action: 'SET NOT NULL' } }),
    ...indexDiff(postgres, from, op.model, to, op.model).create,
  ]
}

// pg never renames constraints with their table / column: do it, so a later unique toggle finds them
type RenameOp = Extract<Operation, { kind: 'renameField' | 'renameModel' }>
function renameUniques(op: RenameOp, from: ProjectState): Statement[] {
  const model = op.kind === 'renameField' ? op.model : op.from
  const table = op.kind === 'renameField' ? op.model : op.to
  const q = postgres.quoteIdent
  return Object.entries(findModel(from, model)!.model.fields)
    .filter(([n, f]) => f.opts.unique && (op.kind === 'renameModel' || n === op.from))
    .map(([n, f]) => {
      const col = (name: string) => fieldOf(f, from).columns(name)[0]
      return [uniqueName(model, col(n)), op.kind === 'renameField' ? uniqueName(model, col(op.to)) : uniqueName(table, col(n))]
    })
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => ({ sql: `ALTER TABLE ${q(table)} RENAME CONSTRAINT ${q(a)} TO ${q(b)}`, params: [] }))
}

export const postgres: Dialect = {
  name: 'postgres',
  quoteIdent: n => `"${checkIdent(n)}"`,
  param: i => `$${i}`,
  render: node => renderNode(node, postgres),
  lowerFn: 'lower',
  transactionalDDL: true,
  likeEscape: "E'\\\\'",
  bool: ['FALSE', 'TRUE'],
  nullsSmallest: false,
  renderOperation(op, from, to) {
    if (op.kind === 'alterField') return alterField(op, from, to)
    if (op.kind === 'renameField' || op.kind === 'renameModel') return [...defaultRender(op, postgres, from, to), ...renameUniques(op, from)]
    const o = op.kind === 'addField' ? op.field.opts : undefined
    if (op.kind === 'addField' && op.field.kind === 'datetime' && o?.auto && !o.optional && o.default === undefined) return addAutoDatetime(op, from, to)
    return defaultRender(op, postgres, from, to)
  },
}
