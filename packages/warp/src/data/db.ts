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
  if (server(url, ['postgres', 'postgresql'])) return { alias, dialect: pgDialect, driver: pgDriver(url.trim(), pool) }
  if (server(url, ['mysql', 'mariadb'])) return { alias, dialect: mysqlDialect, driver: mysqlDriver(url.trim(), pool) }
  const driver = sqliteDriver(sqlitePath(url))
  return { alias, dialect: sqliteDialect, driver, sqlite: driver.db }
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
export const connections = new ConnectionHandler()

// Older entry points, kept: configureDb(url) / closeDb() / getConn().
export function configureDb(url?: string): void {
  connections.configure({ db: { url: resolveDbUrl(url) } })
}
export const getConn = (): Connection => connections.get()
export function closeDb(): void { void connections.closeAll() }
