// Connections, Django-style: models never hold one; queries call connections.get() when they RUN.
// configure() registers an alias without opening anything; get() builds the driver lazily (and the
// pg / mysql pool connects on its first query). sqlite: WAL + busy_timeout, one connection per alias;
// postgres / mysql: a pool sized from settings.db.pool.
import type Database from 'better-sqlite3'
import { mysqlDriver, pgDriver, sqliteDriver, type Driver, type PoolOpts, type PoolStats } from './driver.js'
import { sqlite as sqliteDialect } from './sql/dialects/sqlite.js'
import { postgres as pgDialect } from './sql/dialects/postgres.js'
import { mysql as mysqlDialect } from './sql/dialects/mysql.js'
import type { Dialect } from './sql/dialect.js'
import { resolveDbUrl } from '../settings.js'
import { metrics, since } from '../core/metrics.js'

// `sqlite` is the raw handle, present only on sqlite connections (tests and the sqlite runner use it)
export interface Connection { alias: string; dialect: Dialect; driver: Driver; sqlite?: Database.Database }

const DEFAULT_POOL: PoolOpts = { max: 10, acquireMs: 5_000, idleMs: 30_000 }
const schemeOf = (url: string) => /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
const server = (url: string, schemes: string[]) => schemes.includes(schemeOf(url.trim()) ?? '') && /^[a-z]+:\/\//i.test(url.trim())

export function sqlitePath(raw: string): string {
  const url = raw.trim()
  if (!url) throw new Error('database url is empty')
  const scheme = schemeOf(url)
  const hasAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  if (scheme === 'postgres' || scheme === 'postgresql') throw new Error(`a ${scheme}:// url is not a sqlite path (it opens the postgres driver)`)
  if (scheme === 'mysql' || scheme === 'mariadb') throw new Error(`a ${scheme}:// url is not a sqlite path (it opens the mysql driver)`)
  if (url === ':memory:' || url === 'file::memory:') return ':memory:'
  if (scheme === 'file') return url.slice(5)
  // dev convenience: bare path (no scheme://) ending in .db/.sqlite/.sqlite3
  if (/\.(db|sqlite3?)$/i.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  // only the scheme is echoed, never user:pass
  throw new Error(`unsupported database url ${hasAuthority ? `'${scheme}'` : '(no scheme)'} — use file:./name.db for sqlite, postgres:// or mysql://`)
}

export function openConn(url: string, alias = 'default', pool: PoolOpts = DEFAULT_POOL): Connection {
  if (server(url, ['postgres', 'postgresql'])) return { alias, dialect: pgDialect, driver: timed(pgDriver(url.trim(), pool), alias) }
  if (server(url, ['mysql', 'mariadb'])) return { alias, dialect: mysqlDialect, driver: timed(mysqlDriver(url.trim(), pool), alias) }
  const driver = timed(sqliteDriver(sqlitePath(url)), alias)
  return { alias, dialect: sqliteDialect, driver, sqlite: driver.db }
}

// metrics (BACKLOG #9): statement count + duration per alias, inside transactions / sessions too. In place, so a
// driver's extras (sqlite db handle, pool stats) stay; a tx driver that IS this one is already timed.
function timed<D extends Driver>(d: D, alias: string): D {
  const { query, exec, transaction, session } = d
  const time = <T>(op: string, p: Promise<T>) => {
    if (!metrics.enabled) return p
    const t0 = performance.now()
    return p.finally(() => metrics.observe('tvine_db_query_duration_seconds', { db: alias, op }, since(t0)))
  }
  d.query = (sql, params) => time('query', query.call(d, sql, params))
  d.exec = (sql, params) => time('exec', exec.call(d, sql, params))
  d.transaction = <T>(fn: (tx: Driver) => Promise<T>, opts?: { signal?: AbortSignal }) => transaction.call(d, (tx) => fn(tx === d ? tx : timed(tx, alias)), opts) as Promise<T>
  if (session) d.session = <T>(fn: (x: Driver) => Promise<T>) => session.call(d, (x) => fn(x === d ? x : timed(x, alias))) as Promise<T>
  return d
}

class ConnectionHandler {
  private dbs = new Map<string, { url: string; pool?: PoolOpts }>()
  private open = new Map<string, Connection>()

  configure(settings: { db: { url: string; pool?: PoolOpts } }): void {
    void this.closeAll()
    this.dbs.set('default', settings.db)
  }

  get(alias = 'default'): Connection {
    let c = this.open.get(alias)
    if (!c) {
      const db = this.dbs.get(alias) ?? (alias === 'default' ? { url: resolveDbUrl() } : undefined)
      if (!db?.url) throw new Error(`database "${alias}" is not configured`)
      this.open.set(alias, (c = openConn(db.url, alias, db.pool)))
    }
    return c
  }

  // pool stats for /tvine/health (undefined: not opened yet, or sqlite — no pool)
  stats(alias = 'default'): PoolStats | undefined {
    return this.open.get(alias)?.driver.stats?.()
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()]
    this.open.clear()
    await Promise.all(all.map(c => c.driver.close()))
  }
}
// One per process, on globalThis: a page bundle's copy of warp must use the server's configured pool.
const CONNECTIONS = Symbol.for('tvine.connections')
export const connections: ConnectionHandler = ((globalThis as { [CONNECTIONS]?: ConnectionHandler })[CONNECTIONS] ??= new ConnectionHandler())

// Older entry points, kept: configureDb(url) / closeDb() / getConn().
export function configureDb(url?: string): void {
  connections.configure({ db: { url: resolveDbUrl(url) } })
}
export const getConn = (): Connection => connections.get()
export function closeDb(): void { void connections.closeAll() }
