#!/usr/bin/env node
// tvine — Django-style management commands (server-index.md §CLI, models-db.md §Migration commands).
import { existsSync, readdirSync, readFileSync, realpathSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { appModule } from './core/actions.js'
import { openConn } from './data/db.js'
import { makeMigrations, migrate, migrateCheck, showMigrations, sqlMigrate } from './data/migrate.js'
import { boundaryCheck, boundaryReport } from './cli/boundary.js'
import { API_DTS, generateApiTypes } from './cli/generate.js'
import { createAgentServer, loadSettings, type AgentServerOptions } from './server.js'
import { mcpEnabled } from './transport/mcp.js'

export interface Io { out(s: string): void; err(s: string): void; exit(code: number): void }
const stdio: Io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }

const USAGE = `usage: tvine <command> [--apps ./apps]
  start [--port 3000] [--api-only]  serve (SIGTERM/SIGINT: graceful close, hard exit at 5 s);
                                --api-only: no frontend (Next runs separately with TVINE_API_URL)
  dev [--port 3000]             runserver: in-process next dev (needs next installed)
  inspect [url] [--port 7357]   split-view devtool on 127.0.0.1 (needs @tvine/inspect; dev only)
  check                         settings + actions + migrations + FE/DB boundary gate (exit 1 on problems)
  routes                        print the action manifest
  generate [--check]            write tvine-api.d.ts (api.* types); --check: exit 1 when it is stale
  makemigrations [app] [--name x] [--allow-drop] [--merge] [--empty] [--check] [--dry-run]
  migrate [--check] [--plan] [--fake]
  sqlmigrate <app> <migration>
  showmigrations`

type Opts = NonNullable<ParseArgsConfig['options']>
const bool = { type: 'boolean' } as const, str = { type: 'string' } as const
// per command: its own flags and how many positionals it takes
const COMMANDS: Record<string, { options: Opts; args: [min: number, max: number] }> = {
  start: { options: { port: str, 'api-only': bool }, args: [0, 0] },
  dev: { options: { port: str }, args: [0, 0] },
  inspect: { options: { port: str }, args: [0, 1] },
  check: { options: {}, args: [0, 0] },
  routes: { options: {}, args: [0, 0] },
  generate: { options: { check: bool }, args: [0, 0] },
  makemigrations: { options: { name: str, 'allow-drop': bool, merge: bool, empty: bool, check: bool, 'dry-run': bool }, args: [0, 1] },
  migrate: { options: { check: bool, plan: bool, fake: bool }, args: [0, Infinity] },   // targets refused below, loudly
  sqlmigrate: { options: {}, args: [2, 2] },
  showmigrations: { options: {}, args: [0, 0] },
}

class Usage extends Error {}

// .env.local beats .env; real environment variables beat both (loadEnvFile never overrides).
function loadEnv() {
  for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)
}

// a built Next app in cwd is served; otherwise API-only
const frontend = (): AgentServerOptions['frontend'] =>
  existsSync('.next/app-path-routes-manifest.json') ? { nextDir: resolve('.next') } : undefined
const hasModels = (apps: string) =>
  readdirSync(apps, { withFileTypes: true }).some((d) => d.isDirectory() && appModule(join(apps, d.name), 'models') !== undefined)

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n')
}

// what migrate --check / check report when the database is not clean
async function pending(url: string, apps: string): Promise<string> {
  const open = (await showMigrations(url, apps)).filter((m) => !m.applied).map((m) => `${m.app}.${m.name}`)
  return open.length ? `pending: ${open.join(', ')} (run tvine migrate)` : 'models.ts changed since the last migration (run tvine makemigrations)'
}

// tvine dev: regenerate tvine-api.d.ts when apps/*/{views,serializers} change. A child process, because
// this one's ESM cache keeps the old modules. ponytail: fs.watch recursive (macOS/Windows/Linux on Node >= 20)
function devRegenerate(apps: string, io: Io): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = () => spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'generate', '--apps', apps], { stdio: ['ignore', 'ignore', 'pipe'] })
    .stderr.on('data', (b: Buffer) => io.err(b.toString().trimEnd()))
  const w = watch(apps, { recursive: true }, (_e, f) => {
    if (!f || !/(^|[\\/])(views|serializers)\.(m?[jt]s)$/.test(String(f))) return
    clearTimeout(timer)
    timer = setTimeout(run, 200)
  })
  return { close: () => { clearTimeout(timer); w.close() } }
}

export async function main(argv: string[], io: Io = stdio): Promise<number | undefined> {
  const [cmd, ...rest] = argv
  const spec = cmd === undefined ? undefined : COMMANDS[cmd]
  if (!spec) { io.err(USAGE); return 1 }
  try {
    let parsed
    try { parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { apps: { type: 'string', default: 'apps' }, ...spec.options } }) }
    catch (e) { const m = (e as Error).message.replace(/\. To specify a positional.*$/s, ''); throw new Usage(m[0]!.toLowerCase() + m.slice(1)) }
    const o = parsed.values as Record<string, string | boolean | undefined> & { apps: string }
    const args = parsed.positionals
    if (args.length > spec.args[1]) throw new Usage(`unexpected argument '${args[spec.args[1]]}'`)
    if (args.length < spec.args[0]) throw new Usage(`usage: tvine ${cmd} <app> <migration>`)
    const apps = resolve(o.apps)
    loadEnv()
    switch (cmd) {
      case 'start':
      case 'dev': {
        const port = o.port === undefined ? Number(process.env.PORT ?? 3000) : Number(o.port)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port must be an integer 0-65535')
        const dev = cmd === 'dev'
        // like `next start`: start means production unless NODE_ENV says otherwise (stable secret, no inspector feed)
        if (!dev) process.env.NODE_ENV ||= 'production'   // empty (NODE_ENV=) counts as unset
        if (dev && process.env.NODE_ENV === 'production') throw new Usage('tvine dev is for development; use tvine start in production')
        const srv = await createAgentServer({ appsDir: apps, dev, frontend: dev ? { nextDir: resolve('.next') } : o['api-only'] ? undefined : frontend() })
        await srv.listen(port).catch(async (e) => { await srv.close(); throw e })
        io.out(`listening on http://127.0.0.1:${(srv.server.address() as { port: number }).port}`)
        const regen = dev ? devRegenerate(apps, io) : undefined
        const stop = () => {
          process.off('SIGTERM', stop); process.off('SIGINT', stop)
          regen?.close()
          setTimeout(() => { io.err('tvine: close did not finish within 5 s; exiting'); io.exit(1) }, 5_000).unref()
          srv.close().then(() => io.exit(0), (e: unknown) => { io.err(`tvine: close failed: ${String(e)}`); io.exit(1) })
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
        return undefined
      }
      case 'inspect': {
        const port = o.port === undefined ? 7357 : Number(o.port)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port must be an integer 0-65535')
        // the app's dev dependency: node_modules walking up from cwd (not NODE_PATH, which pnpm shims point at
        // a hoisted store). warp never depends on @tvine/inspect.
        let dir = process.cwd()
        while (!existsSync(join(dir, 'node_modules/@tvine/inspect')) && dirname(dir) !== dir) dir = dirname(dir)
        if (!existsSync(join(dir, 'node_modules/@tvine/inspect'))) throw new Error('@tvine/inspect is not installed in this app: pnpm add -D @tvine/inspect')
        const url = pathToFileURL(createRequire(join(dir, 'package.json')).resolve('@tvine/inspect')).href
        const { startInspector } = (await import(url)) as { startInspector(o: { target: string; port: number }): Promise<{ url: string; close(): Promise<void> }> }
        const target = args[0] ?? `http://localhost:${process.env.PORT ?? 3000}`
        const ins = await startInspector({ target, port })
        io.out(`inspector on ${ins.url} -> ${target}`)
        const stop = () => {
          process.off('SIGTERM', stop); process.off('SIGINT', stop)
          ins.close().then(() => io.exit(0), () => io.exit(1))
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
        return undefined
      }
      case 'check': {
        const bad = await boundaryCheck(dirname(apps))
        if (bad.length) { io.err(boundaryReport(bad)); io.err(`tvine check: ${bad.length} frontend file(s) reach models/the ORM`); return 1 }
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        await srv.close()
        const url = srv.ctx.settings.db.url
        if (hasModels(apps) && !(await migrateCheck(url, apps))) { io.err(`tvine check: ${await pending(url, apps)}`); return 1 }
        io.out(`ok: ${srv.ctx.actions.all().length} actions`)
        return 0
      }
      case 'generate': {
        const root = dirname(apps), file = join(root, API_DTS)
        const text = await generateApiTypes(root, apps)
        const old = existsSync(file) ? readFileSync(file, 'utf8') : undefined
        if (o.check) {
          if (old === text) return 0
          io.err(`tvine generate --check: ${API_DTS} is ${old === undefined ? 'missing' : 'stale'} (run tvine generate)`)
          return 1
        }
        if (old !== text) writeFileSync(file, text)
        io.out(`${old === text ? 'unchanged' : 'wrote'} ${API_DTS}`)
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
        if (app !== undefined && !o.empty) throw new Usage('per-app makemigrations is only supported with --empty')
        if (o.empty && app === undefined) throw new Usage('--empty needs an app: tvine makemigrations <app> --empty')
        // Django: --check implies --dry-run and exits 1 when a migration is missing
        const dryRun = !!(o.check || o['dry-run'])
        const r = await makeMigrations(apps, { name: o.name as string | undefined, allowDrop: !!o['allow-drop'], merge: !!o.merge, empty: app, dryRun })
          .catch((e: Error) => { throw new Error(e.message.replace('pass allowDrop to confirm', 'pass --allow-drop to confirm')) })
        io.out(r.message)
        return o.check && r.files.length ? 1 : 0
      }
      case 'migrate': {
        if (args.length) throw new Error('rollback targets not supported — forward-only; see backlog (migrate <app> <target>)')
        if ([o.check, o.plan, o.fake].filter(Boolean).length > 1) throw new Usage('--check, --plan and --fake are exclusive')
        const url = (await loadSettings()).db.url
        if (o.check) {
          if (await migrateCheck(url, apps)) return 0
          io.err(`tvine migrate --check: ${await pending(url, apps)}`)
          return 1
        }
        const { applied } = await migrate(url, apps, { plan: !!o.plan, fake: !!o.fake })
        if (!applied.length) io.out('no migrations to apply')
        else if (o.plan) io.out(['planned:', ...applied.map((k) => `  ${k}`)].join('\n'))
        else io.out(applied.map((k) => `${o.fake ? 'faked' : 'applied'} ${k}`).join('\n'))
        return 0
      }
      case 'sqlmigrate': {
        const [app, name] = args as [string, string]
        const conn = openConn((await loadSettings()).db.url)   // the connected dialect, as Django does
        try { io.out(await sqlMigrate(apps, app, name, conn.dialect)) } finally { await conn.driver.close() }
        return 0
      }
      default: {   // showmigrations
        const rows = await showMigrations((await loadSettings()).db.url, apps)
        const lines: string[] = []
        for (const [i, r] of rows.entries()) {
          if (rows[i - 1]?.app !== r.app) lines.push(r.app)
          lines.push(` [${r.applied ? 'X' : ' '}] ${r.name}`)
        }
        io.out(lines.join('\n') || '(no migrations)')
        return 0
      }
    }
  } catch (e) {
    const err = e as Error
    io.err(`tvine ${cmd}: ${process.env.TVINE_DEBUG === '1' ? err.stack ?? err.message : err.message}`)
    if (e instanceof Usage) io.err(`run 'tvine' for usage`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code) })
}
