// Migration operations (Django's set, v1). Each op is plain data + two steps:
//   stateForwards(state, app)            — replay: how the op changes ProjectState
//   databaseForwards(dialect, from, to)  — the SQL, via dialect.renderOperation (sqlite rebuilds
//                                          tables for what it cannot ALTER; see dialects/sqlite.ts)
// Column DDL always comes from the Field (columnDDL / dbType): fields own it, ops only collect.
import type { DbName, Field, Kind } from '../fields/index.js'
import { isNull, param, type SqlNode } from '../sql/ast.js'
import { checkIdent, type Dialect, type Statement } from '../sql/dialect.js'
import { fieldOf, findModel, modelDef, modelIn, specOf, type FieldSpec, type ModelState, type ProjectState } from './state.js'

type AnyField = Field<any, boolean, Kind, boolean>
export type SQL = string | string[]

export type OpData =
  | { kind: 'createModel'; model: string; fields: Record<string, FieldSpec> }
  | { kind: 'deleteModel'; model: string }
  | { kind: 'addField'; model: string; name: string; field: FieldSpec }
  | { kind: 'removeField'; model: string; name: string }
  | { kind: 'alterField'; model: string; name: string; field: FieldSpec }
  | { kind: 'renameField'; model: string; from: string; to: string }
  | { kind: 'renameModel'; from: string; to: string }
  | { kind: 'addIndex'; model: string; name: string; fields: string[]; unique?: boolean }
  | { kind: 'removeIndex'; model: string; name: string }
  | { kind: 'runSQL'; sql: SQL | Partial<Record<DbName, SQL>> }

export type Operation = OpData & {
  stateForwards(state: ProjectState, app: string): void
  databaseForwards(d: Dialect, from: ProjectState, to: ProjectState): Statement[]
}

export interface Migration { dependencies: [string, string][]; operations: Operation[] }

// data is cloned in and cloned into the state, so replay can never mutate an op (or its checksum)
export function makeOp(data: OpData): Operation {
  const o = {
    ...structuredClone(data),
    stateForwards: (s: ProjectState, app: string) => forwards(o, s, app),
    databaseForwards: (d: Dialect, from: ProjectState, to: ProjectState) => d.renderOperation(o, from, to),
  } as Operation
  return o
}

const id = checkIdent
const specs = (fields: Record<string, AnyField>) =>
  Object.fromEntries(Object.entries(fields).map(([n, f]) => [id(n), specOf(f)]))

export const ops = {
  createModel: (model: string, fields: Record<string, AnyField>) => makeOp({ kind: 'createModel', model: id(model), fields: specs(fields) }),
  deleteModel: (model: string) => makeOp({ kind: 'deleteModel', model: id(model) }),
  addField: (model: string, name: string, field: AnyField) => makeOp({ kind: 'addField', model: id(model), name: id(name), field: specOf(field) }),
  removeField: (model: string, name: string) => makeOp({ kind: 'removeField', model: id(model), name: id(name) }),
  alterField: (model: string, name: string, field: AnyField) => makeOp({ kind: 'alterField', model: id(model), name: id(name), field: specOf(field) }),
  renameField: (model: string, from: string, to: string) => makeOp({ kind: 'renameField', model: id(model), from: id(from), to: id(to) }),
  renameModel: (from: string, to: string) => makeOp({ kind: 'renameModel', from: id(from), to: id(to) }),
  addIndex: (model: string, name: string, fields: string[], opts: { unique?: boolean } = {}) =>
    makeOp({ kind: 'addIndex', model: id(model), name: id(name), fields: fields.map(id), ...(opts.unique ? { unique: true } : {}) }),
  removeIndex: (model: string, name: string) => makeOp({ kind: 'removeIndex', model: id(model), name: id(name) }),
  // escape hatch, like Django's RunSQL: one string per statement; a bare string/array runs on every dialect
  runSQL: (sql: SQL | Partial<Record<DbName, SQL>>) => makeOp({ kind: 'runSQL', sql }),
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
      ;(s.apps[app] ??= {})[o.model] = { fields: c(o.fields), indexes: {} }
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
    case 'runSQL': return
  }
}

// ---- SQL --------------------------------------------------------------------------------------
type Ix = { name: string; table: string; cols: string[]; unique?: boolean }

// every index a model has in `state`: field-level `index: true` (<model>_<field>_idx) + explicit
export function indexesOf(state: ProjectState, model: string): Ix[] {
  const m = findModel(state, model)?.model
  if (!m) return []
  const col = (n: string) => fieldOf(m.fields[n], state).columns(n)[0]
  return [
    ...Object.entries(m.fields).filter(([, f]) => f.opts.index).map(([n]) => ({ name: `${model}_${n}_idx`, table: model, cols: [col(n)] })),
    ...Object.entries(m.indexes).map(([name, ix]) => ({ name, table: model, cols: ix.fields.map(col), ...(ix.unique ? { unique: true } : {}) })),
  ]
}

// indexes to drop (gone or changed) and to create (new or changed) between two states
export function indexDiff(d: Dialect, from: ProjectState, fromModel: string, to: ProjectState, toModel: string) {
  const key = (i: Ix) => JSON.stringify([i.name, i.table, i.cols, !!i.unique])
  const a = indexesOf(from, fromModel), b = indexesOf(to, toModel)
  const ak = new Set(a.map(key)), bk = new Set(b.map(key))
  return {
    drop: a.filter(i => !bk.has(key(i))).map(i => d.render({ t: 'dropIndex', name: i.name, table: toModel })),   // dropped after a renameModel
    create: b.filter(i => !ak.has(key(i))).map(i => d.render({ t: 'createIndex', ...i })),
  }
}

export function createTable(d: Dialect, state: ProjectState, model: string, as = model): Statement {
  const def = modelDef(state, model)
  const fields = Object.entries(def.fields)
  return d.render({ t: 'createTable', name: as, columns: [...fields.flatMap(([n, f]) => f.columnDDL(n, d)), ...fields.flatMap(([n, f]) => f.tableConstraints(as, n, d))] })
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
    case 'addIndex': case 'removeIndex': {
      const ix = indexDiff(d, from, o.model, to, o.model)
      return [...ix.drop, ...ix.create]
    }
    case 'runSQL': return runSQLFor(o.sql, d)
  }
}
