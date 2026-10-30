#!/usr/bin/env node
// tvine — Django-style management commands (server-index.md §CLI, models-db.md §Migration commands).
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { openConn } from './data/db.js'
import { makeMigrations, migrate, migrateCheck, showMigrations, sqlMigrate } from './data/migrate.js'
import { createAgentServer, loadSettings, type AgentServerOptions } from './server.js'
import { mcpEnabled } from './transport/mcp.js'

export interface Io { out(s: string): void; err(s: string): void; exit(code: number): void }
const stdio: Io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }

const USAGE = `usage: tvine <command> [--apps ./apps]
  start [--port 3000]           serve (SIGTERM/SIGINT: graceful close)
  check                         settings + actions + migrations gate (exit 1 on problems)
  routes                        print the action manifest
  makemigrations [app] [--name x] [--allow-drop] [--merge] [--empty]
  migrate [--check]
  sqlmigrate <app> <migration>
  showmigrations`

// .env.local beats .env; real environment variables beat both (loadEnvFile never overrides).
function loadEnv() {
  for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)
}

// a built Next app in cwd is served; otherwise API-only
const frontend = (): AgentServerOptions['frontend'] =>
  existsSync('.next/app-path-routes-manifest.json') ? { nextDir: resolve('.next') } : undefined
const hasModels = (apps: string) =>
  readdirSync(apps, { withFileTypes: true }).some((d) => d.isDirectory() && ['models.ts', 'models.js'].some((f) => existsSync(join(apps, d.name, f))))

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n')
}

export async function main(argv: string[], io: Io = stdio): Promise<number | undefined> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, options: {
        apps: { type: 'string', default: 'apps' }, port: { type: 'string' }, name: { type: 'string' },
        'allow-drop': { type: 'boolean' }, merge: { type: 'boolean' }, empty: { type: 'boolean' }, check: { type: 'boolean' },
      },
    })
  } catch (e) { io.err(`${(e as Error).message}\n${USAGE}`); return 1 }
  const { values: o, positionals: [cmd, ...args] } = parsed
  const apps = resolve(o.apps)
  loadEnv()
  try {
    switch (cmd) {
      case 'start': {
        const port = Number(o.port ?? process.env.PORT ?? 3000)
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        await srv.listen(port)
        io.out(`listening on http://127.0.0.1:${(srv.server.address() as { port: number }).port}`)
        const stop = () => {
          process.off('SIGTERM', stop); process.off('SIGINT', stop)
          srv.close().then(() => io.exit(0), (e: unknown) => { io.err(`tvine: close failed: ${String(e)}`); io.exit(1) })
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
        return undefined
      }
      case 'check': {
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        await srv.close()
        if (hasModels(apps) && !(await migrateCheck(srv.ctx.settings.db.url, apps))) {
          io.err('tvine check: migrations are pending or models.ts changed (run tvine makemigrations / migrate)')
          return 1
        }
        io.out(`ok: ${srv.ctx.actions.all().length} actions`)
        return 0
      }
      case 'routes': {
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        await srv.close()
        const { actions, settings } = srv.ctx
        io.out(table([['action', 'app', 'params', 'permissions', 'mcp'], ...actions.all().map((d) => [
          d.id, d.id.slice(0, d.id.indexOf('.')),
          actions.paramSpecs(d.id).map((p) => p.name + (p.required ? '' : '?')).join(', ') || '-',
          (d.rules?.permissions ?? []).map((p) => p.name || 'fn').join(', ') || '-',
          mcpEnabled(d, settings) ? 'yes' : 'no',
        ])]))
        return 0
      }
      case 'makemigrations': {
        const [app] = args
        if (app !== undefined && !o.empty) throw new Error('per-app makemigrations is only supported with --empty')
        if (o.empty && app === undefined) throw new Error('--empty needs an app: tvine makemigrations <app> --empty')
        const r = await makeMigrations(apps, { name: o.name, allowDrop: o['allow-drop'], merge: o.merge, empty: app })
        io.out(r.message)
        return 0
      }
      case 'migrate': {
        const url = (await loadSettings()).db.url
        if (o.check) return (await migrateCheck(url, apps)) ? 0 : 1
        const { applied } = await migrate(url, apps)
        io.out(applied.length ? applied.map((k) => `applied ${k}`).join('\n') : 'no migrations to apply')
        return 0
      }
      case 'sqlmigrate': {
        const [app, name] = args
        if (!app || !name) throw new Error('usage: tvine sqlmigrate <app> <migration>')
        const conn = openConn((await loadSettings()).db.url)   // the connected dialect, as Django does
        try { io.out(await sqlMigrate(apps, app, name, conn.dialect)) } finally { await conn.driver.close() }
        return 0
      }
      case 'showmigrations': {
        const rows = await showMigrations((await loadSettings()).db.url, apps)
        const lines: string[] = []
        for (const [i, r] of rows.entries()) {
          if (rows[i - 1]?.app !== r.app) lines.push(r.app)
          lines.push(` [${r.applied ? 'X' : ' '}] ${r.name}`)
        }
        io.out(lines.join('\n') || '(no migrations)')
        return 0
      }
      default:
        io.err(USAGE)
        return 1
    }
  } catch (e) {
    io.err(`tvine ${cmd}: ${(e as Error).message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code) })
}
