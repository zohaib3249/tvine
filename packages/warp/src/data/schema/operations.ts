// Migration operations (Django's set, v1). Each op is plain data + two steps:
//   stateForwards(state, app)            — replay: how the op changes ProjectState
//   databaseForwards(dialect, from, to)  — the SQL, via dialect.renderOperation (sqlite rebuilds
//                                          tables for what it cannot ALTER; see dialects/sqlite.ts)
// Column DDL always comes from the Field (columnDDL / dbType): fields own it, ops only collect.
import { throughOf, type DbName, type Field, type Kind } from '../fields/index.js'
import { isNull, param, type Expr, type SqlNode } from '../sql/ast.js'
import { checkIdent, objectName, type Dialect, type Statement } from '../sql/dialect.js'
import { ddlScope } from '../sql/compile.js'
import { Table } from '../table.js'
import { rebuildTable } from '../sql/dialects/sqlite.js'
import { qFromData, type ConstraintSpec, type QData } from '../expressions.js'
import { fieldOf, findModel, modelDef, modelIn, specOf, type FieldSpec, type IndexSpec, type ModelState, type ProjectState } from './state.js'

type AnyField = Field<any, boolean, Kind, boolean>
export type SQL = string | string[]

export type OpData =
  | { kind: 'createModel'; model: string; fields: Record<string, FieldSpec>; indexes?: Record<string, IndexSpec>; unique?: string[][]; constraints?: Record<string, ConstraintSpec> }
  | { kind: 'deleteModel'; model: string }
  | { kind: 'addField'; model: string; name: string; field: FieldSpec }
  | { kind: 'removeField'; model: string; name: string }
  | { kind: 'alterField'; model: string; name: string; field: FieldSpec }
  | { kind: 'renameField'; model: string; from: string; to: string }
  | { kind: 'renameModel'; from: string; to: string }
  | { kind: 'addIndex'; model: string; name: string; fields: string[]; unique?: boolean }
  | { kind: 'removeIndex'; model: string; name: string }
  | { kind: 'addConstraint'; model: string; constraint: ConstraintSpec }
  | { kind: 'removeConstraint'; model: string; name: string }
  | { kind: 'alterUniqueTogether'; model: string; unique: string[][] }
  // reverse: what rollback runs ([] = nothing to undo); absent = irreversible
  | { kind: 'runSQL'; sql: SQL | Partial<Record<DbName, SQL>>; reverse?: SQL | Partial<Record<DbName, SQL>> }

export type Operation = OpData & {
  stateForwards(state: ProjectState, app: string): void
  databaseForwards(d: Dialect, from: ProjectState, to: ProjectState): Statement[]
  // rollback: from = state AFTER the op, to = state BEFORE it. Throws when the op cannot be reversed.
  databaseBackwards(d: Dialect, from: ProjectState, to: ProjectState, app: string): Statement[]
}

export interface Migration { dependencies: [string, string][]; operations: Operation[] }

// data is cloned in and cloned into the state, so replay can never mutate an op (or its checksum)
export function makeOp(data: OpData): Operation {
  const o = {
    ...structuredClone(data),
    stateForwards: (s: ProjectState, app: string) => forwards(o, s, app),
    databaseForwards: (d: Dialect, from: ProjectState, to: ProjectState) => renderOp(o, d, from, to),
    databaseBackwards: (d: Dialect, after: ProjectState, before: ProjectState) => renderOp(inverse(o, before), d, after, before),
  } as Operation
  return o
}

const id = checkIdent
const specs = (fields: Record<string, AnyField>) =>
  Object.fromEntries(Object.entries(fields).map(([n, f]) => [id(n), specOf(f)]))

type MetaOpts = { indexes?: Record<string, IndexSpec>; unique?: string[][]; constraints?: Record<string, ConstraintSpec> }
const metaOf = (m: MetaOpts = {}) => ({
  ...(m.indexes && Object.keys(m.indexes).length ? { indexes: Object.fromEntries(Object.entries(m.indexes).map(([n, i]) => [id(n), { ...i, fields: i.fields.map(id) }])) } : {}),
  ...(m.unique?.length ? { unique: m.unique.map(u => u.map(id)) } : {}),
  ...(m.constraints && Object.keys(m.constraints).length ? { constraints: Object.fromEntries(Object.entries(m.constraints).map(([n, c]) => [id(n), c])) } : {}),
})

export const ops = {
  createModel: (model: string, fields: Record<string, AnyField>, meta?: MetaOpts) => makeOp({ kind: 'createModel', model: id(model), fields: specs(fields), ...metaOf(meta) }),
  deleteModel: (model: string) => makeOp({ kind: 'deleteModel', model: id(model) }),
  addField: (model: string, name: string, field: AnyField) => makeOp({ kind: 'addField', model: id(model), name: id(name), field: specOf(field) }),
  removeField: (model: string, name: string) => makeOp({ kind: 'removeField', model: id(model), name: id(name) }),
  alterField: (model: string, name: string, field: AnyField) => makeOp({ kind: 'alterField', model: id(model), name: id(name), field: specOf(field) }),
  renameField: (model: string, from: string, to: string) => makeOp({ kind: 'renameField', model: id(model), from: id(from), to: id(to) }),
  renameModel: (from: string, to: string) => makeOp({ kind: 'renameModel', from: id(from), to: id(to) }),
  addIndex: (model: string, name: string, fields: string[], opts: { unique?: boolean } = {}) =>
    makeOp({ kind: 'addIndex', model: id(model), name: id(name), fields: fields.map(id), ...(opts.unique ? { unique: true } : {}) }),
  removeIndex: (model: string, name: string) => makeOp({ kind: 'removeIndex', model: id(model), name: id(name) }),
  addConstraint: (model: string, constraint: ConstraintSpec) => makeOp({ kind: 'addConstraint', model: id(model), constraint: { ...constraint, name: id(constraint.name) } }),
  removeConstraint: (model: string, name: string) => makeOp({ kind: 'removeConstraint', model: id(model), name: id(name) }),
  alterUniqueTogether: (model: string, unique: string[][]) => makeOp({ kind: 'alterUniqueTogether', model: id(model), unique: unique.map(u => u.map(id)) }),
  // escape hatch, like Django's RunSQL: one string per statement; a bare string/array runs on every dialect.
  // reverse: the rollback SQL ([] = nothing to undo); without it the migration cannot be rolled back
  runSQL: (sql: SQL | Partial<Record<DbName, SQL>>, opts: { reverse?: SQL | Partial<Record<DbName, SQL>> } = {}) =>
    makeOp({ kind: 'runSQL', sql, ...(opts.reverse !== undefined ? { reverse: opts.reverse } : {}) }),
}

// what a migration destroys (drop guard + the DESTRUCTIVE header)
export const destroyed = (list: readonly OpData[]): string[] => list.flatMap(o =>
  o.kind === 'deleteModel' ? [o.model] : o.kind === 'removeField' ? [`${o.model}.${o.name}`] : [])

// ---- state ------------------------------------------------------------------------------------
function need(m: ModelState, model: string, name: string): void {
  if (!(name in m.fields)) throw new Error(`${model} has no field "${name}"`)
}
function free(m: ModelState, model: string, name: string): void {
  if (name in m.fields) throw new Error(`${model} already has a field "${name}"`)
}

function forwards(o: OpData, s: ProjectState, app: string): void {
  const c = structuredClone
  switch (o.kind) {
    case 'createModel': {
      if (findModel(s, o.model)) throw new Error(`model "${o.model}" already exists`)
      if (!['id', 'uuid'].includes(o.fields.id?.kind)) throw new Error(`model "${o.model}" needs an id field: id: field.id()`)
      ;(s.apps[app] ??= {})[o.model] = {
        fields: c(o.fields), indexes: c(o.indexes ?? {}),
        ...(o.unique?.length ? { unique: c(o.unique) } : {}), ...(o.constraints && Object.keys(o.constraints).length ? { constraints: c(o.constraints) } : {}),
      }
      return
    }
    case 'deleteModel': {
      modelIn(s, app, o.model)
      delete s.apps[app][o.model]
      if (!Object.keys(s.apps[app]).length) delete s.apps[app]
      return
    }
    case 'addField': {
      const m = modelIn(s, app, o.model)
      free(m, o.model, o.name)
      m.fields[o.name] = c(o.field)
      return
    }
    case 'removeField': {
      const m = modelIn(s, app, o.model)
      need(m, o.model, o.name)
      delete m.fields[o.name]
      for (const [n, ix] of Object.entries(m.indexes)) if (ix.fields.includes(o.name)) delete m.indexes[n]
      if (m.unique) { m.unique = m.unique.filter(u => !u.includes(o.name)); if (!m.unique.length) delete m.unique }
      return
    }
    case 'alterField': {
      const m = modelIn(s, app, o.model)
      need(m, o.model, o.name)
      m.fields[o.name] = c(o.field)
      return
    }
    case 'renameField': {
      const m = modelIn(s, app, o.model)
      need(m, o.model, o.from); free(m, o.model, o.to)
      m.fields = Object.fromEntries(Object.entries(m.fields).map(([n, f]) => [n === o.from ? o.to : n, f]))
      for (const ix of Object.values(m.indexes)) ix.fields = ix.fields.map(f => (f === o.from ? o.to : f))
      if (m.unique) m.unique = m.unique.map(u => u.map(f => (f === o.from ? o.to : f)))
      for (const k of Object.keys(m.constraints ?? {})) m.constraints![k] = renameIn(m.constraints![k], o.from, o.to)
      return
    }
    case 'renameModel': {
      modelIn(s, app, o.from)
      if (findModel(s, o.to)) throw new Error(`model "${o.to}" already exists`)
      s.apps[app] = Object.fromEntries(Object.entries(s.apps[app]).map(([n, m]) => [n === o.from ? o.to : n, m]))
      for (const models of Object.values(s.apps)) {
        for (const m of Object.values(models)) for (const f of Object.values(m.fields)) if (f.kind === 'fk' && f.to === o.from) f.to = o.to
      }
      return
    }
    case 'addIndex': {
      const m = modelIn(s, app, o.model)
      if (o.name in m.indexes) throw new Error(`${o.model} already has an index "${o.name}"`)
      for (const f of o.fields) need(m, o.model, f)
      m.indexes[o.name] = { fields: [...o.fields], ...(o.unique ? { unique: true } : {}) }
      return
    }
    case 'removeIndex': {
      const m = modelIn(s, app, o.model)
      if (!(o.name in m.indexes)) throw new Error(`${o.model} has no index "${o.name}"`)
      delete m.indexes[o.name]
      return
    }
    case 'addConstraint': {
      const m = modelIn(s, app, o.model)
      if (m.constraints?.[o.constraint.name]) throw new Error(`${o.model} already has a constraint "${o.constraint.name}"`)
      if (o.constraint.kind === 'unique') for (const f of o.constraint.fields) need(m, o.model, f)
      ;(m.constraints ??= {})[o.constraint.name] = c(o.constraint)
      return
    }
    case 'removeConstraint': {
      const m = modelIn(s, app, o.model)
      if (!m.constraints?.[o.name]) throw new Error(`${o.model} has no constraint "${o.name}"`)
      delete m.constraints[o.name]
      if (!Object.keys(m.constraints).length) delete m.constraints
      return
    }
    case 'alterUniqueTogether': {
      const m = modelIn(s, app, o.model)
      for (const u of o.unique) for (const f of u) need(m, o.model, f)
      if (o.unique.length) m.unique = c(o.unique)
      else delete m.unique
      return
    }
    case 'runSQL': return
  }
}

// a renamed field inside a constraint (its CHECK lookups / unique fields)
function renameIn(c: ConstraintSpec, from: string, to: string): ConstraintSpec {
  const q = (d: QData): QData => ({ ...d, items: d.items.map(i => {
    if (!Array.isArray(i)) return q(i)
    const parts = i[0].split('__')
    if (parts[0] === from) parts[0] = to
    const v = i[1] && typeof i[1] === 'object' && '$F' in (i[1] as object) && (i[1] as { $F: string }).$F === from ? { $F: to } : i[1]
    return [parts.join('__'), v] as [string, unknown]
  }) })
  if (c.kind === 'check') return { ...c, check: q(c.check) }
  return { ...c, fields: c.fields.map(f => (f === from ? to : f)), ...(c.condition ? { condition: q(c.condition) } : {}) }
}

// ---- SQL --------------------------------------------------------------------------------------
type Ix = { name: string; table: string; cols: string[]; unique?: boolean; cond?: QData }

// every index a model has in `state`: field-level `index: true` (<model>_<field>_idx), Meta / explicit
// indexes, unique-together sets (<model>_<fields>_uniq) and UNIQUE constraints — all UNIQUE INDEXes
// (portable: sqlite has no ADD CONSTRAINT)
export function indexesOf(state: ProjectState, model: string): Ix[] {
  const m = findModel(state, model)?.model
  if (!m) return []
  const col = (n: string) => fieldOf(m.fields[n], state).columns(n)[0]
  return [
    ...Object.entries(m.fields).filter(([, f]) => f.opts.index).map(([n]) => ({ name: `${model}_${n}_idx`, table: model, cols: [col(n)] })),
    ...Object.entries(m.indexes).map(([name, ix]) => ({ name, table: model, cols: ix.fields.map(col), ...(ix.unique ? { unique: true } : {}) })),
    ...(m.unique ?? []).map(u => ({ name: objectName(model, u, 'uniq'), table: model, cols: u.map(col), unique: true })),
    ...Object.values(m.constraints ?? {}).flatMap(c => c.kind === 'unique'
      ? [{ name: c.name, table: model, cols: c.fields.map(col), unique: true, ...(c.condition ? { cond: c.condition } : {}) }] : []),
  ]
}

// a CHECK / partial-index condition as SQL with checked literals (DDL takes no params)
export function condSQL(d: Dialect, state: ProjectState, model: string, q: QData): string {
  return d.render(condExpr(d, state, model, q), { inline: true }).sql
}
const condExpr = (d: Dialect, state: ProjectState, model: string, q: QData): Expr => ddlScope(modelDef(state, model), d).q(qFromData(q))

export function createIndexStmt(d: Dialect, state: ProjectState, i: Ix): Statement {
  const { cond, ...rest } = i
  return cond ? d.render({ t: 'createIndex', ...rest, where: condExpr(d, state, i.table, cond) }, { inline: true }) : d.render({ t: 'createIndex', ...rest })
}

// indexes to drop (gone or changed) and to create (new or changed) between two states
export function indexDiff(d: Dialect, from: ProjectState, fromModel: string, to: ProjectState, toModel: string) {
  const key = (i: Ix) => JSON.stringify([i.name, i.table, i.cols, !!i.unique, i.cond ?? null])
  const a = indexesOf(from, fromModel), b = indexesOf(to, toModel)
  const ak = new Set(a.map(key)), bk = new Set(b.map(key))
  return {
    drop: a.filter(i => !bk.has(key(i))).map(i => d.render({ t: 'dropIndex', name: i.name, table: toModel })),   // dropped after a renameModel
    create: b.filter(i => !ak.has(key(i))).map(i => createIndexStmt(d, to, i)),
  }
}

const checksOf = (state: ProjectState, model: string) =>
  Object.values(findModel(state, model)?.model.constraints ?? {}).filter((c): c is Extract<ConstraintSpec, { kind: 'check' }> => c.kind === 'check')

export function createTable(d: Dialect, state: ProjectState, model: string, as = model): Statement {
  const def = modelDef(state, model)
  const fields = Object.entries(def.fields)
  const checks = checksOf(state, model).map(c => `CONSTRAINT ${d.quoteIdent(c.name)} CHECK (${condSQL(d, state, model, c.check)})`)
  return d.render({ t: 'createTable', name: as, columns: [...fields.flatMap(([n, f]) => f.columnDDL(n, d)), ...fields.flatMap(([n, f]) => f.tableConstraints(as, n, d)), ...checks] })
}

// alterField guards for dialects that ALTER in place (postgres, mysql): the column set and the fk
// target must stay, and a cast that would silently change stored values (1.5 → 2) is refused
export function alterGuard(op: Extract<OpData, { kind: 'alterField' }>, d: Dialect, from: ProjectState, to: ProjectState) {
  const spec = findModel(from, op.model)!.model.fields[op.name]
  const was = fieldOf(spec, from), now = fieldOf(op.field, to)
  const a = was.columns(op.name), b = now.columns(op.name)
  const lost = a.filter(c => !b.includes(c))
  if (lost.length || a.length !== b.length) {
    throw new Error(`alterField ${op.model}.${op.name} would drop column(s) ${lost.join(', ')}: write removeField + addField or a runSQL data migration`)
  }
  if (spec.to !== op.field.to) {
    throw new Error(`alterField ${op.model}.${op.name} changes its foreign key target; write removeField + addField or a runSQL migration`)
  }
  if (spec.kind === 'float' && ['int', 'fk', 'id'].includes(op.field.kind)) {
    throw new Error(`alterField ${op.model}.${op.name} changes ${was.dbType(d)[0]} → ${now.dbType(d)[0]}, which would round stored values: write a runSQL data migration`)
  }
  return { was, now }
}

// a required auto datetime on a table that may hold rows: add nullable, backfill the migration time,
// then `notNull` (the dialect's own SET NOT NULL)
export function addAutoDatetime(op: Extract<OpData, { kind: 'addField' }>, d: Dialect, from: ProjectState, to: ProjectState, notNull: Statement): Statement[] {
  const f = fieldOf({ ...op.field, opts: { ...op.field.opts, optional: true } }, to)
  return [
    ...f.columnDDL(op.name, d).map(c => d.render({ t: 'alterTable', name: op.model, addColumn: c })),
    d.render({ t: 'update', table: op.model, set: [[op.name, param(f.toDb(new Date(), d)[0])]], where: isNull({ t: 'col', name: op.name }) }),
    notNull,
    ...indexDiff(d, from, op.model, to, op.model).create,
  ]
}

export const columnsOf = (state: ProjectState, model: string) =>
  Object.entries(modelDef(state, model).fields).flatMap(([n, f]) => f.columns(n))

// did an alterField change the column(s) themselves (vs only non-DB options / the index)?
export function columnsChanged(o: Extract<OpData, { kind: 'alterField' }>, d: Dialect, from: ProjectState, to: ProjectState): boolean {
  const ddl = (s: ProjectState) => modelDef(s, o.model).fields[o.name].columnDDL(o.name, d).join()
  return ddl(from) !== ddl(to)
}

function runSQLFor(sql: Extract<OpData, { kind: 'runSQL' }>['sql'], d: Dialect): Statement[] {
  const s = typeof sql === 'string' || Array.isArray(sql) ? sql : sql[d.name]
  if (s === undefined) throw new Error(`runSQL has no SQL for ${d.name}`)
  return (Array.isArray(s) ? s : [s]).map(x => ({ sql: x, params: [] }))
}

// The shared rendering (native ALTERs). Dialects override what they cannot do natively.
export function defaultRender(o: OpData, d: Dialect, from: ProjectState, to: ProjectState): Statement[] {
  const r = (n: SqlNode) => d.render(n)
  switch (o.kind) {
    case 'createModel': return [createTable(d, to, o.model), ...indexDiff(d, from, o.model, to, o.model).create]
    case 'deleteModel': return [r({ t: 'dropTable', name: o.model })]
    case 'addField': {
      const cols = modelDef(to, o.model).fields[o.name].columnDDL(o.name, d)
      return [...cols.map(c => r({ t: 'alterTable', name: o.model, addColumn: c })), ...indexDiff(d, from, o.model, to, o.model).create]
    }
    case 'removeField': {
      const cols = fieldOf(findModel(from, o.model)!.model.fields[o.name], from).columns(o.name)
      return [...indexDiff(d, from, o.model, to, o.model).drop, ...cols.map(c => r({ t: 'alterTable', name: o.model, dropColumn: c }))]
    }
    case 'alterField': {
      // sqlite rebuilds, postgres / mysql render native ALTERs (dialects/*)
      if (columnsChanged(o, d, from, to)) throw new Error(`alterField ${o.model}.${o.name} is not supported on ${d.name}`)
      const ix = indexDiff(d, from, o.model, to, o.model)
      return [...ix.drop, ...ix.create]
    }
    case 'renameField': {
      const spec = findModel(from, o.model)!.model.fields[o.from]
      const a = fieldOf(spec, from).columns(o.from), b = fieldOf(spec, from).columns(o.to)
      const ix = indexDiff(d, from, o.model, to, o.model)
      return [...ix.drop, ...a.map((c, i) => r({ t: 'alterTable', name: o.model, renameColumn: { from: c, to: b[i] } })), ...ix.create]
    }
    case 'renameModel': {
      const ix = indexDiff(d, from, o.from, to, o.to)
      return [r({ t: 'alterTable', name: o.from, renameTo: o.to }), ...ix.drop, ...ix.create]
    }
    case 'addIndex': case 'removeIndex': case 'alterUniqueTogether': {
      const ix = indexDiff(d, from, o.model, to, o.model)
      return [...ix.drop, ...ix.create]
    }
    case 'addConstraint': case 'removeConstraint': {
      const c = o.kind === 'addConstraint' ? o.constraint : findModel(from, o.model)!.model.constraints![o.name]
      if (c.kind === 'unique') {
        const ix = indexDiff(d, from, o.model, to, o.model)
        return [...ix.drop, ...ix.create]
      }
      // CHECK: postgres / mysql ALTER (sqlite rebuilds — dialects/sqlite.ts)
      const q = d.quoteIdent
      if (o.kind === 'addConstraint') return [{ sql: `ALTER TABLE ${q(o.model)} ADD CONSTRAINT ${q(c.name)} CHECK (${condSQL(d, to, o.model, (c as { check: QData }).check)})`, params: [] }]
      return [{ sql: `ALTER TABLE ${q(o.model)} DROP ${d.name === 'mysql' ? 'CHECK' : 'CONSTRAINT'} ${q(c.name)}`, params: [] }]
    }
    case 'runSQL': return runSQLFor(o.sql, d)
  }
}

// ---- many-to-many through tables (around every dialect's renderOperation) -------------------------------
const autoM2M = (state: ProjectState, model: string) => {
  const m = findModel(state, model)?.model
  if (!m) return []
  const def = modelDef(state, model)
  return Object.entries(m.fields).filter(([, f]) => f.kind === 'm2m' && !f.through).map(([n]) => ({ name: n, t: throughOf(def, n, def.fields[n]) }))
}
function createThrough(d: Dialect, t: ReturnType<typeof throughOf>): Statement[] {
  const [s, ds] = [t.def.fields[t.src].columns(t.src)[0], t.def.fields[t.dst].columns(t.dst)[0]]
  return [...Table.of(t.def).createSQL(d), d.render({ t: 'createIndex', name: objectName(t.def.name, [s, ds], 'uniq'), table: t.def.name, cols: [s, ds], unique: true })]
}
const dropThrough = (d: Dialect, t: ReturnType<typeof throughOf>): Statement => d.render({ t: 'dropTable', name: t.def.name })

function renderOp(o: OpData, d: Dialect, from: ProjectState, to: ProjectState): Statement[] {
  const m2m = (s: ProjectState, model: string, name: string) => findModel(s, model)?.model.fields[name]?.kind === 'm2m'
  switch (o.kind) {
    case 'createModel': return [...d.renderOperation(o as Operation, from, to), ...autoM2M(to, o.model).flatMap(x => createThrough(d, x.t))]
    case 'deleteModel': return [...autoM2M(from, o.model).map(x => dropThrough(d, x.t)), ...d.renderOperation(o as Operation, from, to)]
    case 'addField': if (!m2m(to, o.model, o.name)) break
      return autoM2M(to, o.model).filter(x => x.name === o.name).flatMap(x => createThrough(d, x.t))
    case 'removeField': if (!m2m(from, o.model, o.name)) break
      return autoM2M(from, o.model).filter(x => x.name === o.name).map(x => dropThrough(d, x.t))
    case 'alterField': {
      if (!m2m(from, o.model, o.name) && !m2m(to, o.model, o.name)) break
      const a = findModel(from, o.model)!.model.fields[o.name]
      if (a.kind !== o.field.kind || a.to !== o.field.to || a.through !== o.field.through) {
        throw new Error(`alterField ${o.model}.${o.name}: a many-to-many cannot change kind, target or through model; write removeField + addField`)
      }
      return []
    }
    case 'renameField': if (m2m(from, o.model, o.from) && autoM2M(from, o.model).some(x => x.name === o.from)) {
      throw new Error(`renameField ${o.model}.${o.from}: renaming an auto many-to-many is not supported (its through table is named after it); write runSQL`)
    }
      break
    case 'renameModel': {
      const owns = autoM2M(from, o.from).length
      const targeted = Object.values(from.apps).some(ms => Object.values(ms).some(m => Object.values(m.fields).some(f => f.kind === 'm2m' && f.to === o.from && !f.through)))
      if (owns || targeted) throw new Error(`renameModel ${o.from}: a model with an auto many-to-many is not renamed automatically (through table + columns); write runSQL`)
      break
    }
    case 'addConstraint': case 'removeConstraint': {
      const c = o.kind === 'addConstraint' ? o.constraint : findModel(from, o.model)!.model.constraints![o.name]
      if (c.kind === 'check' && d.name === 'sqlite') return sqliteRebuild(o.model, from, to)
      break
    }
  }
  return d.renderOperation(o as Operation, from, to)
}

const sqliteRebuild = (model: string, from: ProjectState, to: ProjectState) => rebuildTable(model, from, to)   // import cycle: used at call time only

// ---- rollback: each op's inverse, from the state BEFORE it ------------------------------------------
const irreversible = (o: OpData, why: string) => new Error(`cannot roll back ${o.kind}${'model' in o ? ` ${o.model}` : ''}: ${why}`)
export function inverse(o: OpData, before: ProjectState): OpData {
  const m = (name: string) => findModel(before, name)?.model
  const refill = (model: string, name: string, f: FieldSpec) => {
    if (f.kind !== 'm2m' && f.kind !== 'id' && f.kind !== 'uuid' && !f.opts.optional && f.opts.default === undefined && !f.opts.auto) {
      throw irreversible(o, `${model}.${name} is required and has no default, so existing rows could not be re-filled (add a default, or write a runSQL migration)`)
    }
  }
  switch (o.kind) {
    case 'createModel': return { kind: 'deleteModel', model: o.model }
    case 'deleteModel': {
      const s = m(o.model)!
      return { kind: 'createModel', model: o.model, fields: structuredClone(s.fields), indexes: structuredClone(s.indexes),
        ...(s.unique ? { unique: structuredClone(s.unique) } : {}), ...(s.constraints ? { constraints: structuredClone(s.constraints) } : {}) }
    }
    case 'addField': return { kind: 'removeField', model: o.model, name: o.name }
    case 'removeField': {
      const f = m(o.model)!.fields[o.name]
      refill(o.model, o.name, f)
      return { kind: 'addField', model: o.model, name: o.name, field: structuredClone(f) }
    }
    case 'alterField': return { kind: 'alterField', model: o.model, name: o.name, field: structuredClone(m(o.model)!.fields[o.name]) }
    case 'renameField': return { kind: 'renameField', model: o.model, from: o.to, to: o.from }
    case 'renameModel': return { kind: 'renameModel', from: o.to, to: o.from }
    case 'addIndex': return { kind: 'removeIndex', model: o.model, name: o.name }
    case 'removeIndex': {
      const ix = m(o.model)!.indexes[o.name]
      return { kind: 'addIndex', model: o.model, name: o.name, fields: [...ix.fields], ...(ix.unique ? { unique: true } : {}) }
    }
    case 'addConstraint': return { kind: 'removeConstraint', model: o.model, name: o.constraint.name }
    case 'removeConstraint': return { kind: 'addConstraint', model: o.model, constraint: structuredClone(m(o.model)!.constraints![o.name]) }
    case 'alterUniqueTogether': return { kind: 'alterUniqueTogether', model: o.model, unique: structuredClone(m(o.model)!.unique ?? []) }
    case 'runSQL':
      if (o.reverse === undefined) throw irreversible(o, 'runSQL has no reverse (pass ops.runSQL(sql, { reverse }) — [] when there is nothing to undo)')
      return { kind: 'runSQL', sql: o.reverse }
  }
}

// does rolling back this op lose nothing it cannot rebuild? (checked for a whole plan before any SQL runs)
export function checkReversible(o: OpData, before: ProjectState): void { inverse(o, before) }
