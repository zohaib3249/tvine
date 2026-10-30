// makemigrations / migrate. Chose drizzle-kit's PROGRAMMATIC api (generate*Migration over table
// objects), so no schema module or config file is generated. The latest schema snapshot is kept
// in migrations/meta/snapshot.json; applied state lives in the __tvine_migrations table.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { tableFor } from './engine.js'
import { openConn } from './db.js'
import { modelRegistry } from './model.js'
import type { Model } from './model.js'

const SNAP = 'meta/snapshot.json'
const BREAK = '--> statement-breakpoint'

// Import apps/*/models.(ts|js) and return every Model they export.
export async function discoverModels(appsDir: string): Promise<Model<any, any>[]> {
  const out: Model<any, any>[] = []
  for (const app of readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const file = ['models.ts', 'models.js'].map(f => join(appsDir, app, f)).find(existsSync)
    if (!file) continue
    const mod = await import(pathToFileURL(file).href)
    for (const v of Object.values(mod)) {
      if (v && typeof v === 'object' && 'fields' in v && 'objects' in v && 'name' in v) out.push(v as Model<any, any>)
    }
  }
  return out
}

async function snapshotOf(models: Model<any, any>[]) {
  const tables = Object.fromEntries(models.map(m => [m.name, tableFor(m)]))
  return generateSQLiteDrizzleJson(tables)
}

async function diff(models: Model<any, any>[], outDir: string) {
  const cur = await snapshotOf(models)
  const snapFile = join(outDir, SNAP)
  const prev = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : await snapshotOf([])
  return { cur, statements: await generateSQLiteMigration(prev, cur) }
}

const files = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort() : []

export async function makeMigrations(appsDir: string, outDir: string, name?: string): Promise<{ file?: string; message: string }> {
  const models = await discoverModels(appsDir)
  const { cur, statements } = await diff(models, outDir)
  if (!statements.length) return { message: 'no changes detected' }
  const existing = files(outDir)
  const n = String(existing.length + 1).padStart(4, '0')
  const file = `${n}_${name ?? (existing.length ? 'auto' : 'init')}.sql`
  mkdirSync(join(outDir, 'meta'), { recursive: true })
  writeFileSync(join(outDir, file), statements.join(`\n${BREAK}\n`) + '\n')
  writeFileSync(join(outDir, SNAP), JSON.stringify(cur, null, 2))
  return { file, message: `created ${file}` }
}

const JOURNAL = '__tvine_migrations'

export async function migrate(dbUrl: string, migrationsDir: string): Promise<{ applied: string[] }> {
  const { sqlite } = openConn(dbUrl)
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${JOURNAL} (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
    const done = new Map((sqlite.prepare(`SELECT name, hash FROM ${JOURNAL}`).all() as { name: string; hash: string }[]).map(r => [r.name, r.hash]))
    const applied: string[] = []
    for (const f of files(migrationsDir)) {
      const body = readFileSync(join(migrationsDir, f), 'utf8')
      const hash = createHash('sha256').update(body).digest('hex')
      if (done.has(f)) {
        if (done.get(f) !== hash) throw new Error(`migration ${f} was edited after it was applied`)
        continue
      }
      sqlite.transaction(() => {
        for (const s of body.split(BREAK)) if (s.trim()) sqlite.exec(s)
        sqlite.prepare(`INSERT INTO ${JOURNAL} VALUES (?, ?, ?)`).run(f, hash, Date.now())
      })()
      applied.push(f)
    }
    return { applied }
  } finally { sqlite.close() }
}

// true = clean. false = migrations pending, or registered models differ from the last migration.
export async function migrateCheck(dbUrl: string, migrationsDir: string): Promise<boolean> {
  const { sqlite } = openConn(dbUrl)
  try {
    const has = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(JOURNAL)
    const done = new Set(has ? (sqlite.prepare(`SELECT name FROM ${JOURNAL}`).all() as { name: string }[]).map(r => r.name) : [])
    if (files(migrationsDir).some(f => !done.has(f))) return false
  } finally { sqlite.close() }
  const models = modelRegistry()
  return !models.length || !(await diff(models, migrationsDir)).statements.length
}
