// MigrationGraph (Django's): every apps/<app>/migrations/NNNN_name.ts, linked by `dependencies`
// into a DAG across apps. order() = deterministic topological plan; >1 leaf in one app = conflict.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { importApp } from '../../core/actions.js'
import type { Migration } from './operations.js'

// Migration and models modules are TypeScript: importApp loads them through esbuild; tests use vitest.
// A Loader returns the module namespace (migrations use its `default`).
export type Loader = (path: string) => Promise<Record<string, unknown>>
export const importLoader: Loader = importApp

export interface MigrationNode { app: string; name: string; key: string; migration: Migration }

const FILE = /^(\d{4}_\w+)\.(ts|mts|js|mjs)$/

const isMigration = (m: any): m is Migration =>
  !!m && Array.isArray(m.dependencies) && Array.isArray(m.operations) && m.operations.every((o: any) => typeof o?.stateForwards === 'function')

export class MigrationGraph {
  readonly nodes = new Map<string, MigrationNode>()

  static async load(appsDir: string, opts: { load?: Loader } = {}): Promise<MigrationGraph> {
    if (!existsSync(appsDir)) throw new Error(`no apps directory at ${appsDir}`)
    const load = opts.load ?? importLoader
    const g = new MigrationGraph()
    for (const app of readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      const dir = join(appsDir, app, 'migrations')
      if (!existsSync(dir)) continue
      const byName = new Map<string, string>()                  // a .ts beats a compiled .js of the same name
      for (const f of readdirSync(dir).sort()) {
        const m = FILE.exec(f)
        if (m && (!byName.has(m[1]) || m[2] === 'ts')) byName.set(m[1], f)
      }
      for (const [name, f] of byName) {
        const mod = (await load(join(dir, f))).default
        if (!isMigration(mod)) throw new Error(`apps/${app}/migrations/${f} does not export default migration({ dependencies, operations })`)
        g.add(app, name, mod)
      }
    }
    return g
  }

  add(app: string, name: string, migration: Migration): void {
    this.nodes.set(`${app}.${name}`, { app, name, key: `${app}.${name}`, migration })
  }
  get(app: string, name: string): MigrationNode | undefined { return this.nodes.get(`${app}.${name}`) }
  private inApp(app: string) { return [...this.nodes.values()].filter(n => n.app === app) }

  // migrations of `app` no other migration of `app` depends on
  leaves(app: string): string[] {
    const inApp = this.inApp(app)
    const used = new Set(inApp.flatMap(n => n.migration.dependencies.filter(([a]) => a === app).map(([, nm]) => nm)))
    return inApp.map(n => n.name).filter(n => !used.has(n)).sort()
  }
  leaf(app: string): string | undefined { return this.leaves(app).at(-1) }
  conflicts(): Record<string, string[]> {
    const apps = [...new Set([...this.nodes.values()].map(n => n.app))].sort()
    return Object.fromEntries(apps.map(a => [a, this.leaves(a)]).filter(([, l]) => l.length > 1))
  }
  assertNoConflicts(): void {
    for (const [app, leaves] of Object.entries(this.conflicts())) {
      throw new Error(`conflicting migrations in ${app} (${leaves.join(', ')}): run makemigrations --merge`)
    }
  }
  nextNumber(app: string): string {
    const max = Math.max(0, ...this.inApp(app).map(n => Number(n.name.slice(0, 4))))
    return String(max + 1).padStart(4, '0')
  }

  // depth-first over sorted keys, dependencies first: the same plan on every machine
  order(): MigrationNode[] {
    const out: MigrationNode[] = []
    const seen = new Map<string, 'visiting' | 'done'>()
    const visit = (n: MigrationNode, path: string[]) => {
      if (seen.get(n.key) === 'done') return
      if (seen.get(n.key) === 'visiting') throw new Error(`circular migration dependency: ${[...path, n.key].join(' -> ')}`)
      seen.set(n.key, 'visiting')
      for (const [a, nm] of [...n.migration.dependencies].sort()) {
        const dep = this.get(a, nm)
        if (!dep) throw new Error(`${n.key} depends on ${a}.${nm}, which does not exist`)
        visit(dep, [...path, n.key])
      }
      seen.set(n.key, 'done')
      out.push(n)
    }
    for (const k of [...this.nodes.keys()].sort()) visit(this.nodes.get(k)!, [])
    return out
  }
}
