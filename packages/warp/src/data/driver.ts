// Driver = the database's wire library behind one small async interface. The only external DB code.
import Database from 'better-sqlite3'

export type DbRow = Record<string, unknown>

export interface Driver {
  query(sql: string, params: unknown[]): Promise<DbRow[]>
  exec(sql: string, params: unknown[]): Promise<{ changes: number; lastId?: number | bigint }>
  transaction<T>(fn: () => Promise<T>): Promise<T>
  close(): void
}

// better-sqlite3 is synchronous; the engine's serial queue keeps ops (and transactions) in order.
export function sqliteDriver(path: string): Driver & { db: Database.Database } {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  // sqlite lower() is ASCII-only; contains/search need full Unicode case folding
  db.function('tv_lower', { deterministic: true }, (s: unknown) => (s == null ? null : String(s).toLowerCase()))
  return {
    db,
    query: async (sql, params) => db.prepare(sql).all(...params) as DbRow[],
    exec: async (sql, params) => {
      const r = db.prepare(sql).run(...params)
      return { changes: r.changes, lastId: r.lastInsertRowid }
    },
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const r = await fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    close: () => db.close(),
  }
}
