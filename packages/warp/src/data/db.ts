// Connections, Django-style: models never hold one; queries call connections.get() when they RUN.
// configure() registers an alias without opening anything; get() opens lazily.
// sqlite only for now (postgres lands with the pool work): WAL + busy_timeout, one connection per alias.
import type Database from 'better-sqlite3'
import { sqliteDriver, type Driver } from './driver.js'
import { sqlite as sqliteDialect } from './sql/dialects/sqlite.js'
import type { Dialect } from './sql/dialect.js'

// ponytail: `sqlite` raw handle is on every Connection because sqlite is the only engine; it moves
// behind a dialect check when pg/mysql land (migrate.ts and one test still use it).
export interface Connection { alias: string; dialect: Dialect; driver: Driver; sqlite: Database.Database }

export function sqlitePath(url: string): string {
  if (/^postgres(ql)?:/.test(url)) throw new Error('postgres is not available yet; use a file: url')
  if (url === ':memory:' || url === 'file::memory:') return ':memory:'
  return url.startsWith('file:') ? url.slice(5) : url
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
      const url = this.urls.get(alias) ?? (alias === 'default' ? process.env.DATABASE_URL ?? 'file:./tvine.db' : undefined)
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
  connections.configure({ db: { url: url ?? process.env.DATABASE_URL ?? 'file:./tvine.db' } })
}
export const getConn = (): Connection => connections.get()
export function closeDb(): void { void connections.closeAll() }
