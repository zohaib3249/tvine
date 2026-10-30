// makemigrations / migrate / migrateCheck / sqlmigrate / showmigrations — exactly Django's model:
// per-app code files apps/<app>/migrations/NNNN_name.ts (dependencies + operations), no state
// file: ProjectState is rebuilt by replaying the files; makemigrations diffs it against models.ts.
// migrate renders each operation for the CONNECTED dialect at apply time and records
// __tvine_migrations(app, name, checksum, applied_at). Migration modules are TypeScript: the CLI
// runs under a TS-capable loader (tsx); pass `load` to import them some other way.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openConn, type Connection } from './db.js'
import { IntField, TextField } from './fields/index.js'
import type { Model } from './model.js'
import { col, param } from './sql/ast.js'
import type { Dialect, Statement } from './sql/dialect.js'
import { sqlite } from './sql/dialects/sqlite.js'
import { diff } from './schema/autodetect.js'
import { render } from './schema/codegen.js'
import { MigrationGraph, type Loader, type MigrationNode } from './schema/graph.js'
import { destroyed, type Migration, type Operation } from './schema/operations.js'
import { emptyState, findModel, replay, stateFromModels, type ProjectState } from './schema/state.js'

export interface LoadOpts { load?: Loader }
const isModel = (v: any): v is Model<any, any> => !!v && typeof v === 'object' && 'fields' in v && 'objects' in v && 'name' in v

// apps/*/models.(ts|js) → models per app. A model belongs to the app whose models.ts exports it.
export async function discoverModels(appsDir: string): Promise<Record<string, Model<any, any>[]>> {
  if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
  const out: Record<string, Model<any, any>[]> = {}
  const owner = new Map<string, string>()
  for (const app of readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const file = ['models.ts', 'models.js'].map(f => join(appsDir, app, f)).find(existsSync)
    if (!file) continue                     // an app without models is fine; the empty-result check below guards the rest
    const mod = await import(pathToFileURL(file).href)
    for (const v of new Set(Object.values(mod))) {
      if (!isModel(v)) continue
      const prev = owner.get(v.name)
      if (prev) throw new Error(`model "${v.name}" is exported by apps/${prev}/models.ts and apps/${app}/models.ts; export it only from the app that defines it`)
      owner.set(v.name, app)
      ;(out[app] ??= []).push(v)
    }
  }
  if (!owner.size) throw new Error(`no models found under ${appsDir} (expected apps/<app>/models.ts); refusing to treat this as "all models removed"`)
  return out
}

// canonical code of the loaded migration: edits that change it are refused once applied;
// comments and formatting are not
const checksum = (m: Migration) => createHash('sha256').update(render(m)).digest('hex')

// one migration forwards from `state`; with a dialect, also its SQL (each op sees before/after)
function step(n: MigrationNode, state: ProjectState, d?: Dialect): { state: ProjectState; stmts: Statement[] } {
  const stmts: Statement[] = []
  for (const op of n.migration.operations) {
    const next = structuredClone(state)
    op.stateForwards(next, n.app)
    if (d) stmts.push(...op.databaseForwards(d, state, next))
    state = next
  }
  return { state, stmts }
}

// ---- makemigrations ---------------------------------------------------------------------------
const FRAGMENT: Partial<Record<Operation['kind'], (o: any) => string>> = {
  createModel: o => o.model,
  deleteModel: o => `delete_${o.model}`,
  addField: o => `${o.model}_${o.name}`,
  removeField: o => `remove_${o.model}_${o.name}`,
  alterField: o => `alter_${o.model}_${o.name}`,
}
// Django-style: 0001_initial, 0002_product_stock, 0003_auto when there is no short description
function autoName(initial: boolean, list: Operation[]): string {
  if (initial) return 'initial'
  const parts = list.map(o => FRAGMENT[o.kind]?.(o))
  const name = parts.join('_')
  return parts.some(p => !p) || name.length > 52 ? 'auto' : name
}

// a remove + add in the same model looks like a rename: say how to write one
function renameHint(byApp: Record<string, Operation[]>): string {
  for (const list of Object.values(byApp)) {
    for (const r of list) {
      if (r.kind === 'removeField') {
        const a = list.find(o => o.kind === 'addField' && o.model === r.model)
        if (a?.kind === 'addField') return `; if it is a rename, write ops.renameField('${r.model}', '${r.name}', '${a.name}') by hand instead`
      }
      if (r.kind === 'deleteModel') {
        const a = list.find(o => o.kind === 'createModel')
        if (a?.kind === 'createModel') return `; if it is a rename, write ops.renameModel('${r.model}', '${a.model}') by hand instead`
      }
    }
  }
  return ''
}

export interface MakeOpts extends LoadOpts {
  name?: string          // migration name instead of the auto name
  allowDrop?: boolean    // confirm removeField / deleteModel
  merge?: boolean        // write merge migrations for apps with conflicting leaves
  empty?: string         // write an empty migration for this app (for hand-written ops)
}

export async function makeMigrations(appsDir: string, opts: MakeOpts = {}): Promise<{ files: string[]; message: string }> {
  if (opts.name !== undefined && !/^\w+$/.test(opts.name)) throw new Error(`invalid migration name "${opts.name}" (letters, digits and _ only)`)
  const graph = await MigrationGraph.load(appsDir, opts)
  const write = (app: string, name: string, m: Migration) => {
    mkdirSync(join(appsDir, app, 'migrations'), { recursive: true })
    writeFileSync(join(appsDir, app, 'migrations', `${name}.ts`), render(m))
    return `${app}/migrations/${name}.ts`
  }

  if (opts.merge) {
    const conflicts = Object.entries(graph.conflicts())
    if (!conflicts.length) return { files: [], message: 'no conflicts to merge' }
    const files = conflicts.map(([app, leaves]) =>
      write(app, `${graph.nextNumber(app)}_${opts.name ?? 'merge'}`, { dependencies: leaves.map(l => [app, l]), operations: [] }))
    return { files, message: `created ${files.join(', ')}` }
  }
  graph.assertNoConflicts()

  if (opts.empty) {
    const app = opts.empty
    if (!existsSync(join(appsDir, app))) throw new Error(`no app "${app}" under ${appsDir}`)
    const leaf = graph.leaf(app)
    const file = write(app, `${graph.nextNumber(app)}_${opts.name ?? 'auto'}`, { dependencies: leaf ? [[app, leaf]] : [], operations: [] })
    return { files: [file], message: `created ${file}` }
  }

  const to = stateFromModels(await discoverModels(appsDir))
  const changes = diff(replay(graph.order()), to)
  const apps = Object.keys(changes)
  if (!apps.length) return { files: [], message: 'no changes detected' }

  const drops = apps.flatMap(a => destroyed(changes[a]))
  if (drops.length && !opts.allowDrop) {
    throw new Error(`refusing to write a migration that drops ${drops.join(', ')} (models removed or changed?); pass allowDrop to confirm${renameHint(changes)}`)
  }

  const names = new Map(apps.map(a => [a, `${graph.nextNumber(a)}_${opts.name ?? autoName(!graph.leaf(a), changes[a])}`]))
  const planned = new MigrationGraph()
  for (const n of graph.nodes.values()) planned.add(n.app, n.name, n.migration)
  for (const app of apps) {
    const own = graph.leaf(app)
    const deps: [string, string][] = own ? [[app, own]] : []
    // fk to another app's model → depend on that app's latest migration (incl. one written now)
    for (const o of changes[app]) {
      const specs = o.kind === 'createModel' ? Object.values(o.fields) : o.kind === 'addField' || o.kind === 'alterField' ? [o.field] : []
      for (const s of specs) {
        const target = s.kind === 'fk' ? findModel(to, s.to!)?.app : undefined
        if (!target || target === app) continue
        const dep: [string, string] = [target, names.get(target) ?? graph.leaf(target)!]
        if (!deps.some(([a, n]) => a === dep[0] && n === dep[1])) deps.push(dep)
      }
    }
    planned.add(app, names.get(app)!, { dependencies: deps, operations: changes[app] })
  }
  planned.order()                                       // circular fks across apps fail here, before any file is written

  const files = apps.map(a => write(a, names.get(a)!, planned.get(a, names.get(a)!)!.migration))
  return {
    files,
    message: drops.length ? `WARNING: ${files.join(', ')} is DESTRUCTIVE and drops ${drops.join(', ')}` : `created ${files.join(', ')}`,
  }
}

// ---- journal + runner -------------------------------------------------------------------------
const JOURNAL = '__tvine_migrations'

async function readJournal({ driver, dialect: d }: Connection, create: boolean): Promise<Map<string, string>> {
  if (create) {
    const text = new TextField(), int = new IntField()
    const t = d.render({
      t: 'createTable', name: JOURNAL, ifNotExists: true, columns: [
        ...text.columnDDL('app', d), ...text.columnDDL('name', d), ...text.columnDDL('checksum', d), ...int.columnDDL('applied_at', d),
        `PRIMARY KEY (${d.quoteIdent('app')}, ${d.quoteIdent('name')})`,
      ],
    })
    await driver.exec(t.sql, t.params)
  }
  const s = d.render({ t: 'select', from: JOURNAL, cols: ['app', 'name', 'checksum'].map(col) })
  try {
    const rows = await driver.query(s.sql, s.params)
    return new Map(rows.map(r => [`${r.app}.${r.name}`, String(r.checksum)]))
  } catch (e) {
    // ponytail: sqlite error texts; pg/mysql variants land with their dialects (Task 20)
    const msg = String((e as Error).message)
    if (/no such column/i.test(msg)) throw new Error(`the migration journal ${JOURNAL} is from an older Tvine build (pre-release format); migrate a fresh database or drop that table`)
    if (!create && /no such table/i.test(msg)) return new Map()
    throw e
  }
}

async function apply({ driver, dialect: d }: Connection, n: MigrationNode, stmts: Statement[], sum: string): Promise<void> {
  // ponytail: the FK-off wrapper is sqlite's (rebuilds need it; the pragma is a no-op inside a
  // transaction). pg/mysql (non-transactional DDL on mysql) land with their dialects in Task 20.
  const lite = d.name === 'sqlite'
  if (lite) await driver.exec('PRAGMA foreign_keys = OFF', [])
  try {
    await driver.transaction(async () => {
      for (const s of stmts) await driver.exec(s.sql, s.params)
      if (lite && (await driver.query('PRAGMA foreign_key_check', [])).length) throw new Error(`migration ${n.key} would leave rows pointing at missing records`)
      const ins = d.render({ t: 'insert', into: JOURNAL, cols: ['app', 'name', 'checksum', 'applied_at'], values: [n.app, n.name, sum, Date.now()].map(param) })
      await driver.exec(ins.sql, ins.params)
    })
  } finally {
    if (lite) await driver.exec('PRAGMA foreign_keys = ON', [])
  }
}

async function withConn<R>(db: string | Connection, fn: (c: Connection) => Promise<R>): Promise<R> {
  const conn = typeof db === 'string' ? openConn(db) : db
  try { return await fn(conn) } finally { if (typeof db === 'string') conn.driver.close() }
}

export async function migrate(db: string | Connection, appsDir: string, opts: LoadOpts = {}): Promise<{ applied: string[] }> {
  const graph = await MigrationGraph.load(appsDir, opts)
  graph.assertNoConflicts()
  const plan = graph.order()
  return withConn(db, async conn => {
    const done = await readJournal(conn, true)
    for (const n of plan) {
      if (done.has(n.key) && done.get(n.key) !== checksum(n.migration)) throw new Error(`migration ${n.key} was edited after it was applied`)
    }
    let state = emptyState()
    const applied: string[] = []
    for (const n of plan) {
      const r = step(n, state, done.has(n.key) ? undefined : conn.dialect)
      if (!done.has(n.key)) { await apply(conn, n, r.stmts, checksum(n.migration)); applied.push(n.key) }
      state = r.state
    }
    return { applied }
  })
}

// true = clean. false = migrations pending / edited / conflicting, or models.ts drifted from the files.
export async function migrateCheck(db: string | Connection, appsDir: string, opts: LoadOpts = {}): Promise<boolean> {
  const models = await discoverModels(appsDir)
  const graph = await MigrationGraph.load(appsDir, opts)
  if (Object.keys(graph.conflicts()).length) return false
  const plan = graph.order()
  const done = await withConn(db, c => readJournal(c, false))
  if (plan.some(n => done.get(n.key) !== checksum(n.migration))) return false
  return !Object.keys(diff(replay(plan), stateFromModels(models))).length
}

// Django's sqlmigrate: the SQL one migration runs on `dialect` (name may be a prefix: '0002')
export async function sqlMigrate(appsDir: string, app: string, name: string, dialect: Dialect = sqlite, opts: LoadOpts = {}): Promise<string> {
  const plan = (await MigrationGraph.load(appsDir, opts)).order()
  const hits = plan.filter(n => n.app === app && (n.name === name || n.name.startsWith(name)))
  const target = hits.find(n => n.name === name) ?? (hits.length === 1 ? hits[0] : undefined)
  if (!target) throw new Error(hits.length ? `${app}.${name} is ambiguous: ${hits.map(n => n.name).join(', ')}` : `no migration ${app}.${name}`)
  let state = emptyState()
  for (const n of plan) {
    if (n === target) return step(n, state, dialect).stmts.map(s => `${s.sql};`).join('\n')
    state = step(n, state).state
  }
  throw new Error('unreachable')
}

// Django's showmigrations: every migration per app, in plan order, applied or not
export async function showMigrations(db: string | Connection, appsDir: string, opts: LoadOpts = {}): Promise<{ app: string; name: string; applied: boolean }[]> {
  const plan = (await MigrationGraph.load(appsDir, opts)).order()
  const done = await withConn(db, c => readJournal(c, false))
  return plan.map(n => ({ app: n.app, name: n.name, applied: done.has(n.key) }))
    .sort((a, b) => (a.app < b.app ? -1 : a.app > b.app ? 1 : 0))
}
