// The SQL engine: model fields → tables, QuerySpec → SQL, atomic(). Internal: nothing here
// leaks an engine type or name to devs; errors are rewritten to model/field vocabulary.
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, or, sql, type SQL } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { DomainError } from '../core/errors.js'
import { decodeCursor, type DataSource, type Op, type QuerySpec, type Where } from './queryset.js'
import { Expr, fieldZod, keyOf, pkField, type Field, type Kind, type ModelDef } from './fields.js'
import { getConn } from './db.js'

type F = Field<any, boolean, Kind, boolean>
const tables = new WeakMap<object, any>()

// ---- table definition ------------------------------------------------------------------------
export function tableFor(def: ModelDef): any {
  let t = tables.get(def)
  if (t) return t
  const cols: Record<string, any> = {}
  const idx: [string, string][] = []
  for (const [name, f] of Object.entries(def.fields)) {
    const o = f.opts
    const fin = (c: any) => {
      if (!o.optional && f.kind !== 'id') c = c.notNull()
      if (o.unique) c = c.unique()
      if (o.default !== undefined && f.kind !== 'money') c = c.default(o.default)
      return c
    }
    switch (f.kind) {
      case 'id': cols[name] = integer(name).primaryKey({ autoIncrement: true }); break
      case 'uuid': cols[name] = name === 'id' ? text(name).primaryKey() : fin(text(name)); break
      case 'text': case 'image': cols[name] = fin(text(name)); break
      case 'int': cols[name] = fin(integer(name)); break
      case 'float': cols[name] = fin(real(name)); break
      case 'bool': cols[name] = fin(integer(name, { mode: 'boolean' })); break
      case 'enum': cols[name] = fin(text(name, { enum: f.values as [string, ...string[]] })); break
      case 'datetime': cols[name] = fin(integer(name, { mode: 'timestamp_ms' })); break
      case 'json': cols[name] = fin(text(name, { mode: 'json' })); break
      case 'money':
        cols[name] = fin(integer(name))
        cols[`${name}Currency`] = o.optional ? text(`${name}Currency`) : text(`${name}Currency`).notNull()
        if (o.default !== undefined) {
          const d = o.default as { value: number; currency: string }
          cols[name] = cols[name].default(d.value); cols[`${name}Currency`] = cols[`${name}Currency`].default(d.currency)
        }
        break
      case 'fk': {
        const k = `${name}Id`
        const target = f.target!()
        const tpk = pkField(target)[1].kind
        const c = tpk === 'id' ? integer(k) : text(k)
        cols[k] = fin(c).references(() => tableFor(target)[pkField(target)[0]], { onDelete: 'restrict' })
        break
      }
    }
    if (o.index) idx.push([name, keyOf(name, f)])
  }
  pkField(def)
  t = sqliteTable(def.name, cols, tbl => idx.map(([n, k]) => index(`${def.name}_${n}_idx`).on(tbl[k])))
  tables.set(def, t)
  return t
}

// ---- row <-> domain object -------------------------------------------------------------------
function fromRow(def: ModelDef, r: Record<string, any>): any {
  const out: Record<string, unknown> = {}
  for (const [name, f] of Object.entries(def.fields)) {
    if (f.kind === 'money') {
      out[name] = r[name] == null ? null : { value: r[name], currency: r[`${name}Currency`] }
    } else out[keyOf(name, f)] = r[keyOf(name, f)] ?? null
  }
  return out
}

function toRow(def: ModelDef, data: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, f] of Object.entries(def.fields)) {
    const k = keyOf(name, f)
    if (!(k in data) || data[k] === undefined) continue
    if (f.kind === 'money') {
      out[name] = data[k]?.value ?? null; out[`${name}Currency`] = data[k]?.currency ?? null
    } else out[k] = data[k]
  }
  return out
}

// field name as written by the caller (`vendor` or `vendorId`) → column + field
function resolve(def: ModelDef, name: string): { col: any; f: F | undefined; key: string } {
  const t = tableFor(def)
  for (const [n, f] of Object.entries(def.fields)) {
    if (n === name || keyOf(n, f) === name) return { col: t[keyOf(n, f)], f, key: n }
  }
  throw new DomainError('invalid_param', `unknown field "${name}" on ${def.name}`, name)
}

// ---- error vocabulary ------------------------------------------------------------------------
function wrapErr(def: ModelDef, e: unknown): never {
  if (e instanceof DomainError) throw e
  const c = (e as { cause?: unknown }).cause ?? e
  const code = (c as { code?: string }).code ?? ''
  const msg = String((c as Error).message ?? '')
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    const field = msg.split(':').pop()?.trim().split('.').pop()?.replace(/Id$/, '')
    if (msg.startsWith('FOREIGN KEY')) throw new DomainError('domain', `${def.name} is still referenced by other records, or points at a record that does not exist`)
    if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) throw new DomainError('domain', `${def.name}.${field} must be unique`, field)
    if (code.includes('NOTNULL')) throw new DomainError('invalid_param', `${def.name}.${field} is required`, field)
  }
  throw new Error(`database error on ${def.name}`)
}

// ---- atomic ----------------------------------------------------------------------------------
// One connection, one serial queue: EVERY operation (atomic or not) waits its turn, and whether it
// sits inside a transaction is decided when it runs, never when it was called. Operations made from
// inside an atomic() callback skip the queue (they already own the connection); nested atomic reuses.
const inTx = new AsyncLocalStorage<true>()
let tail: Promise<unknown> = Promise.resolve()

function exec<R>(fn: () => R | Promise<R>): Promise<R> {
  if (inTx.getStore()) return Promise.resolve().then(fn)
  const run = tail.then(fn)
  tail = run.catch(() => undefined)
  return run
}

export function atomic<R>(fn: () => Promise<R>): Promise<R> {
  if (inTx.getStore()) return fn()
  return exec(async () => {
    const { sqlite } = getConn()
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const r = await inTx.run(true, fn)
      sqlite.exec('COMMIT')
      return r
    } catch (e) {
      sqlite.exec('ROLLBACK')
      throw e
    }
  })
}

// ---- QuerySpec → SQL -------------------------------------------------------------------------
const unwrap = (f: F | undefined, v: unknown) =>
  f?.kind === 'money' && v && typeof v === 'object' ? (v as { value: number }).value : v

const like = (col: unknown, term: string) =>
  sql`tv_lower(coalesce(${col}, '')) LIKE ${'%' + term.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'} ESCAPE '\\'`

function positive(col: any, op: Op, v: unknown): SQL {
  switch (op) {
    case 'eq': return v == null ? isNull(col) : eq(col, v)
    case 'ne': return v == null ? isNotNull(col) : or(isNull(col), ne(col, v))!
    case 'gt': return gt(col, v)
    case 'gte': return gte(col, v)
    case 'lt': return lt(col, v)
    case 'lte': return lte(col, v)
    case 'in': return Array.isArray(v) && v.length ? inArray(col, v) : sql`0`
    case 'contains': return and(isNotNull(col), like(col, String(v)))!
  }
}

function cond(def: ModelDef, w: Where): SQL {
  const { col, f } = resolve(def, w.field)
  const v = w.op === 'in' && Array.isArray(w.value) ? w.value.map(x => unwrap(f, x)) : unwrap(f, w.value)
  if (!w.not) return positive(col, w.op, v)
  // null-inclusive negation (orm-queryset.md): missing values match exclude()
  if (w.op === 'ne') return positive(col, 'eq', v)
  return or(isNull(col), not(positive(col, w.op, v)))!
}

function whereOf(def: ModelDef, ws: Where[], search?: QuerySpec['search']): SQL | undefined {
  const parts = ws.map(w => cond(def, w))
  if (search?.term) parts.push(or(...search.fields.map(n => like(resolve(def, n).col, search.term)))!)
  return parts.length ? and(...parts) : undefined
}

function after(def: ModelDef, order: NonNullable<QuerySpec['order']>, cv: unknown[]): SQL {
  const cols = order.map(o => resolve(def, o.field))
  const vals = cv.map((v, i) => unwrap(cols[i].f, v))
  const same = (i: number) => (vals[i] == null ? isNull(cols[i].col) : eq(cols[i].col, vals[i]))
  // nulls are the smallest value: asc goes past them, desc ends with them
  const beyond = (i: number): SQL => order[i].dir === 'asc'
    ? (vals[i] == null ? isNotNull(cols[i].col) : gt(cols[i].col, vals[i]))
    : (vals[i] == null ? sql`0` : or(lt(cols[i].col, vals[i]), isNull(cols[i].col))!)
  return or(...order.map((_, i) => and(...Array.from({ length: i }, (_, j) => same(j)), beyond(i))))!
}

// ---- DataSource ------------------------------------------------------------------------------
export function engineSource(def: ModelDef): DataSource<any> {
  const pk = pkField(def)[0]
  return {
    query: spec => exec(async () => {
      try {
        const { orm } = getConn(); const t = tableFor(def)
        const w = whereOf(def, spec.where, spec.search)
        const total = orm.select({ n: sql<number>`count(*)` }).from(t).where(w).get().n as number
        if (spec.limit <= 0) return { items: [], total }
        const order = spec.order ?? []
        let q = orm.select().from(t).$dynamic()
        let cw = w
        if (spec.cursor) {
          const cv = decodeCursor(spec.cursor)
          if (cv.length !== order.length) throw new Error('invalid cursor')
          cw = w ? and(w, after(def, order, cv)) : after(def, order, cv)
        }
        q = q.where(cw).orderBy(...order.map(o => (o.dir === 'desc' ? desc : asc)(resolve(def, o.field).col))).limit(spec.limit)
        return { items: q.all().map((r: any) => fromRow(def, r)), total }
      } catch (e) { return wrapErr(def, e) }
    }),
    get: id => exec(async () => {
      try {
        const r = getConn().orm.select().from(tableFor(def)).where(eq(tableFor(def)[pk], id)).get()
        return r ? fromRow(def, r) : undefined
      } catch (e) { return wrapErr(def, e) }
    }),
    update: (ws, patch) => exec(async () => {
      try {
        const set: Record<string, unknown> = {}
        const t = tableFor(def)
        for (const [name, v] of Object.entries(patch)) {
          const { col, f, key } = resolve(def, name)
          if (v instanceof Expr) {
            if (f!.kind !== 'int' && f!.kind !== 'float') throw new DomainError('invalid_param', `${def.name}.${key} cannot use inc/dec`, key)
            set[keyOf(key, f!)] = v.op === 'dec' ? sql`${col} - ${v.n}` : sql`${col} + ${v.n}`
            continue
          }
          const r = fieldZod(f!).safeParse(v)
          if (!r.success) throw new DomainError('invalid_param', `${def.name}.${key}: ${r.error.issues[0].message}`, key)
          Object.assign(set, toRow(def, { [keyOf(key, f!)]: r.data }))
        }
        if (!Object.keys(set).length) return 0
        return getConn().orm.update(t).set(set).where(whereOf(def, ws)).run().changes as number
      } catch (e) { return wrapErr(def, e) }
    }),
    delete: ws => exec(async () => {
      try {
        return getConn().orm.delete(tableFor(def)).where(whereOf(def, ws)).run().changes as number
      } catch (e) { return wrapErr(def, e) }
    }),
  }
}

export function insertRow(def: ModelDef, data: Record<string, unknown>): Promise<any> {
  return exec(async () => {
    try {
      const r = getConn().orm.insert(tableFor(def)).values(toRow(def, data)).returning().get()
      return fromRow(def, r)
    } catch (e) { return wrapErr(def, e) }
  })
}
