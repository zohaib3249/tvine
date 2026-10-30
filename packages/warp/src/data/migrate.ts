// makemigrations / migrate. Chose drizzle-kit's PROGRAMMATIC api (generate*Migration over table
// objects), so no schema module or config file is generated. The latest schema snapshot is kept
// in migrations/meta/snapshot.json; applied state lives in the __tvine_migrations table.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
// TODO(6e): removed with drizzle-kit — the only drizzle-orm import left in src (migration generation only)
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { keyOf, pkField, type ModelDef } from './fields.js'
import { openConn } from './db.js'
import type { Model } from './model.js'

// TODO(6e): removed with drizzle-kit. Builds drizzle-kit's input (a drizzle table object) from our
// fields, ONLY to feed generateSQLite*; the query path never sees it.
const drizzleTables = new WeakMap<object, any>()
function drizzleTable(def: ModelDef): any {
  let t = drizzleTables.get(def.fields)
  if (t) return t
  const cols: Record<string, any> = {}
  const idx: [string, string][] = []
  for (const [name, f] of Object.entries(def.fields)) {
    const o = f.opts
    const fin = (c: any) => {
      if (!o.optional && f.kind !== 'id') c = c.notNull()
      if (o.unique) c = c.unique()
      if (o.default !== undefined && f.kind !== 'money') c = c.default(o.default)
      return c
    }
    switch (f.kind) {
      case 'id': cols[name] = integer(name).primaryKey({ autoIncrement: true }); break
      case 'uuid': cols[name] = name === 'id' ? text(name).primaryKey() : fin(text(name)); break
      case 'text': case 'image': cols[name] = fin(text(name)); break
      case 'int': cols[name] = fin(integer(name)); break
      case 'float': cols[name] = fin(real(name)); break
      case 'bool': cols[name] = fin(integer(name, { mode: 'boolean' })); break
      case 'enum': cols[name] = fin(text(name, { enum: f.values as [string, ...string[]] })); break
      case 'datetime': cols[name] = fin(integer(name, { mode: 'timestamp_ms' })); break
      case 'json': cols[name] = fin(text(name, { mode: 'json' })); break
      case 'money':
        cols[name] = fin(integer(name))
        cols[`${name}Currency`] = o.optional ? text(`${name}Currency`) : text(`${name}Currency`).notNull()
        if (o.default !== undefined) {
          const d = o.default as { value: number; currency: string }
          cols[name] = cols[name].default(d.value); cols[`${name}Currency`] = cols[`${name}Currency`].default(d.currency)
        }
        break
      case 'fk': {
        const k = `${name}Id`
        const target = f.target!()
        const c = pkField(target)[1].kind === 'id' ? integer(k) : text(k)
        cols[k] = fin(c).references(() => drizzleTable(target)[pkField(target)[0]], { onDelete: 'restrict' })
        break
      }
    }
    if (o.index) idx.push([name, keyOf(name, f)])
  }
  pkField(def)
  t = sqliteTable(def.name, cols, tbl => idx.map(([n, k]) => index(`${def.name}_${n}_idx`).on(tbl[k])))
  drizzleTables.set(def.fields, t)
  return t
}

const SNAP = 'meta/snapshot.json'
const BREAK = '--> statement-breakpoint'

// Import apps/*/models.(ts|js) and return every Model they export.
export async function discoverModels(appsDir: string): Promise<Model<any, any>[]> {
  const out: Model<any, any>[] = []
  for (const app of readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const file = ['models.ts', 'models.js'].map(f => join(appsDir, app, f)).find(existsSync)
    if (!file) continue                     // an app without models is fine; the empty-result check below guards the rest
    const mod = await import(pathToFileURL(file).href)
    for (const v of Object.values(mod)) {
      if (v && typeof v === 'object' && 'fields' in v && 'objects' in v && 'name' in v) out.push(v as Model<any, any>)
    }
  }
  if (!out.length) throw new Error(`no models found under ${appsDir} (expected apps/<app>/models.ts); refusing to treat this as "all models removed"`)
  return out
}

async function snapshotOf(models: Model<any, any>[]) {
  const tables = Object.fromEntries(models.map(m => [m.name, drizzleTable(m)]))
  return generateSQLiteDrizzleJson(tables)
}

async function diff(models: Model<any, any>[], outDir: string) {
  const cur = await snapshotOf(models)
  const snapFile = join(outDir, SNAP)
  const prev = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : await snapshotOf([])
  assertNoRename(prev, cur)
  return { cur, statements: await generateSQLiteMigration(prev, cur) }
}

// drizzle-kit asks on the terminal when a table/column is both added and removed (a possible rename).
// We never prompt: detect it first and stop with a clear message.
function assertNoRename(prev: any, cur: any): void {
  const pt = Object.keys(prev.tables ?? {}), ct = Object.keys(cur.tables ?? {})
  const addedT = ct.filter(t => !pt.includes(t)), removedT = pt.filter(t => !ct.includes(t))
  if (addedT.length && removedT.length) {
    throw new Error(`rename detected for ${removedT[0]} -> ${addedT[0]}: v1 treats renames as drop+add — rerun with allowDrop or split the change`)
  }
  for (const t of ct.filter(t => pt.includes(t))) {
    const pc = Object.keys(prev.tables[t].columns), cc = Object.keys(cur.tables[t].columns)
    const added = cc.filter(c => !pc.includes(c)), removed = pc.filter(c => !cc.includes(c))
    if (added.length && removed.length) {
      throw new Error(`rename detected for ${t}.${removed[0]}: v1 treats renames as drop+add — rerun with allowDrop or split the change`)
    }
  }
}

// Real drops only: a rebuild (CREATE __new_x ... DROP x ... RENAME __new_x TO x) is not destructive.
function drops(statements: string[]): string[] {
  const sqlText = statements.join('\n')
  const out: string[] = []
  for (const m of sqlText.matchAll(/DROP TABLE `([^`]+)`/g)) {
    if (!sqlText.includes(`RENAME TO \`${m[1]}\``)) out.push(m[1])
  }
  for (const m of sqlText.matchAll(/ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`/g)) out.push(`${m[1]}.${m[2]}`)
  return out
}

const files = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort() : []

export async function makeMigrations(
  appsDir: string, outDir: string, name?: string, opts: { allowDrop?: boolean } = {},
): Promise<{ file?: string; message: string }> {
  const models = await discoverModels(appsDir)
  const { cur, statements } = await diff(models, outDir)
  if (!statements.length) return { message: 'no changes detected' }
  const dropped = drops(statements)
  if (dropped.length && !opts.allowDrop) {
    throw new Error(`refusing to write a migration that drops ${dropped.join(', ')} (models removed or changed?); pass allowDrop to confirm`)
  }
  const existing = files(outDir)
  const n = String(existing.length + 1).padStart(4, '0')
  const file = `${n}_${name ?? (existing.length ? 'auto' : 'init')}.sql`
  mkdirSync(join(outDir, 'meta'), { recursive: true })
  const header = dropped.length ? `-- DESTRUCTIVE: drops ${dropped.join(', ')}\n` : ''
  writeFileSync(join(outDir, file), header + statements.join(`\n${BREAK}\n`) + '\n')
  writeFileSync(join(outDir, SNAP), JSON.stringify(cur, null, 2))
  return { file, message: dropped.length ? `WARNING: ${file} is DESTRUCTIVE and drops ${dropped.join(', ')}` : `created ${file}` }
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
      // table rebuilds need FK enforcement off, and the pragma is a no-op inside a transaction
      sqlite.pragma('foreign_keys = OFF')
      try {
        sqlite.transaction(() => {
          for (const s of body.split(BREAK)) if (s.trim()) sqlite.exec(s)
          if ((sqlite.pragma('foreign_key_check') as unknown[]).length) throw new Error(`migration ${f} would leave rows pointing at missing records`)
          sqlite.prepare(`INSERT INTO ${JOURNAL} VALUES (?, ?, ?)`).run(f, hash, Date.now())
        })()
      } finally { sqlite.pragma('foreign_keys = ON') }
      applied.push(f)
    }
    return { applied }
  } finally { sqlite.close() }
}

// true = clean. false = migrations pending, or the models under appsDir differ from the last migration.
export async function migrateCheck(dbUrl: string, migrationsDir: string, appsDir: string): Promise<boolean> {
  const { sqlite } = openConn(dbUrl)
  try {
    const has = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(JOURNAL)
    const done = new Set(has ? (sqlite.prepare(`SELECT name FROM ${JOURNAL}`).all() as { name: string }[]).map(r => r.name) : [])
    if (files(migrationsDir).some(f => !done.has(f))) return false
  } finally { sqlite.close() }
  return !(await diff(await discoverModels(appsDir), migrationsDir)).statements.length
}
