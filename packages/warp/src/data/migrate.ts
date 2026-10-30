// makemigrations / migrate / migrateCheck / sqlmigrate / showmigrations — exactly Django's model:
// per-app code files apps/<app>/migrations/NNNN_name.ts (dependencies + operations), no state
// file: ProjectState is rebuilt by replaying the files; makemigrations diffs it against models.ts.
// migrate renders each operation for the CONNECTED dialect at apply time and records
// __tvine_migrations(app, name, checksum, applied_at). Migration modules are TypeScript: the CLI
// runs under a TS-capable loader (tsx); pass `load` to import them some other way.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appModule } from '../core/actions.js'
import { openConn, type Connection } from './db.js'
import { IntField, TextField } from './fields/index.js'
import type { Model } from './model.js'
import { and, bin, col, inList, param } from './sql/ast.js'
import type { Dialect, Statement } from './sql/dialect.js'
import { sqlite } from './sql/dialects/sqlite.js'
import { diff } from './schema/autodetect.js'
import { render } from './schema/codegen.js'
import { importLoader, MigrationGraph, type Loader, type MigrationNode } from './schema/graph.js'
import { destroyed, type Migration, type Operation } from './schema/operations.js'
import { canon, emptyState, findModel, replay, stateFromModels, type ProjectState } from './schema/state.js'

export interface LoadOpts { load?: Loader }
const isModel = (v: any): v is Model<any, any> => !!v && typeof v === 'object' && 'fields' in v && 'objects' in v && 'name' in v

// apps/*/models.(ts|js) → models per app. A model belongs to the app whose models.ts exports it.
export async function discoverModels(appsDir: string, opts: LoadOpts = {}): Promise<Record<string, Model<any, any>[]>> {
  if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
  const out: Record<string, Model<any, any>[]> = {}
  const owner = new Map<string, string>()
  for (const app of readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const file = appModule(join(appsDir, app), 'models')
    if (!file) continue                     // an app without models is fine; the empty-result check below guards the rest
    const mod = await (opts.load ?? importLoader)(file)
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

// sha256 of the migration's DATA in a versioned canonical form (key-sorted JSON; op methods drop
// out): edits that change it are refused once applied; comments, formatting and codegen changes are not
export const checksum = (m: Migration) =>
  createHash('sha256').update(canon({ v: 1, dependencies: m.dependencies, operations: m.operations })).digest('hex')

// one migration forwards from `state`; with a dialect, also its SQL per operation (each op sees before/after)
function step(n: MigrationNode, state: ProjectState, d?: Dialect): { state: ProjectState; ops: Statement[][] } {
  const ops: Statement[][] = []
  for (const op of n.migration.operations) {
    const next = structuredClone(state)
    op.stateForwards(next, n.app)
    if (d) ops.push(op.databaseForwards(d, state, next))
    state = next
  }
  return { state, ops }
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
  dryRun?: boolean       // compute and report the files, write nothing
}

export async function makeMigrations(appsDir: string, opts: MakeOpts = {}): Promise<{ files: string[]; message: string }> {
  if (opts.name !== undefined && !/^\w+$/.test(opts.name)) throw new Error(`invalid migration name "${opts.name}" (letters, digits and _ only)`)
  const graph = await MigrationGraph.load(appsDir, opts)
  const write = (app: string, name: string, m: Migration) => {
    if (!opts.dryRun) {
      mkdirSync(join(appsDir, app, 'migrations'), { recursive: true })
      writeFileSync(join(appsDir, app, 'migrations', `${name}.ts`), render(m))
    }
    return `${app}/migrations/${name}.ts`
  }
  const created = (files: string[]) => `${opts.dryRun ? 'would create' : 'created'} ${files.join(', ')}`

  if (opts.merge) {
    const conflicts = Object.entries(graph.conflicts())
    if (!conflicts.length) return { files: [], message: 'no conflicts to merge' }
    const files = conflicts.map(([app, leaves]) =>
      write(app, `${graph.nextNumber(app)}_${opts.name ?? 'merge'}`, { dependencies: leaves.map(l => [app, l]), operations: [] }))
    return { files, message: created(files) }
  }
  graph.assertNoConflicts()

  if (opts.empty) {
    const app = opts.empty
    if (!existsSync(join(appsDir, app))) throw new Error(`no app "${app}" under ${appsDir}`)
    const leaf = graph.leaf(app)
    const file = write(app, `${graph.nextNumber(app)}_${opts.name ?? 'auto'}`, { dependencies: leaf ? [[app, leaf]] : [], operations: [] })
    return { files: [file], message: created([file]) }
  }

  const to = stateFromModels(await discoverModels(appsDir, opts))
  const changes = diff(replay(graph.order()), to)
  const apps = Object.keys(changes)
  if (!apps.length) return { files: [], message: 'no changes detected' }

  const drops = apps.flatMap(a => destroyed(changes[a]))
  if (drops.length && !opts.allowDrop) {
    throw new Error(`refusing to write a migration that drops ${drops.join(', ')} (models removed or changed?); pass allowDrop to confirm${renameHint(changes)}`)
  }
  // Django --noinput: existing rows would have no value (auto datetimes are backfilled at migrate time)
  for (const o of Object.values(changes).flat()) {
    if (o.kind === 'addField' && !o.field.opts.optional && o.field.opts.default === undefined && !o.field.opts.auto) {
      throw new Error(`field ${o.model}.${o.name} is required and has no default: add default:, make it optional, or add it in two steps`)
    }
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
    message: drops.length ? `WARNING: ${files.join(', ')} is DESTRUCTIVE and drops ${drops.join(', ')}` : created(files),
  }
}

// ---- journal + runner -------------------------------------------------------------------------
const JOURNAL = '__tvine_migrations'

async function readJournal({ driver, dialect: d }: Connection, create: boolean): Promise<Map<string, string>> {
  if (create) {
    const text = new TextField({ index: true }), int = new IntField()   // index: key columns (VARCHAR on mysql)
    const t = d.render({
      t: 'createTable', name: JOURNAL, ifNotExists: true, columns: [
        ...text.columnDDL('app', d), ...text.columnDDL('name', d), ...text.columnDDL('checksum', d), ...int.columnDDL('applied_at', d),
        `PRIMARY KEY (${d.quoteIdent('app')}, ${d.quoteIdent('name')})`,
      ],
    })
    // postgres: two concurrent CREATE TABLE IF NOT EXISTS can still collide (pg_type); serialize them
    if (d.name === 'postgres') await driver.transaction(async tx => { await tx.query(PG_LOCK, []); await tx.exec(t.sql, t.params) })
    else await driver.exec(t.sql, t.params)
  }
  const s = d.render({ t: 'select', from: JOURNAL, cols: ['app', 'name', 'checksum'].map(col) })
  try {
    const rows = await driver.query(s.sql, s.params)
    return new Map(rows.map(r => [`${r.app}.${r.name}`, String(r.checksum)]))
  } catch (e) {
    // sqlite texts / postgres SQLSTATE (42703 undefined column, 42P01 undefined table) / mysql codes
    const msg = String((e as Error).message), code = (e as { code?: string }).code
    if (/no such column/i.test(msg) || code === '42703' || code === 'ER_BAD_FIELD_ERROR') throw new Error(`the migration journal ${JOURNAL} is from an older Tvine build (pre-release format); migrate a fresh database or drop that table`)
    if (!create && (/no such table/i.test(msg) || code === '42P01' || code === 'ER_NO_SUCH_TABLE')) return new Map()
    throw e
  }
}

const journalRow = (d: Dialect, app: string, name: string, sum: string) =>
  d.render({ t: 'insert', into: JOURNAL, cols: ['app', 'name', 'checksum', 'applied_at'], values: [app, name, sum, Date.now()].map(param) })

// `createModel half`, `addField rv_p.x`, `renameModel a` — how an error names an operation
const opLabel = (o: Operation) => {
  const on = 'model' in o ? o.model : 'from' in o ? o.from : ''
  const f = 'name' in o ? o.name : o.kind === 'renameField' ? o.from : ''
  return `${o.kind}${on ? ` ${on}` : ''}${f ? `.${f}` : ''}`
}
// the journal row of one applied statement of a half-applied migration: `0002_x#<op>.<statement>`
const stepName = (n: MigrationNode, i: number, j: number) => `${n.name}#${i + 1}.${j + 1}`

// mysql: DDL auto-commits, so a migration cannot be all-or-nothing. Each statement is applied and
// journaled on its own; a re-run skips the journaled ones and resumes where it failed. Complete =
// the migration's row replaces its step rows.
async function applyStepwise({ driver, dialect: d }: Connection, n: MigrationNode, ops: Statement[][], sum: string, done: Map<string, string>): Promise<void> {
  const list = n.migration.operations
  for (const [i, stmts] of ops.entries()) {
    for (const [j, s] of stmts.entries()) {
      if (done.has(`${n.app}.${stepName(n, i, j)}`)) continue
      try {
        await driver.exec(s.sql, s.params)
      } catch (e) {
        const applied = i === 0 ? 'no operation is fully applied'
          : `operation${i > 1 ? `s 1-${i}` : ' 1'} (${list.slice(0, i).map(opLabel).join(', ')}) ${i > 1 ? 'are' : 'is'} applied`
        const partly = j > 0 ? `, as ${j === 1 ? 'is the first statement' : `are the first ${j} statements`} of operation ${i + 1}` : ''
        throw new Error(`migration ${n.key} failed at operation ${i + 1}/${list.length} (${opLabel(list[i])}): ${(e as Error).message}. ` +
          `${applied}${partly} and recorded in ${JOURNAL} — ${d.name} cannot roll back schema changes. Fix the cause and run migrate again ` +
          `to resume at operation ${i + 1}; to change the migration instead, undo what it applied by hand and delete its '${n.name}#…' rows from ${JOURNAL}.`, { cause: e })
      }
      const row = journalRow(d, n.app, stepName(n, i, j), sum)
      try {
        await driver.exec(row.sql, row.params)
      } catch (e) {
        throw new Error(`migration ${n.key}: statement ${j + 1} of operation ${i + 1} (${opLabel(list[i])}) ran but was not recorded (${(e as Error).message}): ` +
          `insert the journal row ('${n.app}', '${stepName(n, i, j)}') into ${JOURNAL} by hand, or a re-run will run that statement again`, { cause: e })
      }
    }
  }
  const steps = ops.flatMap((stmts, i) => stmts.map((_, j) => param(stepName(n, i, j))))
  await driver.transaction(async tx => {
    const row = journalRow(d, n.app, n.name, sum)
    await tx.exec(row.sql, row.params)
    if (!steps.length) return
    const del = d.render({ t: 'delete', from: JOURNAL, where: and(bin('=', col('app'), param(n.app)), inList(col('name'), steps)) })
    await tx.exec(del.sql, del.params)
  })
}

// #16: concurrent `migrate` runs on postgres queue on this transaction-scoped lock, then re-check the journal
const PG_LOCK = "SELECT pg_advisory_xact_lock(hashtext('tvine_migrate'))"

// false = another migrate run applied it meanwhile (postgres)
async function apply({ driver, dialect: d }: Connection, n: MigrationNode, stmts: Statement[], sum: string): Promise<boolean> {
  // The whole migration (+ its journal row) is ONE transaction: sqlite and postgres have
  // transactional DDL. The FK-off wrapper is sqlite's (rebuilds need it; the pragma is a no-op
  // inside a transaction); postgres ALTERs in place, so its fks stay on. mysql: applyStepwise.
  const lite = d.name === 'sqlite'
  if (lite) await driver.exec('PRAGMA foreign_keys = OFF', [])
  try {
    return await driver.transaction(async tx => {
      if (d.name === 'postgres') {
        await tx.query(PG_LOCK, [])
        const seen = d.render({ t: 'select', from: JOURNAL, cols: [col('app')], where: and(bin('=', col('app'), param(n.app)), bin('=', col('name'), param(n.name))) })
        if ((await tx.query(seen.sql, seen.params)).length) return false
      }
      for (const s of stmts) await tx.exec(s.sql, s.params)
      if (lite && (await tx.query('PRAGMA foreign_key_check', [])).length) throw new Error(`migration ${n.key} would leave rows pointing at missing records`)
      const ins = journalRow(d, n.app, n.name, sum)
      await tx.exec(ins.sql, ins.params)
      return true
    })
  } finally {
    if (lite) await driver.exec('PRAGMA foreign_keys = ON', [])
  }
}

async function withConn<R>(db: string | Connection, fn: (c: Connection) => Promise<R>): Promise<R> {
  const conn = typeof db === 'string' ? openConn(db) : db
  try { return await fn(conn) } finally { if (typeof db === 'string') await conn.driver.close() }
}

// plan: list what would apply, touch nothing. fake: journal as applied without running SQL (Django --fake).
export interface MigrateOpts extends LoadOpts { plan?: boolean; fake?: boolean }

export async function migrate(db: string | Connection, appsDir: string, opts: MigrateOpts = {}): Promise<{ applied: string[] }> {
  const graph = await MigrationGraph.load(appsDir, opts)
  graph.assertNoConflicts()
  const plan = graph.order()
  return withConn(db, conn => conn.dialect.name === 'mysql' ? mysqlLocked(conn, c => run(c)) : run(conn))
  async function run(conn: Connection): Promise<{ applied: string[] }> {
    const done = await readJournal(conn, !opts.plan)
    for (const n of plan) {
      if (done.has(n.key) && done.get(n.key) !== checksum(n.migration)) throw new Error(`migration ${n.key} was edited after it was applied`)
      if (!done.has(n.key) && [...done].some(([k, sum]) => k.startsWith(`${n.key}#`) && sum !== checksum(n.migration))) {
        throw new Error(`migration ${n.key} was edited after it was partly applied: restore it and run migrate to finish it, or undo what it applied by hand and delete its '${n.name}#…' rows from ${JOURNAL}`)
      }
    }
    let state = emptyState()
    const applied: string[] = []
    for (const n of plan) {
      const run = !done.has(n.key) && !opts.plan && !opts.fake
      const r = step(n, state, run ? conn.dialect : undefined)
      if (!done.has(n.key)) {
        const sum = checksum(n.migration)
        let ran = true   // false: a concurrent run applied it first (postgres lock)
        if (opts.plan) { /* listed only */ }
        else if (opts.fake) ran = await apply(conn, n, [], sum)
        else if (conn.dialect.transactionalDDL) ran = await apply(conn, n, r.ops.flat(), sum)
        else await applyStepwise(conn, n, r.ops, sum, done)
        if (ran) applied.push(n.key)
      }
      state = r.state
    }
    return { applied }
  }
}

// #21: mysql DDL is not transactional, so the whole run holds a session lock on ONE pooled connection;
// a second run waits for it, then reads the journal the first one wrote.
const MYSQL_LOCK_WAIT_S = 600
async function mysqlLocked<R>(conn: Connection, fn: (c: Connection) => Promise<R>): Promise<R> {
  if (!conn.driver.session) return fn(conn)
  return conn.driver.session(async d => {
    const [row] = await d.query('SELECT GET_LOCK(?, ?) AS ok', ['tvine_migrate', MYSQL_LOCK_WAIT_S])
    if (Number(row?.ok) !== 1) throw new Error(`another tvine migrate held the lock for ${MYSQL_LOCK_WAIT_S} s; try again when it is done`)
    try { return await fn({ ...conn, driver: d }) } finally { await d.query('SELECT RELEASE_LOCK(?)', ['tvine_migrate']) }
  })
}

// true = clean. false = migrations pending / edited / conflicting, or models.ts drifted from the files.
export async function migrateCheck(db: string | Connection, appsDir: string, opts: LoadOpts = {}): Promise<boolean> {
  const models = await discoverModels(appsDir, opts)
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
    if (n === target) return step(n, state, dialect).ops.flat().map(s => `${s.sql};${s.params.length ? ` -- params: ${JSON.stringify(s.params)}` : ''}`).join('\n')
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
