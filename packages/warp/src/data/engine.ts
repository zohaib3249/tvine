// The SQL engine: Table statements → driver, atomic(), onCommit(). Internal: nothing here leaks an
// engine type or name to devs; errors are rewritten to model/field vocabulary.
import { AsyncLocalStorage } from 'node:async_hooks'
import { DomainError } from '../core/errors.js'
import type { DataSource } from './queryset.js'
import type { ModelDef } from './fields.js'
import { connections, type Connection } from './db.js'
import { Table } from './table.js'

// ---- error vocabulary ------------------------------------------------------------------------
function wrapErr(def: ModelDef, e: unknown): never {
  if (e instanceof DomainError || e instanceof TxError) throw e
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
// postgres (pooled): no queue; atomic() holds ONE pool client for the whole block (tx.conn.driver).
class TxError extends Error {}
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

export function atomic<R>(fn: () => Promise<R>, opts: { signal?: AbortSignal; lazy?: boolean } = {}): Promise<R> {
  const outer = bound.getStore()
  if (outer) {
    if (outer.closed) return Promise.reject(new TxError(`atomic() after the atomic block was ${outer.closed}`))
    return fn()
  }
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

// Inside atomic(): run fn after the outermost commit (dropped on rollback). Outside atomic(), or
// late from a block that already committed: run now. Late from a block that rolled back / was
// aborted: throw — the writes it would announce never happened.
export function onCommit(fn: () => unknown): void | Promise<void> {
  const tx = bound.getStore()
  if (tx && !tx.closed) { tx.hooks.push(fn); return }
  if (tx && tx.closed !== 'committed') throw new TxError(`onCommit() after the atomic block was ${tx.closed}`)
  return Promise.resolve(fn()).then(() => undefined)
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
    query: spec => run(async ({ driver, dialect }) => {
      const { count, page } = t.query(spec, dialect)
      const total = Number(Object.values((await driver.query(count.sql, count.params))[0])[0])
      if (!page) return { items: [], total }
      return { items: (await driver.query(page.sql, page.params)).map(r => t.hydrate(r, dialect)), total }
    }),
    get: id => run(async ({ driver, dialect }) => {
      const s = t.get(id, dialect)
      const [r] = await driver.query(s.sql, s.params)
      return r ? t.hydrate(r, dialect) : undefined
    }),
    update: (ws, patch) => run(async ({ driver, dialect }) => {
      const s = t.update(ws, patch, dialect)
      return s ? (await driver.exec(s.sql, s.params)).changes : 0
    }),
    delete: ws => run(async ({ driver, dialect }) => {
      const s = t.delete(ws, dialect)
      return (await driver.exec(s.sql, s.params)).changes
    }),
  }
}

export function insertRow(def: ModelDef, data: Record<string, unknown>): Promise<any> {
  const t = Table.of(def)
  return exec(async ({ driver, dialect }) => {
    try {
      const s = t.insert(data, dialect)
      return t.hydrate((await driver.query(s.sql, s.params))[0], dialect)
    } catch (e) { return wrapErr(def, e) }
  })
}
