// The SQL engine: Table statements → driver, atomic(), onCommit(). Internal: nothing here leaks an
// engine type or name to devs; errors are rewritten to model/field vocabulary.
import { AsyncLocalStorage } from 'node:async_hooks'
import { DomainError } from '../core/errors.js'
import { CURSOR, type DataSource, type QuerySpec, type Where } from './queryset.js'
import type { ModelDef } from './fields.js'
import { connections, type Connection } from './db.js'
import { Table } from './table.js'
import { concrete, pkField, type Field, type Kind } from './fields/index.js'
import { compileAggregate, compileQuery, whereOf, type Out, type Plan } from './sql/compile.js'
import { bin, inList, param, qcol, raw, type Expr, type Select } from './sql/ast.js'
import type { Dialect, Statement } from './sql/dialect.js'
import type { Expression, QNode } from './expressions.js'
import { referencesTo } from './registry.js'
import { exitPending, withPending } from './pending.js'
import { getLogger } from '../log.js'

// ---- error vocabulary ------------------------------------------------------------------------
function wrapErr(def: ModelDef, e: unknown): never {
  if (e instanceof DomainError || e instanceof TxError || e instanceof ReadBackError) throw e
  const c = (e as { cause?: unknown }).cause ?? e
  const code = (c as { code?: string }).code ?? ''
  const msg = String((c as Error).message ?? '')
  // postgres SQLSTATE: 23505 unique, 23503 foreign key, 23502 not null (detail: "Key (name)=(…) already exists.")
  if (code === '23503') throw new DomainError('domain', `${def.name} is still referenced by other records, or points at a record that does not exist`)
  if (code === '23505' || code === '23502') {
    const pg = c as { detail?: string; column?: string }
    const field = (pg.column ?? /Key \("?(\w+)"?\)/.exec(pg.detail ?? '')?.[1])?.replace(/Id$/, '')
    if (code === '23505') throw new DomainError('domain', `${def.name}.${field} must be unique`, field)
    throw new DomainError('invalid_param', `${def.name}.${field} is required`, field)
  }
  // mysql: "Duplicate entry 'x' for key 'vendor.name'" (PRIMARY = the pk), "Column 'name' cannot be null",
  // "Field 'name' doesn't have a default value", "Data too long for column 'title'", "Incorrect integer value: … for column 'count'"
  if (code.startsWith('ER_')) {
    const key = (/for key '(?:[^']*\.)?([^'.]+)'/.exec(msg) ?? /^(?:Column|Field) '([^']+)'/.exec(msg))?.[1]
      ?? /for column (\S+)/.exec(msg)?.[1].split('.').pop()?.replace(/[`']/g, '')   // mariadb: `db`.`table`.`col`
    const field = (key === 'PRIMARY' ? pkField(def)[0] : key)?.replace(/Id$/, '')
    if (code === 'ER_DATA_TOO_LONG' || code.startsWith('ER_TRUNCATED_WRONG_VALUE') || code === 'ER_WARN_DATA_OUT_OF_RANGE') {
      throw new DomainError('invalid_param', field ? `${def.name}.${field} is too long or invalid` : `a ${def.name} value is too long or invalid`, field)
    }
    if (/^ER_(NO_)?(ROW_IS_REFERENCED|REFERENCED_ROW)/.test(code)) throw new DomainError('domain', `${def.name} is still referenced by other records, or points at a record that does not exist`)
    if (code === 'ER_DUP_ENTRY') throw new DomainError('domain', `${def.name}.${field} must be unique`, field)
    if (code === 'ER_BAD_NULL_ERROR' || code === 'ER_NO_DEFAULT_FOR_FIELD') throw new DomainError('invalid_param', `${def.name}.${field} is required`, field)
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    const field = msg.split(':').pop()?.trim().split('.').pop()?.replace(/Id$/, '')
    if (msg.startsWith('FOREIGN KEY')) throw new DomainError('domain', `${def.name} is still referenced by other records, or points at a record that does not exist`)
    if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) throw new DomainError('domain', `${def.name}.${field} must be unique`, field)
    if (code.includes('NOTNULL')) throw new DomainError('invalid_param', `${def.name}.${field} is required`, field)
  }
  throw new Error(`database error on ${def.name}`)
}

// ---- atomic ----------------------------------------------------------------------------------
// sqlite: one serial queue per process: EVERY operation (atomic or not) waits its turn, and whether it sits
// inside a transaction is decided when it runs, never when it was called. Inside atomic() the
// connection is bound in AsyncLocalStorage: operations from the callback skip the queue (they
// already own the connection), nested atomic reuses it. Once the block ends (commit, rollback or
// abort) the binding is closed, so a late query from the callback throws instead of escaping.
// postgres / mysql (pooled): no queue; atomic() holds ONE pool connection for the whole block (tx.conn.driver).
class TxError extends Error {}
class ReadBackError extends Error {}
type Closed = 'committed' | 'rolled back' | 'aborted'
interface Tx { conn: Connection; closed?: Closed; hooks: (() => unknown)[]; open?: () => Promise<unknown> }   // open: lazy block, BEGIN on first query
const bound = new AsyncLocalStorage<Tx>()
let tail: Promise<unknown> = Promise.resolve()

function exec<R>(fn: (c: Connection) => R | Promise<R>): Promise<R> {
  const tx = bound.getStore()
  if (tx) {
    return Promise.resolve(tx.open?.()).then(() => {
      if (tx.closed) throw new TxError(`query after the atomic block was ${tx.closed}`)
      return fn(tx.conn)
    })
  }
  // a pooled driver acquires per statement: plain queries run in parallel, never behind an open atomic()
  let pooled = false
  try { pooled = !!connections.get().driver.pooled } catch { /* reported when the op runs */ }
  if (pooled) return Promise.resolve().then(() => fn(connections.get()))
  const run = tail.then(() => fn(connections.get()))
  tail = run.catch(() => undefined)
  return run
}

// A hook that throws AFTER the commit must not turn a committed atomic() into an error: it is reported here.
let onCommitError: (e: unknown) => void = e => console.error('onCommit hook failed:', e)
export function setOnCommitErrorHandler(fn: (e: unknown) => void): void { onCommitError = fn }

export function atomic<R>(body: () => Promise<R>, opts: { signal?: AbortSignal; lazy?: boolean } = {}): Promise<R> {
  const outer = bound.getStore()
  if (outer) {
    if (outer.closed) return Promise.reject(new TxError(`atomic() after the atomic block was ${outer.closed}`))
    return body()
  }
  const fn = () => withPending(body)   // un-awaited ORM calls finish (or fail the block) before COMMIT
  if (opts.lazy) return lazyAtomic(fn, opts.signal)
  const { signal } = opts
  let tx!: Tx
  const run = exec(conn => {
    if (signal?.aborted) throw signal.reason ?? new TxError('atomic block aborted')
    tx = { conn, hooks: [] }
    let onAbort!: () => void
    // abort = mark dead first (late queries throw), then the race rejects → driver rolls back
    const aborted = new Promise<never>((_, rej) => {
      onAbort = () => { tx.closed ??= 'aborted'; rej(signal!.reason ?? new TxError('atomic block aborted')) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => undefined)
    return conn.driver.transaction(txd => {
      tx.conn = { ...conn, driver: txd }
      return Promise.race([bound.run(tx, fn), aborted])
    }, { signal })
      .then(r => { tx.closed = 'committed'; return r }, e => { tx.closed ??= 'rolled back'; throw e })   // COMMIT resolved = committed, even if an abort landed mid-commit
      .finally(() => signal?.removeEventListener('abort', onAbort))
  })
  // commit hooks run after the outermost COMMIT, outside the block, ALL of them, in registration order
  return run.then(async r => {
    for (const h of tx.hooks) {
      try { await h() } catch (e) { onCommitError(e) }
    }
    return r
  })
}

// lazy: the block runs at once and the transaction opens (in queue order) at its FIRST query, so a block
// that never queries opens nothing (no BEGIN, no db file) and holds no queue while it awaits other I/O.
// Same rules as atomic(): commit on success, rollback on throw/abort (abort marks the block dead), and
// onCommit hooks after the commit. Used by dispatch for per-request atomicity.
function lazyAtomic<R>(fn: () => Promise<R>, signal?: AbortSignal): Promise<R> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new TxError('atomic block aborted'))
  const tx: Tx = { conn: undefined as unknown as Connection, hooks: [] }
  let end!: (failed?: { err: unknown }) => void
  const ended = new Promise<{ err: unknown } | undefined>(r => { end = r })
  let real: Promise<unknown> | undefined   // the driver transaction, once opened
  let opening: Promise<unknown> | undefined
  tx.open = () => tx.closed ? Promise.reject(new TxError(`query after the atomic block was ${tx.closed}`)) : (opening ??= new Promise((resolve, reject) => {
    real = bound.exit(() => exec(conn => conn.driver.transaction(txd => {
      if (tx.closed) throw new TxError(`query after the atomic block was ${tx.closed}`)
      tx.conn = { ...conn, driver: txd }
      resolve(undefined)
      return ended.then(f => { if (f) throw f.err })
    }, { signal })))
    real.catch(reject)
  }))
  let onAbort!: () => void
  const aborted = new Promise<never>((_, rej) => {
    onAbort = () => { tx.closed ??= 'aborted'; rej(signal!.reason ?? new TxError('atomic block aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  const settle = async (): Promise<R> => {
    let r: R
    try { r = await Promise.race([bound.run(tx, fn), aborted]) }
    catch (e) {
      tx.closed ??= 'rolled back'   // no late query may start a transaction now
      end({ err: e })
      if (tx.conn) await real?.catch(() => undefined)   // opened: wait for the ROLLBACK; still queued: it rolls back on its turn
      throw e
    }
    end()
    try { await real } catch (e) { tx.closed = 'rolled back'; throw e }
    tx.closed = 'committed'   // COMMIT resolved = committed, even if an abort landed mid-commit
    for (const h of tx.hooks) {
      try { await h() } catch (e) { onCommitError(e) }
    }
    return r
  }
  return settle().finally(() => signal?.removeEventListener('abort', onAbort))
}

// true inside an open atomic() block (selectForUpdate requires one, like Django)
// fn runs outside any atomic() block (its writes commit on their own, even if the caller's block rolls back)
export const outsideAtomic = <R>(fn: () => R): R => bound.exit(() => exitPending(fn))
export function inAtomic(): boolean { const tx = bound.getStore(); return !!tx && !tx.closed }

// Inside atomic(): run fn after the outermost commit (dropped on rollback). Outside atomic(), or
// late from a block that already committed: run now. Late from a block that rolled back / was
// aborted: throw — the writes it would announce never happened.
export function onCommit(fn: () => unknown): void | Promise<void> {
  const tx = bound.getStore()
  if (tx && !tx.closed) { tx.hooks.push(fn); return }
  if (tx && tx.closed !== 'committed') throw new TxError(`onCommit() after the atomic block was ${tx.closed}`)
  return Promise.resolve(fn()).then(() => undefined)
}

// Django transaction.on_commit for side work: fn runs after the commit (never on rollback), outside the
// transaction, without holding up the response. Its errors go to the tvine.defer logger.
export function defer(fn: () => unknown): void {
  void onCommit(() => {
    setImmediate(() => outsideAtomic(() => withPending(async () => { await fn() }))
      .catch((e: unknown) => getLogger('tvine.defer').error('deferred function failed', { error: (e as Error)?.message ?? String(e) })))
  })
}

// ---- data version ----------------------------------------------------------------------------
// Bumped by every committed write (after the outermost COMMIT; never for a rollback). Snapshot caches key
// on it. On globalThis: a page bundle's copy of warp writes through the same counter.
const VERSION = Symbol.for('tvine.dataVersion')
const gv = globalThis as { [VERSION]?: number }
export const dataVersion = (): number => gv[VERSION] ?? 0
// ponytail: one counter for the whole process and every table, so a write-heavy app rarely hits the snapshot
// cache; per-table versions (pages would declare what they read) if that cost shows up.
const WATCH = Symbol.for('tvine.dataVersionWatchers')
const gw = globalThis as { [WATCH]?: Set<() => void> }
const watchers = (gw[WATCH] ??= new Set())
// called after every bump (a shared snapshot cache publishes it to the other servers); must not throw
export function onDataVersion(fn: () => void): () => void { watchers.add(fn); return () => { watchers.delete(fn) } }
const bump = () => { gv[VERSION] = dataVersion() + 1; for (const w of watchers) { try { w() } catch { /* a watcher's own problem */ } } }
function wrote<R>(r: R): R {
  const tx = bound.getStore()
  if (tx && !tx.closed) { if (!tx.hooks.includes(bump)) tx.hooks.unshift(bump) }   // first: before app hooks read
  else bump()
  return r
}

// ---- hydration (orm-advanced.md) ------------------------------------------------------------------
type AnyField = Field<any, boolean, Kind, boolean>
const NUM = new Set<Kind>(['int', 'float', 'money', 'id', 'fk'])
// pg numeric / int8 and mysql DECIMAL arrive as strings: numbers (an unsafe integer is refused, like int8)
function num(v: unknown, f: AnyField): unknown {
  if (typeof v !== 'string' || !NUM.has(f.kind)) return typeof v === 'bigint' ? Number(v) : v
  const n = Number(v)
  if (f.kind !== 'float' && !Number.isSafeInteger(Math.round(n))) throw new Error(`integer ${v} is outside the safe JS number range`)
  return n
}
function outValue(o: Out, r: Record<string, unknown>, d: Dialect): unknown {
  if (!o.f) return r[o.alias] ?? null
  const cols = o.f.columns(o.alias)
  const sub: Record<string, unknown> = {}
  cols.forEach((c, i) => { sub[c] = i === 0 ? num(r[c], o.f!) : r[c] })
  if (o.round && typeof sub[cols[0]] === 'number') sub[cols[0]] = Math.round(sub[cols[0]] as number)
  if (o.f.kind === 'money' && sub[cols[0]] != null && sub[cols[1]] == null) {
    throw new DomainError('invalid_param', `${o.key} mixes currencies: filter on one currency (<field>__currency) or group by it`, o.key)
  }
  return o.f.fromDb(sub, o.alias, d)
}
export function hydrateWith(plan: Plan, t: Table, r: Record<string, unknown>, d: Dialect): Record<string, unknown> {
  if (plan.mode === 'values') return Object.fromEntries(plan.outs.map(o => [o.key, outValue(o, r, d)]))
  const row = t.hydrate(r, d)
  for (const o of plan.outs) row[o.key] = outValue(o, r, d)
  for (const rp of [...plan.related].sort((a, b) => a.path.length - b.path.length)) {
    let parent: Record<string, unknown> | null = row
    for (const p of rp.path.slice(0, -1)) parent = (parent?.[p] as Record<string, unknown> | null) ?? null
    if (!parent) continue
    const sub = Object.fromEntries(Object.entries(rp.cols).map(([c, a]) => [c, r[a]]))
    parent[rp.path[rp.path.length - 1]] = sub[pkField(rp.def)[0]] == null ? null : Table.of(rp.def).hydrate(sub, d)
  }
  if (!plan.simple && plan.cursor.length) {
    Object.defineProperty(row, CURSOR, { value: plan.cursor.map(c => ('key' in c ? row[c.key] : r[c.alias])), enumerable: false })
  }
  return row
}

// ---- DataSource ------------------------------------------------------------------------------
// The connection is resolved when an operation RUNS (connections.get() inside exec), never at
// definition time: defining or importing a model needs no database.
export function engineSource(def: ModelDef): DataSource<any> {
  const t = Table.of(def)
  const run = <R>(f: (c: Connection) => Promise<R>) => exec(async c => {
    try { return await f(c) } catch (e) { return wrapErr(def, e) }
  })
  return {
    def,
    query: spec => {
      if (spec.forUpdate && !inAtomic()) return Promise.reject(new Error('selectForUpdate() must run inside atomic()'))
      return run(async ({ driver, dialect }) => {
        const { count, page, plan } = compileQuery(spec, def, dialect)
        let total: number | undefined
        if (spec.count !== false || !page) {
          const c = dialect.render(count)
          total = Number(Object.values((await driver.query(c.sql, c.params))[0])[0])
        }
        if (!page) return { items: [], total }
        const p = dialect.render(page)
        return { items: (await driver.query(p.sql, p.params)).map(r => hydrateWith(plan, t, r, dialect)), total }
      })
    },
    get: id => run(async ({ driver, dialect }) => {
      const s = t.get(id, dialect)
      const [r] = await driver.query(s.sql, s.params)
      return r ? t.hydrate(r, dialect) : undefined
    }),
    update: (ws, patch, q) => run(async ({ driver, dialect }) => {
      const s = t.update(ws, patch, dialect, q)
      return s ? wrote((await driver.exec(s.sql, s.params)).changes) : 0
    }),
    delete: (ws, q) => deleteWhere(def, ws, q),
  }
}

// ---- advanced reads ---------------------------------------------------------------------------
export function aggregateRows(def: ModelDef, spec: QuerySpec, aggs: [string, Expression][]): Promise<Record<string, unknown>> {
  return exec(async ({ driver, dialect }) => {
    try {
      const { select, outs } = compileAggregate(spec, def, aggs, dialect)
      const s = dialect.render(select)
      const [r] = await driver.query(s.sql, s.params)
      return Object.fromEntries(outs.map(o => {
        const v = outValue(o, r ?? {}, dialect)
        return [o.key, o.f?.kind === 'int' && (aggs.find(([k]) => k === o.key)?.[1] as { fn?: string }).fn === 'count' ? (v ?? 0) : v]
      }))
    } catch (e) { return wrapErr(def, e) }
  })
}

export function existsRows(def: ModelDef, spec: QuerySpec): Promise<boolean> {
  return exec(async ({ driver, dialect }) => {
    try {
      const { count, page } = compileQuery({ ...spec, limit: 1, cursor: undefined }, def, dialect)
      // a grouped page cannot drop its columns (GROUP BY ordinals): count over it instead
      const sel: Select = page!.groupBy || page!.distinct || page!.distinctOn ? count : { ...page!, cols: [raw('1')], order: undefined }
      const s = dialect.render(sel)
      const rows = await driver.query(s.sql, s.params)
      return sel === count ? Number(Object.values(rows[0])[0]) > 0 : rows.length > 0
    } catch (e) { return wrapErr(def, e) }
  })
}

// ---- bulk writes ------------------------------------------------------------------------------
const MAX_PARAMS = 30_000      // under sqlite's 32 766, pg's / mysql's 65 535 bound params per statement
const MAX_ROWS = 1_000         // the IN cap (queryset.ts MAX_IN)
export const batchOf = (cols: number, want?: number) => Math.max(1, Math.min(want ?? MAX_ROWS, MAX_ROWS, Math.floor(MAX_PARAMS / Math.max(cols, 1))))

// prepared rows (every key present) → multi-row INSERTs; pg / sqlite return the rows (RETURNING *),
// mysql the given rows (it cannot report the auto ids of a multi-row insert — Django parity)
export function insertMany(def: ModelDef, rows: Record<string, unknown>[], batchSize?: number): Promise<Record<string, unknown>[]> {
  if (!rows.length) return Promise.resolve([])
  const t = Table.of(def)
  return atomic(async () => {
    const out: Record<string, unknown>[] = []
    const keys = Object.keys(rows[0]).sort().join()
    for (const r of rows) if (Object.keys(r).sort().join() !== keys) throw new DomainError('invalid_param', `bulkCreate: every ${def.name} row must set the same fields (${keys})`)
    const ncols = t.columnsFor(rows[0]).length
    const size = batchOf(ncols, batchSize)
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size)
      await exec(async ({ driver, dialect }) => {
        try {
          const s = t.insertMany(chunk, dialect)
          if (dialect.insertReturning) out.push(...(await driver.query(s.sql, s.params)).map(r => t.hydrate(r, dialect)))
          else { await driver.exec(s.sql, s.params); out.push(...chunk) }
        } catch (e) { return wrapErr(def, e) }
      })
    }
    return wrote(out)
  })
}

export function bulkUpdate(def: ModelDef, rows: Record<string, unknown>[], fields: string[], batchSize?: number): Promise<number> {
  if (!rows.length || !fields.length) return Promise.resolve(0)
  const t = Table.of(def)
  return atomic(async () => {
    let n = 0
    // params per row: (pk + value) per column of each field (money = 2 columns) + the pk in IN
    const cols = fields.reduce((n, f) => n + (Object.entries(def.fields).find(([k, x]) => k === f || x.key(k) === f)?.[1].columns(f).length ?? 1), 0)
    const size = batchOf(cols * 2 + 1, batchSize)
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size)
      n += await exec(async ({ driver, dialect }) => {
        try {
          const s = t.bulkUpdate(chunk, fields, dialect)
          return (await driver.exec(s.sql, s.params)).changes
        } catch (e) { return wrapErr(def, e) }
      })
    }
    return wrote(n)
  })
}

// after rows were inserted with explicit ids (loaddata): postgres sequences do not move by themselves
// (sqlite AUTOINCREMENT and mysql AUTO_INCREMENT follow the max id)
export function resetSequences(defs: ModelDef[]): Promise<void> {
  return exec(async ({ driver, dialect }) => {
    if (dialect.name !== 'postgres') return
    for (const def of defs) {
      const [pk, f] = pkField(def)
      if (f.kind !== 'id') continue
      const q = dialect.quoteIdent
      await driver.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(${q(pk)}), 1), MAX(${q(pk)}) IS NOT NULL) FROM ${q(def.name)}`, [q(def.name), pk])
    }
  })
}

// ---- delete + ORM-side onDelete -------------------------------------------------------------------
// PROTECT: refuse with a readable error (the DB's RESTRICT backs it). SET_DEFAULT on mysql (InnoDB
// rejects it): set the default first. CASCADE / SET_NULL / RESTRICT / DO_NOTHING: the database does it.
function deleteWhere(def: ModelDef, ws: Where[], q?: QNode[]): Promise<number> {
  const t = Table.of(def)
  const refs = referencesTo(def).filter(r => r.f.opts.onDelete === 'PROTECT' || r.f.opts.onDelete === 'SET_DEFAULT')
  const del = () => exec(async ({ driver, dialect }) => {
    try {
      const s = t.delete(ws, dialect, q)
      return wrote((await driver.exec(s.sql, s.params)).changes)
    } catch (e) { return wrapErr(def, e) }
  })
  if (!refs.length) return del()
  return atomic(async () => {
    for (const r of refs) {
      await exec(async ({ driver, dialect }) => {
        if (r.f.opts.onDelete === 'SET_DEFAULT' && dialect.name !== 'mysql') return
        const pk = pkField(def)[0]
        const doomed: Select = { t: 'select', from: def.name, as: 'd0', cols: [qcol(pk, 'd0')], where: whereOf(def, ws, dialect, undefined, q, 'write') }
        const fkCol = r.f.columns(r.field)[0]
        if (r.f.opts.onDelete === 'PROTECT') {
          const s = dialect.render({ t: 'select', from: r.source.name, cols: [raw('1')], where: { t: 'inSub', e: qcol(fkCol), q: doomed }, limit: 1 })
          if ((await driver.query(s.sql, s.params)).length) {
            throw new DomainError('domain', `cannot delete ${def.name}: still referenced by ${r.source.name}.${r.field} (on delete PROTECT)`, r.field)
          }
          return
        }
        // mysql SET_DEFAULT (a derived table: mysql refuses a subquery on the UPDATE target itself)
        const v = r.f.toDb(r.f.opts.default, dialect)[0]
        const s = dialect.render({ t: 'update', table: r.source.name, set: [[fkCol, param(v)]], where: { t: 'inSub', e: qcol(fkCol), q: { t: 'select', from: { ...doomed, cols: [{ t: 'as', e: qcol(pk, 'd0'), alias: 'v' }] }, as: 'd1', cols: [qcol('v', 'd1')] } } })
        wrote((await driver.exec(s.sql, s.params)).changes)
      })
    }
    return del()
  })
}

// ignoreConflicts (getOrCreate): pg / sqlite ON CONFLICT DO NOTHING → undefined when nothing was inserted;
// mysql: the duplicate error → undefined (a failed statement does not abort a mysql transaction)
export function insertRow(def: ModelDef, data: Record<string, unknown>, opts: { ignoreConflicts?: boolean } = {}): Promise<any> {
  const t = Table.of(def)
  return exec(async ({ driver, dialect }) => wrote(await (async () => {
    try {
      const s = t.insert(data, dialect, opts.ignoreConflicts && dialect.name !== 'mysql')
      if (dialect.insertReturning) {
        const [r] = await driver.query(s.sql, s.params)
        return r ? t.hydrate(r, dialect) : undefined
      }
      // no RETURNING (mysql): read the row back by pk — the given one (uuid) or the auto-increment id
      const { lastId } = await driver.exec(s.sql, s.params)
      const [pk, f] = pkField(def)
      const g = t.get(data[f.key(pk)] ?? lastId, dialect)
      const [row] = await driver.query(g.sql, g.params)
      if (!row) throw new ReadBackError(`${def.name}: the inserted row could not be read back (pk ${String(data[f.key(pk)] ?? lastId)})`)
      return t.hydrate(row, dialect)
    } catch (e) {
      if (opts.ignoreConflicts && (e as { code?: string })?.code === 'ER_DUP_ENTRY') return undefined
      return wrapErr(def, e)
    }
  })()))
}
