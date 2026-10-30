// Driver = the database's wire library behind one small async interface. The only external DB code.
import Database from 'better-sqlite3'
import type { Pool, PoolClient } from 'pg'
import { DomainError } from '../core/errors.js'

export type DbRow = Record<string, unknown>
export interface PoolStats { size: number; idle: number; waiting: number }
export interface PoolOpts { max: number; acquireMs: number; idleMs: number }

export interface Driver {
  query(sql: string, params: unknown[]): Promise<DbRow[]>
  exec(sql: string, params: unknown[]): Promise<{ changes: number; lastId?: number | bigint }>
  // fn gets the driver bound to the transaction (pooled: the ONE client holding it). signal aborted
  // at failure time = a statement may still be running on it: the driver drops the connection.
  transaction<T>(fn: (tx: Driver) => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>
  close(): void | Promise<void>
  pooled?: boolean                 // per-statement acquire: the engine does not serialize plain queries
  stats?(): PoolStats
}

// better-sqlite3 is synchronous; the engine's serial queue keeps ops (and transactions) in order.
export function sqliteDriver(path: string): Driver & { db: Database.Database } {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // sqlite lower() is ASCII-only; contains/search need full Unicode case folding
  db.function('tv_lower', { deterministic: true }, (s: unknown) => (s == null ? null : String(s).toLowerCase()))
  const d: Driver & { db: Database.Database } = {
    db,
    query: async (sql, params) => db.prepare(sql).all(...params) as DbRow[],
    exec: async (sql, params) => {
      const r = db.prepare(sql).run(...params)
      return { changes: r.changes, lastId: r.lastInsertRowid }
    },
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const r = await fn(d)
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    close: () => { db.close() },
  }
  return d
}

// ---- postgres --------------------------------------------------------------------------------
// pg.Pool IS the FIFO pool contract (models-db.md): acquire → run → release per statement, waiters
// served in order, connectionTimeoutMillis = acquireMs, idle eviction. `pg` is an optional peer
// dependency, imported on the first query (configuring or defining models opens nothing).
const busy = (e: unknown) =>
  /timeout exceeded when trying to connect/i.test(String((e as Error)?.message)) ? new DomainError('internal', 'db busy — retry') : e

// int8 (bigint / bigserial / count) arrives as text; ids, ints and cents are JS numbers
function int8(v: string): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`integer ${v} is outside the safe JS number range`)
  return n
}

const onClient = (c: PoolClient): Driver => ({
  query: async (sql, params) => (await c.query(sql, params)).rows,
  exec: async (sql, params) => ({ changes: (await c.query(sql, params)).rowCount ?? 0 }),
  transaction: fn => fn(onClient(c)),                     // already inside one
  close: () => undefined,
})

export function pgDriver(url: string, opts: PoolOpts): Driver & { stats(): PoolStats } {
  let pool: Promise<Pool> | undefined
  let ready: Pool | undefined
  const getPool = () => (pool ??= (async () => {
    let pg: typeof import('pg').default
    try { pg = (await import('pg')).default } catch { throw new Error('install pg to use postgres:// urls (npm i pg)') }
    const p = new pg.Pool({
      connectionString: url, max: opts.max, connectionTimeoutMillis: opts.acquireMs, idleTimeoutMillis: opts.idleMs,
      types: { getTypeParser: ((oid: number, fmt?: 'text' | 'binary') => (oid === 20 ? int8 : pg.types.getTypeParser(oid, fmt as 'text'))) as typeof pg.types.getTypeParser },
    })
    p.on('error', () => undefined)                       // an idle client died; the pool already dropped it
    return (ready = p)
  })())
  const acquire = async () => {
    const p = await getPool()
    try { return await p.connect() } catch (e) { throw busy(e) }
  }
  const one = async <R>(f: (c: PoolClient) => Promise<R>) => {
    const c = await acquire()
    try { return await f(c) } finally { c.release() }
  }
  return {
    pooled: true,
    query: (sql, params) => one(async c => (await c.query(sql, params)).rows),
    exec: (sql, params) => one(async c => ({ changes: (await c.query(sql, params)).rowCount ?? 0 })),
    async transaction(fn, { signal } = {}) {
      const c = await acquire()
      try {
        await c.query('BEGIN')
        const r = await fn(onClient(c))
        await c.query('COMMIT')
        c.release()
        return r
      } catch (e) {
        if (signal?.aborted) c.release(true)               // destroy: the server rolls the transaction back
        else await c.query('ROLLBACK').then(() => c.release(), err => c.release(err))
        throw e
      }
    },
    stats: () => (ready ? { size: ready.totalCount, idle: ready.idleCount, waiting: ready.waitingCount } : { size: 0, idle: 0, waiting: 0 }),
    close: async () => { if (pool) await (await pool.catch(() => undefined))?.end() },
  }
}
