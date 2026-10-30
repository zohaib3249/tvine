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
  session?<T>(fn: (d: Driver) => Promise<T>): Promise<T>   // pooled: one connection for all of fn (session-level locks)
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

// ---- mysql / mariadb -------------------------------------------------------------------------
// mysql2/promise pool: acquire → run → release per statement; waiters are served FIFO by the pool,
// acquireMs is enforced here (mysql2 has no acquire timeout). Every new connection gets a pinned
// session first: strict sql_mode WITHOUT NO_BACKSLASH_ESCAPES / ANSI_QUOTES (the dialect's literals
// rely on it), UTC, utf8mb4_bin, READ COMMITTED (as postgres / Django). Statements with params use server-side prepared statements
// (execute); dates and JSON travel as strings (the datetime / json fields own the format).
// `mysql2` is an optional peer dependency, imported on the first query.
type MyPool = import('mysql2/promise').Pool
type MyConn = import('mysql2/promise').PoolConnection
const SESSION = [
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'",
  'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
]
const LONGLONG = 8

// url + pool settings → mysql2 pool options. A bad url never echoes itself (it holds the password).
// Query params: ssl=true|false, sslmode=disable|require|verify-ca|verify-full (require = encrypt without
// verifying the certificate, like libpq); anything else is refused, never silently dropped.
export function mysqlOptions(url: string, opts: PoolOpts) {
  let u: URL
  try { u = new URL(url) } catch { throw new Error('invalid mysql url (expected mysql://user:pass@host:port/db)') }
  const dec = (s: string) => (s ? decodeURIComponent(s) : undefined)
  let ssl: { rejectUnauthorized: boolean } | undefined
  for (const [k, v] of u.searchParams) {
    const bad = () => new Error(`unsupported mysql url value for ${k} (ssl: true / false; sslmode: disable / require / verify-ca / verify-full)`)
    if (k === 'ssl') {
      if (!['true', '1', 'false', '0'].includes(v)) throw bad()
      ssl = v === 'true' || v === '1' ? { rejectUnauthorized: true } : undefined
    } else if (k === 'sslmode') {
      if (v === 'disable') ssl = undefined
      else if (v === 'require') ssl = { rejectUnauthorized: false }
      else if (v === 'verify-ca' || v === 'verify-full') ssl = { rejectUnauthorized: true }
      else throw bad()
    } else throw new Error(`unsupported mysql url parameter ${JSON.stringify(k)} (supported: ssl, sslmode)`)
  }
  return {
    host: u.hostname || 'localhost', port: u.port ? Number(u.port) : 3306, user: dec(u.username), password: dec(u.password), database: dec(u.pathname.slice(1)),
    ...(ssl ? { ssl } : {}),
    connectionLimit: opts.max, maxIdle: opts.max, idleTimeout: opts.idleMs, connectTimeout: opts.acquireMs,
    waitForConnections: true, queueLimit: 0, charset: 'utf8mb4_bin', dateStrings: true, jsonStrings: true, supportBigNumbers: true,
    maxPreparedStatements: 256,                           // per connection (LRU); mysql2's default 16000 can hit max_prepared_stmt_count
  }
}

async function myRun(c: MyConn, sql: string, params: unknown[]) {
  const [rows, fields] = params.length ? await c.execute(sql, params as never[]) : await c.query(sql)
  if (Array.isArray(rows) && Array.isArray(fields)) {
    // bigint columns: numbers when safe (supportBigNumbers), else a string — refused like pg's int8
    const big = (fields as { name: string; columnType: number }[]).filter(f => f.columnType === LONGLONG).map(f => f.name)
    for (const r of rows as DbRow[]) for (const k of big) if (typeof r[k] === 'string') int8(r[k] as string)
    return { rows: rows as DbRow[], changes: 0 }
  }
  const h = rows as { affectedRows: number; insertId: number }
  return { rows: [] as DbRow[], changes: h.affectedRows, lastId: h.insertId || undefined }
}

const onMyConn = (c: MyConn): Driver => ({
  query: async (sql, params) => (await myRun(c, sql, params)).rows,
  exec: async (sql, params) => { const r = await myRun(c, sql, params); return { changes: r.changes, lastId: r.lastId } },
  transaction: fn => fn(onMyConn(c)),                     // already inside one
  close: () => undefined,
})

export function mysqlDriver(url: string, opts: PoolOpts): Driver & { stats(): PoolStats } {
  let pool: Promise<MyPool> | undefined
  let ready: MyPool | undefined
  let waiting = 0
  const pinned = new WeakSet<object>()
  const getPool = () => (pool ??= (async () => {
    const cfg = mysqlOptions(url, opts)
    let my: typeof import('mysql2/promise')
    try { my = await import('mysql2/promise') } catch { throw new Error('install mysql2 to use mysql:// or mariadb:// urls (npm i mysql2)') }
    return (ready = ((my as { default?: typeof my }).default ?? my).createPool(cfg))
  })())
  const acquire = async (): Promise<MyConn> => {
    const p = await getPool()
    waiting++
    let timer: NodeJS.Timeout | undefined
    const got = p.getConnection()
    let c: MyConn
    try {
      c = await Promise.race([got, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new DomainError('internal', 'db busy — retry')), opts.acquireMs) })])
    } catch (e) {
      if (e instanceof DomainError) got.then((x: MyConn) => x.release(), () => undefined)   // its turn comes later: hand it straight back
      throw e
    } finally { waiting--; clearTimeout(timer) }
    if (!pinned.has(c.connection)) {
      try { for (const s of SESSION) await c.query(s) } catch (e) { c.destroy(); throw e }
      pinned.add(c.connection)
    }
    return c
  }
  // a connection that failed fatally (killed, network) is destroyed, never handed out again
  const done = (c: MyConn, e?: unknown) => ((e as { fatal?: boolean })?.fatal ? c.destroy() : c.release())
  const one = async <R>(f: (c: MyConn) => Promise<R>) => {
    const c = await acquire()
    try { const r = await f(c); done(c); return r } catch (e) { done(c, e); throw e }
  }
  return {
    pooled: true,
    query: (sql, params) => one(async c => (await myRun(c, sql, params)).rows),
    exec: (sql, params) => one(async c => { const r = await myRun(c, sql, params); return { changes: r.changes, lastId: r.lastId } }),
    async transaction(fn, { signal } = {}) {
      const c = await acquire()
      try {
        await c.query('START TRANSACTION')
        const r = await fn(onMyConn(c))
        await c.query('COMMIT')
        c.release()
        return r
      } catch (e) {
        if (signal?.aborted) c.destroy()                  // a statement may still be running: the server rolls back on disconnect
        else await c.query('ROLLBACK').then(() => c.release(), () => c.destroy())
        throw e
      }
    },
    session: fn => one(c => fn(onMyConn(c))),
    // ponytail: size / idle read mysql2's pool internals (no public stats); revisit on a mysql2 major
    stats: () => {
      const p = (ready as unknown as { pool?: { _allConnections: { length: number }; _freeConnections: { length: number } } })?.pool
      return p ? { size: p._allConnections.length, idle: p._freeConnections.length, waiting } : { size: 0, idle: 0, waiting: 0 }
    },
    close: async () => { if (pool) await (await pool.catch(() => undefined))?.end() },
  }
}
