// Lazy connection. sqlite only (postgres lands with the pool work); one process-wide connection,
// WAL + busy_timeout so concurrent readers and the write queue behave.
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

// `orm` is deliberately untyped: the engine type never appears in an exported signature.
export interface Conn { sqlite: Database.Database; orm: any }

let configured: string | undefined
let conn: Conn | undefined

export const dbUrl = () => configured ?? process.env.DATABASE_URL ?? 'file:./tvine.db'

export function configureDb(url?: string): void {
  closeDb()
  configured = url
}

export function sqlitePath(url: string): string {
  if (/^postgres(ql)?:/.test(url)) throw new Error('postgres is not available yet; use a file: url')
  if (url === ':memory:' || url === 'file::memory:') return ':memory:'
  return url.startsWith('file:') ? url.slice(5) : url
}

export function openConn(url: string): Conn {
  const sqlite = new Database(sqlitePath(url))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  return { sqlite, orm: drizzle(sqlite) }
}

export function getConn(): Conn {
  return (conn ??= openConn(dbUrl()))
}

export function closeDb(): void {
  conn?.sqlite.close()
  conn = undefined
}
