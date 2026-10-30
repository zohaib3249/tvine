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
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    const field = msg.split(':').pop()?.trim().split('.').pop()?.replace(/Id$/, '')
    if (msg.startsWith('FOREIGN KEY')) throw new DomainError('domain', `${def.name} is still referenced by other records, or points at a record that does not exist`)
    if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) throw new DomainError('domain', `${def.name}.${field} must be unique`, field)
    if (code.includes('NOTNULL')) throw new DomainError('invalid_param', `${def.name}.${field} is required`, field)
  }
  throw new Error(`database error on ${def.name}`)
}

// ---- atomic ----------------------------------------------------------------------------------
// One serial queue per process: EVERY operation (atomic or not) waits its turn, and whether it sits
// inside a transaction is decided when it runs, never when it was called. Inside atomic() the
// connection is bound in AsyncLocalStorage: operations from the callback skip the queue (they
// already own the connection), nested atomic reuses it. Once the block ends (commit, rollback or
// abort) the binding is closed, so a late query from the callback throws instead of escaping.
class TxError extends Error {}
interface Tx { conn: Connection; closed?: string; hooks: (() => unknown)[] }
const bound = new AsyncLocalStorage<Tx>()
let tail: Promise<unknown> = Promise.resolve()

function exec<R>(fn: (c: Connection) => R | Promise<R>): Promise<R> {
  const tx = bound.getStore()
  if (tx) {
    return Promise.resolve().then(() => {
      if (tx.closed) throw new TxError(`query after the atomic block ${tx.closed}`)
      return fn(tx.conn)
    })
  }
  const run = tail.then(() => fn(connections.get()))
  tail = run.catch(() => undefined)
  return run
}

export function atomic<R>(fn: () => Promise<R>, opts: { signal?: AbortSignal } = {}): Promise<R> {
  const outer = bound.getStore()
  if (outer) {
    if (outer.closed) return Promise.reject(new TxError(`atomic() after the atomic block ${outer.closed}`))
    return fn()
  }
  const { signal } = opts
  let tx!: Tx
  const run = exec(conn => {
    if (signal?.aborted) throw signal.reason ?? new TxError('atomic block aborted')
    tx = { conn, hooks: [] }
    let onAbort!: () => void
    // abort = mark dead first (late queries throw), then the race rejects → driver rolls back
    const aborted = new Promise<never>((_, rej) => {
      onAbort = () => { tx.closed = 'was aborted'; rej(signal!.reason ?? new TxError('atomic block aborted')) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => undefined)
    return conn.driver.transaction(() => Promise.race([bound.run(tx, fn), aborted]))
      .finally(() => { signal?.removeEventListener('abort', onAbort); tx.closed ??= 'has finished' })
  })
  // commit hooks run after the outermost COMMIT, outside the block, in registration order
  return run.then(async r => {
    for (const h of tx.hooks) await h()
    return r
  })
}

// Run fn after the outermost atomic() commits; dropped on rollback; immediately outside atomic().
export function onCommit(fn: () => unknown): void | Promise<void> {
  const tx = bound.getStore()
  if (tx && !tx.closed) { tx.hooks.push(fn); return }
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
