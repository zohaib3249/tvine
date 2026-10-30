// Connections, Django-style: models never hold one; queries call connections.get() when they RUN.
// configure() registers an alias without opening anything; get() opens lazily.
// sqlite only for now (postgres lands with the pool work): WAL + busy_timeout, one connection per alias.
import type Database from 'better-sqlite3'
import { sqliteDriver, type Driver } from './driver.js'
import { sqlite as sqliteDialect } from './sql/dialects/sqlite.js'
import type { Dialect } from './sql/dialect.js'
import { resolveDbUrl } from '../settings.js'

// ponytail: `sqlite` raw handle is on every Connection because sqlite is the only engine; it moves
// behind a dialect check when pg/mysql land (migrate.ts and one test still use it).
export interface Connection { alias: string; dialect: Dialect; driver: Driver; sqlite: Database.Database }

export function sqlitePath(raw: string): string {
  const url = raw.trim()
  if (!url) throw new Error('database url is empty')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme === 'postgres' || scheme === 'postgresql') throw new Error('postgres support lands in Task 20; use a file: url')
  if (scheme === 'mysql' || scheme === 'mariadb') throw new Error(`${scheme} support is not available; use a file: url`)
  if (url === ':memory:' || url === 'file::memory:') return ':memory:'
  if (scheme === 'file') return url.slice(5)
  // dev convenience: bare path (no scheme://) ending in .db/.sqlite/.sqlite3
  if (/\.(db|sqlite3?)$/i.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  // only the scheme is echoed, never user:pass
  throw new Error(`unsupported database url '${scheme ?? 'no scheme'}' — use file:./name.db for sqlite`)
}

export function openConn(url: string, alias = 'default'): Connection {
  const driver = sqliteDriver(sqlitePath(url))
  return { alias, dialect: sqliteDialect, driver, sqlite: driver.db }
}

class ConnectionHandler {
  private urls = new Map<string, string>()
  private open = new Map<string, Connection>()

  configure(settings: { db: { url: string } }): void {
    this.closeAll()
    this.urls.set('default', settings.db.url)
  }

  get(alias = 'default'): Connection {
    let c = this.open.get(alias)
    if (!c) {
      const url = this.urls.get(alias) ?? (alias === 'default' ? resolveDbUrl() : undefined)
      if (!url) throw new Error(`database "${alias}" is not configured`)
      this.open.set(alias, (c = openConn(url, alias)))
    }
    return c
  }

  async closeAll(): Promise<void> {
    for (const c of this.open.values()) c.driver.close()
    this.open.clear()
  }
}
export const connections = new ConnectionHandler()

// Older entry points, kept: configureDb(url) / closeDb() / getConn().
export function configureDb(url?: string): void {
  connections.configure({ db: { url: resolveDbUrl(url) } })
}
export const getConn = (): Connection => connections.get()
export function closeDb(): void { void connections.closeAll() }
