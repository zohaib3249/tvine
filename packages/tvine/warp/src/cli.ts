#!/usr/bin/env node
// tvine — Django-style management commands (server-index.md §CLI, models-db.md §Migration commands).
import { existsSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { appModule } from './core/actions.js'
import { installedApps, unlistedApps } from './core/apps.js'
import { connections, openConn } from './data/db.js'
import { discoverModels, makeMigrations, migrate, migrateCheck, userModelChanged, postMigrate, showMigrations, sqlMigrate } from './data/migrate.js'
import { dumpData, loadData, type FixtureRow } from './data/fixtures.js'
import { boundaryCheck, boundaryReport, unawaitedReads } from './cli/boundary.js'
import { API_DTS, generateApiTypes } from './cli/generate.js'
import { createAgentServer, loadSettings, type AgentServerOptions } from './server.js'
import type { Settings } from './core/types.js'
import { mcpEnabled } from './transport/mcp.js'
import { backendTable } from './backends/index.js'
import { rateOverlap, redisUsers } from './settings.js'
import { redis } from './redis/index.js'
import type { AddressInfo } from 'node:net'
import { defaultEnv, defaultNodeEnv, env, envReport, isProduction, loadDotenv } from './env.js'
import { describeMiddleware, lanIps } from './middleware/index.js'

export interface Io {
  out(s: string): void; err(s: string): void; exit(code: number): void
  prompt?(question: string, o?: { hidden?: boolean }): Promise<string>   // interactive commands (createsuperuser)
}
const stdio: Io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c), prompt: process.stdin.isTTY ? ttyPrompt : undefined }

// one line from the terminal; hidden: nothing typed is echoed (passwords)
async function ttyPrompt(question: string, o: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (o.hidden) (rl as unknown as { _writeToOutput(s: string): void })._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question) }
  try { return await rl.question(question) } finally { if (o.hidden) process.stdout.write('\n'); rl.close() }
}

const USAGE = `usage: tvine <command> [--apps ./apps] [--settings config/settings/prod]  (or TVINE_SETTINGS)

Project
  startproject <name> [dir] [--db sqlite|postgres|mysql] [--no-admin] [--no-tasks] [--pm pnpm|npm|yarn] [--no-install] [--local]
                                a ready-to-run project (--local: link this clone's packages; not on npm yet)
  startapp <name>                 apps/<name>/ empty stubs; adds it to installedApps and config/urls.ts
  check                         settings + actions + migrations + FE/DB boundary gate (exit 1 on problems)
  routes                        print the action manifest
  show_urls                     print the urls.ts routes: pattern, methods, name, action
  generate [--check]            write tvine-api.d.ts (api.* types); --check: exit 1 when it is stale

Database
  makemigrations [app] [--name x] [--allow-drop] [--merge] [--empty] [--check] [--dry-run]
  migrate [<app> [<target>|zero]] [--check] [--plan] [--fake]
                                <app>: forward to its latest; <target>: forward or ROLL BACK to it
  sqlmigrate <app> <migration> [--backwards]
  showmigrations
  dumpdata [app[.model] …] [--output f.json]   fixtures as JSON (fk order)
  loaddata <f.json> …           load fixtures in one transaction (upsert by pk)
  encryption rotate             re-encrypt every encrypted field with the newest key (settings.encryption.keys)

Run
  dev [--port 3000] [--host h]  runserver: in-process next dev (needs next installed)
  build                         next build (the pages tvine start serves)
  start [--port 3000] [--host h] [--api-only]  serve (SIGTERM/SIGINT: graceful close, hard exit at 5 s);
                                --api-only: no frontend (Next runs separately with TVINE_API_URL)
  shell                         Node REPL: settings loaded, db configured, every model by name
  test [vitest args]            vitest run

Users
  createsuperuser [--username u] [--email e] [--noinput]   (tvine.auth; --noinput reads TVINE_SUPERUSER_USERNAME/_EMAIL/_PASSWORD)
  changepassword <username>                                 (tvine.auth)
  privacy export|erase <user>   tvine.auth: a user's data as JSON (--output file) / anonymize it (--yes)

Jobs
  worker [--queues a,b] [--concurrency 10] [--beat] [--name x] [--grace ms]   tvine.tasks: run jobs
                                (SIGTERM: stop claiming, finish or release running jobs within the grace)
  tasks list [--status s] [--queue q] [--limit n] | inspect <id> | retry <id> | purge --dead | compact
        | bench [--jobs n] [--workers n] [--batch n]   (the configured broker's raw jobs/s)
  audit prune [--days n]        tvine.audit: delete rows older than n days (default settings.audit.retentionDays)
  shield mode off|log|enforce | shield rules disable <id>|--all   tvine.shield escape hatch (running servers pick it up within 3 s)
  shield lists | shield lists remove <value>|--all   show / remove allow-deny entries (e.g. your own IP denied by mistake)
  shield simulate [--count n=300] [--hours h=24] | --clear   dev only (debug): synthetic traffic tagged host simulated.tvine

Tools
  inspect [url] [--port 7357]   split-view devtool on 127.0.0.1 (dev only)
  docs [--ai [--path]]          the guides' URL; --ai: the AI-assistant guide (AGENTS.md), --path: its file path`

type Opts = NonNullable<ParseArgsConfig['options']>
const bool = { type: 'boolean' } as const, str = { type: 'string' } as const
// per command: its own flags and how many positionals it takes
const COMMANDS: Record<string, { options: Opts; args: [min: number, max: number] }> = {
  startproject: { options: { db: str, 'no-admin': bool, 'no-tasks': bool, pm: str, 'no-install': bool, local: bool }, args: [1, 2] },
  startapp: { options: {}, args: [1, 1] },
  build: { options: {}, args: [0, 0] },
  shell: { options: {}, args: [0, 0] },
  start: { options: { port: str, host: str, 'api-only': bool }, args: [0, 0] },
  dev: { options: { port: str, host: str }, args: [0, 0] },
  inspect: { options: { port: str }, args: [0, 1] },
  docs: { options: { ai: bool, path: bool }, args: [0, 0] },
  check: { options: {}, args: [0, 0] },
  routes: { options: {}, args: [0, 0] },
  show_urls: { options: {}, args: [0, 0] },
  generate: { options: { check: bool }, args: [0, 0] },
  makemigrations: { options: { name: str, 'allow-drop': bool, merge: bool, empty: bool, check: bool, 'dry-run': bool }, args: [0, 1] },
  migrate: { options: { check: bool, plan: bool, fake: bool }, args: [0, 2] },
  sqlmigrate: { options: { backwards: bool }, args: [2, 2] },
  showmigrations: { options: {}, args: [0, 0] },
  dumpdata: { options: { output: str }, args: [0, Infinity] },
  loaddata: { options: {}, args: [1, Infinity] },
  createsuperuser: { options: { username: str, email: str, noinput: bool }, args: [0, 0] },
  changepassword: { options: {}, args: [1, 1] },
  worker: { options: { queues: str, concurrency: str, beat: bool, name: str, grace: str }, args: [0, 0] },
  tasks: { options: { status: str, queue: str, limit: str, dead: bool, jobs: str, workers: str, batch: str }, args: [0, 2] },
  audit: { options: { days: str }, args: [1, 1] },
  shield: { options: { all: bool, count: str, hours: str, clear: bool }, args: [1, 3] },
  encryption: { options: {}, args: [1, 1] },
  privacy: { options: { output: str, yes: bool }, args: [2, 2] },
}

class Usage extends Error {}

const relativeTo = (p: string) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p }
// a project binary (node_modules/.bin walking up from cwd) or, with onPath, a command on PATH; inherits the terminal
function binRun(name: string, args: string[], io: Io, cwd = process.cwd(), onPath = false): Promise<number> {
  let bin = name
  if (!onPath) {
    let dir = cwd
    while (!existsSync(join(dir, 'node_modules/.bin', name)) && dirname(dir) !== dir) dir = dirname(dir)
    bin = join(dir, 'node_modules/.bin', name)
    if (!existsSync(bin)) { io.err(`tvine: ${name} is not installed in this project`); return Promise.resolve(1) }
  }
  return new Promise((ok) => spawn(bin, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).on('exit', (c) => ok(c ?? 1)).on('error', (e) => { io.err(`tvine: ${e.message}`); ok(1) }))
}

// .env files (env.md): real environment variables beat them all (loadEnvFile never overrides)
const loadEnv = () => { loadDotenv() }
// the address the server really listens on (not a guess): http://127.0.0.1:3000, http://[::]:3000, …
// (every interface: a usable localhost url, then what it is really bound to)
export function boundUrl(a: AddressInfo): string {
  const v6 = a.family === 'IPv6' || a.family === (6 as never)
  const shown = v6 ? `[${a.address}]` : a.address
  return a.address === '::' || a.address === '0.0.0.0' ? `http://localhost:${a.port} (bound to ${shown}, every interface)` : `http://${shown}:${a.port}`
}

// listen on port; auto: when it is busy try port+1 … port+20. Returns the port it got.
export async function listenFree(listen: (port: number) => Promise<void>, port: number, auto: boolean): Promise<number> {
  for (let at = port; ; at++) {
    try { await listen(at); return at } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      if (!auto || at === 0 || at >= port + 20) throw new Error(`port ${at} is in use${auto ? ` (tried ${port}-${at})` : ''}: stop what is using it or pass another --port`)
    }
  }
}

// next dev's lock ({pid, port, …}) for this project. A server that really holds a port → the line to print
// (its real listening port, since older locks recorded 3000 whatever port was bound). Gone, a zombie
// (exited, parent not reaping), or holding no port → stale: the lock is removed and dev starts normally.
export function devRunning(lock = '.next/dev/lock'): string | undefined {
  let pid: number, port: number | undefined
  try { ({ pid, port } = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; port?: number }) } catch { return undefined }
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const stale = () => { rmSync(lock, { force: true }); return undefined }
  try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return stale() }
  let state = ''
  if (process.platform !== 'win32') {
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return stale() }
    if (!state || state.startsWith('Z')) return stale()
    try {
      const out = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const bound = Number(/^n.*:(\d+)$/m.exec(out)?.[1])
      if (!bound) return stale()
      port = bound
    } catch { return stale() }   // lsof exits 1 when the pid holds no listening socket
  }
  if (state.startsWith('T')) {
    return `tvine dev for this project is PAUSED (pid ${pid}, stopped with Ctrl+Z) and still holds http://localhost:${port}: ` +
      `resume it with 'fg' in its terminal, or stop it with: kill -9 ${pid}  (use Ctrl+C to stop a dev server)`
  }
  const kill = process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`
  return `tvine dev is already running for this project (pid ${pid})${port ? ` at http://localhost:${port}` : ''}; stop it with: ${kill}`
}

// a built Next app in cwd is served; otherwise API-only
const frontend = (): AgentServerOptions['frontend'] =>
  existsSync('.next/app-path-routes-manifest.json') ? { nextDir: resolve('.next') } : undefined
const hasModels = (apps: string, installed: readonly string[]) =>
  installedApps(apps, installed).some((a) => appModule(a.dir, 'models') !== undefined)

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()).join('\n')
}

// what migrate --check / check report when the database is not clean
async function pending(url: string, apps: string, installed: readonly string[]): Promise<string> {
  const open = (await showMigrations(url, apps, { installed })).filter((m) => !m.applied).map((m) => `${m.app}.${m.name}`)
  return open.length ? `pending: ${open.join(', ')} (run tvine migrate)` : 'models.ts changed since the last migration (run tvine makemigrations)'
}

// tvine dev: on change, regenerate tvine-api.d.ts (apps/*/{views,serializers}; a child process, because
// this one's ESM cache keeps the old modules) and re-run the FE/DB boundary check (esbuild reads from disk).
// ponytail: fs.watch recursive (Node >= 20); the Next error overlay / withTvine build gate are not wired yet
function devWatch(apps: string, io: Io): { close(): void } {
  const root = dirname(apps)
  const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
  const later = (k: string, fn: () => void) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, 200) }
  const regen = () => spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'generate', '--apps', apps], { stdio: ['ignore', 'ignore', 'pipe'] })
    .stderr.on('data', (b: Buffer) => io.err(b.toString().trimEnd()))
  const check = () => void boundaryCheck(root).then((v) => { if (v.length) io.err(boundaryReport(v)) }, (e: unknown) => io.err(`tvine: boundary check failed: ${String(e)}`))
  const w = watch(root, { recursive: true }, (_e, f) => {
    const p = String(f ?? '')
    if (!p || /(^|[\\/])(node_modules|\.next|\.git|dist)([\\/]|$)/.test(p) || !/\.(m?[jt]sx?)$/.test(p)) return
    if (join(root, p).startsWith(apps) && /(^|[\\/])(views|serializers)\.(m?[jt]s)$/.test(p)) later('gen', regen)
    later('check', check)
  })
  return { close: () => { for (const t of Object.values(timers)) clearTimeout(t); w.close() } }
}

export async function main(argv: string[], io: Io = stdio): Promise<number | undefined> {
  const [cmd, ...rest] = argv
  if (cmd === 'test') return await binRun('vitest', ['run', ...rest], io)   // vitest flags pass through untouched
  const spec = cmd === undefined ? undefined : COMMANDS[cmd]
  if (!spec) { io.err(USAGE); return 1 }
  try {
    let parsed
    try { parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { apps: { type: 'string', default: 'apps' }, settings: { type: 'string' }, ...spec.options } }) }
    catch (e) { const m = (e as Error).message.replace(/\. To specify a positional.*$/s, ''); throw new Usage(m[0]!.toLowerCase() + m.slice(1)) }
    const o = parsed.values as Record<string, string | boolean | undefined> & { apps: string }
    const args = parsed.positionals
    if (args.length > spec.args[1]) throw new Usage(`unexpected argument '${args[spec.args[1]]}'`)
    if (args.length < spec.args[0]) throw new Usage(cmd === 'startproject' || cmd === 'startapp' ? `usage: tvine ${cmd} <name>` : cmd === 'changepassword' ? 'usage: tvine changepassword <username>' : cmd === 'loaddata' ? 'usage: tvine loaddata <fixture.json> …' : `usage: tvine ${cmd} <app> <migration>`)
    const apps = resolve(o.apps)
    if (typeof o.settings === 'string') process.env.TVINE_SETTINGS = o.settings   // DJANGO_SETTINGS_MODULE / --settings
    loadEnv()
    switch (cmd) {
      case 'startproject': {
        const { startProject } = await import('./cli/scaffold.js')
        const pm = (o.pm as string | undefined) ?? 'pnpm'
        const r = startProject({ name: args[0]!, dir: args[1], db: o.db as string | undefined, admin: !o['no-admin'], tasks: !o['no-tasks'], pm, local: !!o.local })
        io.out(`created ${r.dir} (${r.files.length} files)`)
        if (!o['no-install']) {
          io.out(`${pm} install …`)
          if (await binRun(pm, ['install'], io, r.dir, true) !== 0) io.err(`tvine startproject: ${pm} install failed; run it yourself`)
        }
        const x = pm === 'npm' ? 'npx' : pm
        io.out(['', 'next steps:', `  cd ${relativeTo(r.dir)}`, ...(o['no-install'] ? [`  ${pm} install`] : []),
          `  ${x} tvine migrate`, `  ${x} tvine createsuperuser`, `  ${x} tvine dev          # http://localhost:3000`,
          `  ${x} tvine startapp blog`].join('\n'))
        return 0
      }
      case 'docs': {
        const guide = fileURLToPath(new URL('../../AGENTS.md', import.meta.url))   // packages/tvine/AGENTS.md (from src or dist)
        io.out(!o.ai ? 'https://github.com/zohaib3249/tvine/blob/main/docs/README.md' : o.path ? guide : readFileSync(guide, 'utf8'))
        return 0
      }
      case 'startapp': {
        const { startApp } = await import('./cli/scaffold.js')
        const r = startApp(apps, args[0]!)
        const name = args[0]!, at = (f?: string) => f ? relativeTo(f) : 'your settings'
        io.out(`created ${relativeTo(r.dir)}/: ${r.files.join(', ')}`)
        const s = r.settings, u = r.urls
        io.out(s.status === 'added' ? `added '${name}' to installedApps (${at(s.file)})` : s.status === 'present' ? `'${name}' is already in installedApps (${at(s.file)})` : `add to installedApps in ${at(s.file)}: ${s.line}`)
        io.out(u.status === 'added' ? `added ${name}/ to ${at(u.file)}` : u.status === 'present' ? `${at(u.file)} already includes ${name}.urls` : `add to urlpatterns in ${u.file ? at(u.file) : 'config/urls.ts'}: ${u.line}`)
        io.out('next: write models in models.ts, then tvine makemigrations && tvine migrate')
        return 0
      }
      case 'build': return await binRun('next', ['build'], io)
      case 'shell': {
        const settings = await loadSettings()
        connections.configure(settings)
        const models = Object.values(await discoverModels(apps, { installed: settings.installedApps })).flat()
        const repl = await import('node:repl')
        const r = repl.start({ prompt: 'tvine> ' })
        r.context.settings = settings
        for (const m of models) r.context[m.name[0]!.toUpperCase() + m.name.slice(1).replace(/_(\w)/g, (_, c: string) => c.toUpperCase())] = m
        io.out(`models: ${models.map((m) => m.name).join(', ') || '(none)'} (await works: await Post.objects.all())`)
        r.on('exit', () => { void connections.closeAll().then(() => io.exit(0)) })
        return undefined
      }
      case 'start':
      case 'dev': {
        const port = o.port === undefined ? env.int('PORT', 3000) : Number(o.port)
        const host = (o.host as string | undefined) ?? (env.has('HOST') ? env.str('HOST') : undefined)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port must be an integer 0-65535')
        const dev = cmd === 'dev'
        // like `next start`: start means production unless NODE_ENV says otherwise (stable secret, no inspector feed)
        if (!dev) defaultNodeEnv('production')   // empty (NODE_ENV=) counts as unset
        if (dev && isProduction()) throw new Usage('tvine dev is for development; use tvine start in production')
        if (dev) defaultEnv('TVINE_DEBUG', '1')   // runserver = DEBUG on (dev CSP, inspector feed), unless TVINE_DEBUG says no
        const running = dev ? devRunning() : undefined
        if (running) { io.err(running); return 1 }
        const srv = await createAgentServer({ appsDir: apps, dev, frontend: dev ? { nextDir: resolve('.next') } : o['api-only'] ? undefined : frontend() })
        // dev, port not forced (--port / PORT): a busy port moves to the next free one, like next dev
        const at = await listenFree((p) => srv.listen(p, host), port, dev && o.port === undefined && !env.has('PORT')).catch(async (e) => { await srv.close(); throw e })
        if (at !== port) io.out(`port ${port} in use, using ${at}`)
        const addr = srv.server.address() as AddressInfo
        io.out(`listening on ${boundUrl(addr)}`)
        if (dev && (host === undefined || host === '0.0.0.0' || host === '::')) {
          io.out(`  Local:   http://localhost:${addr.port}`)
          for (const ip of lanIps()) io.out(`  Network: http://${ip}:${addr.port}`)
        }
        const regen = dev ? devWatch(apps, io) : undefined
        const stop = () => {
          process.off('SIGTERM', stop); process.off('SIGINT', stop)
          regen?.close()
          setTimeout(() => { io.err('tvine: close did not finish within 5 s; exiting'); io.exit(1) }, 5_000).unref()
          srv.close().then(() => io.exit(0), (e: unknown) => { io.err(`tvine: close failed: ${String(e)}`); io.exit(1) })
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
        return undefined
      }
      case 'worker': {
        const { workerCommand } = await import('./contrib/tasks/cli.js')
        return await workerCommand(apps, await loadSettings(), o, io)
      }
      case 'tasks': {
        const { tasksCommand } = await import('./contrib/tasks/cli.js')
        return await tasksCommand(apps, await loadSettings(), args, o, io)
      }
      case 'audit': {
        if (args[0] !== 'prune') throw new Usage('usage: tvine audit prune [--days n]')
        const settings = await loadSettings()
        if (!settings.installedApps.includes('tvine.audit')) throw new Usage("tvine.audit is not installed: add 'tvine.audit' to settings.installedApps")
        const days = o.days === undefined ? settings.audit.retentionDays : Number(o.days)
        if (!Number.isInteger(days) || days < 0) throw new Usage('--days must be an integer >= 0')
        const { connections } = await import('./data/db.js')
        connections.configure(settings)
        const { pruneAudit } = await import('./contrib/audit/prune.js')
        try { io.out(`deleted ${await pruneAudit(days)} audit row(s) older than ${days} day(s)`) } finally { await connections.closeAll() }
        return undefined
      }
      case 'shield': {
        const settings = await loadSettings()
        if (!settings.installedApps.includes('tvine.shield')) throw new Usage("tvine.shield is not installed: add 'tvine.shield' to settings.installedApps")
        const { connections } = await import('./data/db.js')
        connections.configure(settings)
        const { shieldCommand } = await import('./contrib/shield/store.js')
        try { io.out(await shieldCommand(settings, args, { all: !!o.all, clear: !!o.clear, count: o.count as string | undefined, hours: o.hours as string | undefined })) } catch (e) { throw new Usage((e as Error).message) } finally { await connections.closeAll() }
        return undefined
      }
      case 'encryption': {
        if (args[0] !== 'rotate') throw new Usage('usage: tvine encryption rotate')
        const settings = await loadSettings()
        connections.configure(settings)
        const { rotateEncryption } = await import('./security/rotate.js')
        try {
          const models = Object.values(await discoverModels(apps, { installed: settings.installedApps })).flat()
          io.out(`re-encrypted ${await rotateEncryption(models, io.out)} row(s) with the newest key`)
        } finally { await connections.closeAll() }
        return 0
      }
      case 'privacy': {
        const [what, username] = args as [string, string]
        if (what !== 'export' && what !== 'erase') throw new Usage('usage: tvine privacy export|erase <username>')
        const settings = await loadSettings()
        if (!settings.installedApps.includes('tvine.auth')) throw new Usage("tvine.auth is not installed: add 'tvine.auth' to settings.installedApps")
        connections.configure(settings)
        try {
          await discoverModels(apps, { installed: settings.installedApps })   // every model registered (Meta.personalData)
          const { getUserModel, userMeta } = await import('./contrib/auth/models.js')
          const User = getUserModel()
          const { exportData, eraseData } = await import('./contrib/auth/privacy.js')
          const u = await User.objects.filter({ [userMeta().usernameField]: username }).first()
          if (!u) throw new Usage(`no user named ${username}`)
          if (what === 'export') {
            const json = JSON.stringify(await exportData(u.id), null, 2)
            if (o.output) { writeFileSync(o.output as string, json + '\n', { mode: 0o600 }); io.out(`wrote ${o.output}`) } else io.out(json)
          } else {
            if (!o.yes) throw new Usage('erase cannot be undone: pass --yes')
            io.out(`erased user ${u.id}: ${JSON.stringify(await eraseData(u.id, { settings }))}`)
          }
        } finally { await connections.closeAll() }
        return 0
      }
      case 'inspect': {
        const port = o.port === undefined ? 7357 : Number(o.port)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port must be an integer 0-65535')
        const { startInspector } = await import('../../inspect/dist/index.js')
        const target = args[0] ?? `http://localhost:${env.int('PORT', 3000)}`
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
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        // which backend each subsystem runs on (one settings file drives them all), and every redis alias in use answers
        // Django MIDDLEWARE as it will run, outermost first; which env vars are set (names only, never values)
        io.out(`middleware: ${describeMiddleware(srv.ctx.middleware as never).join(' > ') || '(none)'}`)
        io.out(`action middleware: ${srv.ctx.settings.actionMiddleware.length} global`)
        io.out(`env set: ${envReport().filter((e) => e.set).map((e) => e.name).join(', ') || '(none)'}`)
        for (const r of backendTable(srv.ctx.settings)) io.out(`backend ${r.key} = ${r.backend}${r.redis ? ` (settings.redis.${r.redis})` : ''}`)
        io.out(metricsLine(srv.ctx.settings.metrics))
        let down = false
        for (const alias of new Set(redisUsers(srv.ctx.settings).map((u) => u.alias))) {
          const p = await redis.ping(alias)
          if (p.ok) io.out(`redis ${alias}: ok (${p.ms} ms)`); else { io.err(`tvine check: redis ${alias}: ${p.error}`); down = true }
        }
        await srv.close()
        if (down) return 1
        const bad = await boundaryCheck(dirname(apps))
        const level = srv.ctx.settings.frontend.boundary   // 'warn': report, don't fail
        if (bad.length) {
          io.err(boundaryReport(bad, level))
          io.err(`tvine check: ${bad.length} frontend file(s) reach models/the ORM${level === 'warn' ? ' (settings.frontend.boundary = warn)' : ''}`)
          if (level === 'error') return 1
        }
        for (const l of unawaitedReads(apps)) io.err(`tvine check: warning: ORM read without await (a Promise, not rows): ${l}`)
        const { url } = srv.ctx.settings.db, installed = srv.ctx.settings.installedApps
        for (const a of unlistedApps(apps, installed)) io.err(`tvine check: warning: app '${a}' exists but is not in installedApps`)
        const overlap = rateOverlap(srv.ctx.settings)
        if (overlap) io.err(`tvine check: warning: ${overlap}`)
        const swapped = installed.includes('tvine.auth') ? await userModelChanged(url, apps, { installed }) : undefined
        if (swapped) { io.err(`tvine check: ${swapped}`); return 1 }
        if (hasModels(apps, installed) && !(await migrateCheck(url, apps, { installed }))) { io.err(`tvine check: ${await pending(url, apps, installed)}`); return 1 }
        io.out(`ok: ${srv.ctx.actions.all().length} actions`)
        return 0
      }
      case 'generate': {
        const root = dirname(apps), file = join(root, API_DTS)
        const text = await generateApiTypes(root, apps, (await loadSettings()).installedApps)
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
        // which backend each subsystem runs on (one settings file drives them all), and every redis alias in use answers
        for (const r of backendTable(srv.ctx.settings)) io.out(`backend ${r.key} = ${r.backend}${r.redis ? ` (settings.redis.${r.redis})` : ''}`)
        let down = false
        for (const alias of new Set(redisUsers(srv.ctx.settings).map((u) => u.alias))) {
          const p = await redis.ping(alias)
          if (p.ok) io.out(`redis ${alias}: ok (${p.ms} ms)`); else { io.err(`tvine check: redis ${alias}: ${p.error}`); down = true }
        }
        await srv.close()
        if (down) return 1
        const { actions, settings } = srv.ctx
        io.out(table([['action', 'app', 'params', 'permissions', 'mcp'], ...actions.all().map((d) => [
          d.id, d.id.slice(0, d.id.indexOf('.')),
          actions.paramSpecs(d.id).map((p) => p.name + (p.required ? '' : '?')).join(', ') || '-',
          (d.rules?.permissions ?? []).map((p) => p.name || 'fn').join(', ') || '-',
          mcpEnabled(d, settings) ? 'yes' : 'no',
        ])]))
        return 0
      }
      case 'show_urls': {   // django-extensions show_urls: the project's urls.ts, resolved
        const srv = await createAgentServer({ appsDir: apps, frontend: frontend() })
        await srv.close()
        const rows = srv.urls?.routes.map((r) => [r.pattern, [...r.methods.keys()].join(','), r.name ?? '-', [...new Set([...r.methods.values()].map((d) => d.id))].join(', ')]) ?? []
        if (!rows.length) { io.out('no urls.ts routes (actions answer at /tvine/api/<app>.<name>)'); return 0 }
        io.out(table([['pattern', 'methods', 'name', 'action'], ...rows]))
        return 0
      }
      case 'makemigrations': {
        const [app] = args
        if (app !== undefined && !o.empty) throw new Usage('per-app makemigrations is only supported with --empty')
        if (o.empty && app === undefined) throw new Usage('--empty needs an app: tvine makemigrations <app> --empty')
        // Django: --check implies --dry-run and exits 1 when a migration is missing
        const dryRun = !!(o.check || o['dry-run'])
        const { installedApps: installed } = await loadSettings()
        const r = await makeMigrations(apps, { installed, name: o.name as string | undefined, allowDrop: !!o['allow-drop'], merge: !!o.merge, empty: app, dryRun })
          .catch((e: Error) => { throw new Error(e.message.replace('pass allowDrop to confirm', 'pass --allow-drop to confirm')) })
        io.out(r.message)
        return o.check && r.files.length ? 1 : 0
      }
      case 'migrate': {
        const [app, target] = args as [string | undefined, string | undefined]
        if ([o.check, o.plan, o.fake].filter(Boolean).length > 1) throw new Usage('--check, --plan and --fake are exclusive')
        if (o.check && app !== undefined) throw new Usage('--check takes no app / target')
        const settings = await loadSettings()
        const { url } = settings.db, installed = settings.installedApps
        if (o.check) {
          if (await migrateCheck(url, apps, { installed })) return 0
          io.err(`tvine migrate --check: ${await pending(url, apps, installed)}`)
          return 1
        }
        const { applied, unapplied } = await migrate(url, apps, { plan: !!o.plan, fake: !!o.fake, installed, app, target })
        if (unapplied?.length) {
          io.out(o.plan ? ['planned rollback:', ...unapplied.map((k) => `  ${k}`)].join('\n') : unapplied.map((k) => `${o.fake ? 'faked unapply' : 'unapplied'} ${k}`).join('\n'))
          return 0
        }
        if (!o.plan) {   // post_migrate: apps' hooks.ts postMigrate (tvine.auth: permission rows) through the ORM
          connections.configure(settings)
          try { await postMigrate(apps, applied, { installed }) } finally { await connections.closeAll() }
        }
        if (!applied.length) io.out('no migrations to apply')
        else if (o.plan) io.out(['planned:', ...applied.map((k) => `  ${k}`)].join('\n'))
        else io.out(applied.map((k) => `${o.fake ? 'faked' : 'applied'} ${k}`).join('\n'))
        return 0
      }
      case 'sqlmigrate': {
        const [app, name] = args as [string, string]
        const settings = await loadSettings()
        const conn = openConn(settings.db.url)   // the connected dialect, as Django does
        try { io.out(await sqlMigrate(apps, app, name, conn.dialect, { installed: settings.installedApps, backwards: !!o.backwards })) } finally { await conn.driver.close() }
        return 0
      }
      case 'dumpdata': case 'loaddata': {
        const settings = await loadSettings()
        connections.configure(settings)
        try {
          const models = await discoverModels(apps, { installed: settings.installedApps })
          if (cmd === 'dumpdata') {
            const json = JSON.stringify(await dumpData(models, args), null, 2)
            if (o.output) { writeFileSync(o.output as string, json + '\n'); io.out(`wrote ${o.output}`) } else io.out(json)
          } else {
            const rows = args.flatMap(f => JSON.parse(readFileSync(f, 'utf8')) as FixtureRow[])
            const n = await loadData(models, rows)   // every file in ONE transaction
            io.out(`installed ${n} object(s) from ${args.length} fixture(s)`)
          }
        } finally { await connections.closeAll() }
        return 0
      }
      case 'createsuperuser':
      case 'changepassword': {
        const settings = await loadSettings()
        if (!settings.installedApps.includes('tvine.auth')) throw new Error("tvine.auth is not installed: add 'tvine.auth' to settings.installedApps")
        const m = await import('./contrib/auth/management.js')
        await discoverModels(apps, { installed: settings.installedApps })   // a custom settings.auth.userModel
        connections.configure(settings)
        try {
          return cmd === 'createsuperuser'
            ? await m.createsuperuser({ username: o.username as string | undefined, email: o.email as string | undefined, noinput: !!o.noinput, settings, prompt: io.prompt }, io)
            : await m.changepassword({ username: args[0]!, settings, prompt: io.prompt }, io)
        } finally { await connections.closeAll() }
      }
      default: {   // showmigrations
        const settings = await loadSettings()
        const rows = await showMigrations(settings.db.url, apps, { installed: settings.installedApps })
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
    io.err(`tvine ${cmd}: ${/^(1|true|yes|on)$/i.test(env.str('TVINE_DEBUG', '')) ? err.stack ?? err.message : err.message}`)
    if (e instanceof Usage) io.err(`run 'tvine' for usage`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code) })
}

// `tvine check`: the metrics endpoint and its guard (the token itself is never printed)
export function metricsLine(m: Settings['metrics']): string {
  if (!m.enabled) return 'metrics: off'
  const guard = [m.token && 'bearer token', m.allowIps.length && `allowIps (${m.allowIps.length})`].filter(Boolean).join(' or ') || 'loopback only'
  return `metrics: on at ${m.path} (${guard})`
}
