#!/usr/bin/env node
// tvine — management commands (server-index.md §CLI, models-db.md §Migration commands).
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
import { createAgentServer, loadSettings, settingsFiles, type AgentServerOptions } from './server.js'
import type { Settings } from './core/types.js'
import { backendTable } from './backends/index.js'
import { customKeyWarnings, rateOverlap, redisUsers } from './settings.js'
import { redis } from './redis/index.js'
import type { AddressInfo } from 'node:net'
import { defaultEnv, defaultNodeEnv, env, envReport, isProduction, loadDotenv } from './env.js'
import { describeMiddleware, lanIps } from './middleware/index.js'
import { closest, commandHelp, COMMANDS, flagsHelp, GLOBAL_FLAGS, usageText, type Flag } from './cli/spec.js'

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

// every command, its flags, defaults, help and examples: cli/spec.ts (also generates docs/cli.md's reference)
const options = (flags: Record<string, Flag>): Opts => Object.fromEntries(Object.entries(flags).map(([n, f]) => [n, { type: f.type }]))
type Opts = NonNullable<ParseArgsConfig['options']>

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
  // an autoreload child: the supervisor (its parent, same `tvine dev` command line) is the one to stop
  if (process.platform !== 'win32') {
    try {
      const ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', ppid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (/tvine\S*\s+dev\b/.test(cmd)) pid = Number(ppid)
    } catch { /* parent gone: report the child */ }
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

const retryBusy = async <T>(fn: () => Promise<T>, tries = 30): Promise<T> => {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) { if (i >= tries || !/is in use/.test((e as Error).message)) throw e }
    await new Promise((ok) => setTimeout(ok, 100))
  }
}

// tvine dev (autoreload): pick the port here (busy → next free, when not forced), then run the server as a child
// on exactly that port, restarted on every backend change. Ctrl+C / SIGTERM: stop the child, exit 0.
async function devSupervisor(argv: string[], apps: string, port: number, host: string | undefined, auto: boolean, io: Io): Promise<undefined> {
  const { createServer } = await import('node:net')
  const probe = (p: number) => new Promise<void>((ok, bad) => { const s = createServer().once('error', bad); s.listen(p, host, () => s.close(() => ok())) })
  const at = port === 0 ? 0 : await listenFree(probe, port, auto)
  if (at !== port) io.out(`port ${port} in use, using ${at}`)
  const { supervise, linkedDists } = await import('./cli/autoreload.js')
  const root = process.cwd()
  const sup = supervise({ root, apps, cmd: [process.execPath, ...process.execArgv, process.argv[1]!, ...argv, '--port', String(at)], out: io.out, err: io.err, dists: linkedDists(root) })
  io.out('tvine dev: watching for changes (server restarts on any backend file; pages hot-reload)')
  const stop = () => {
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
    void sup.close().then(() => { devRunning(); io.exit(0) })   // devRunning drops a lock the killed child left behind
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  return undefined
}

export async function main(argv: string[], io: Io = stdio): Promise<number | undefined> {
  const [cmd, ...rest] = argv
  const isHelp = (a: string) => a === '--help' || a === '-h'
  // help: `tvine help [cmd]`, `tvine --help`, `tvine <cmd> --help` / -h anywhere on the line (the command never runs)
  if (cmd === undefined) { io.err(usageText()); return 1 }
  if (isHelp(cmd) || (cmd === 'help' && !rest.length)) { io.out(usageText()); return 0 }
  const name = cmd === 'help' && !isHelp(rest[0]!) ? rest[0]! : cmd
  const spec = COMMANDS[name]
  if (!spec) {
    const near = closest(name, Object.keys(COMMANDS))
    io.err(`tvine: unknown command '${name}'${near ? `. Did you mean: tvine ${near}?` : ''}\n\n${usageText()}`)
    return 1
  }
  if (cmd === 'help' || rest.some(isHelp)) { io.out(commandHelp(name)); return 0 }
  if (spec.passthrough) return await binRun('vitest', ['run', ...rest], io)   // tvine test: vitest flags pass through untouched
  try {
    let parsed
    const { help: _, ...global } = GLOBAL_FLAGS
    try { parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { ...options(global), apps: { type: 'string', default: 'apps' }, ...options(spec.flags) } }) }
    catch (e) {
      const m = (e as Error).message.replace(/\. To specify a positional.*$/s, '')
      const bad = (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? /'(-[^']+)'/.exec(m)?.[1] : undefined
      const near = bad && closest(bad.replace(/^-+/, ''), Object.keys({ ...spec.flags, ...GLOBAL_FLAGS }))
      io.err(`tvine ${cmd}: ${m[0]!.toLowerCase() + m.slice(1)}${near ? `. Did you mean --${near}?` : ''}\n${flagsHelp(cmd)}`)
      return 1
    }
    const o = parsed.values as Record<string, string | boolean | undefined> & { apps: string }
    const args = parsed.positionals
    if (args.length > spec.args[1]) throw new Usage(`unexpected argument '${args[spec.args[1]]}'`)
    if (args.length < spec.args[0]) throw new Usage(cmd === 'startproject' || cmd === 'startapp' ? `usage: tvine ${cmd} <name>` : cmd === 'changepassword' ? 'usage: tvine changepassword <username>' : cmd === 'loaddata' ? 'usage: tvine loaddata <fixture.json> …' : `usage: tvine ${cmd} <app> <migration>`)
    const apps = resolve(o.apps)
    if (typeof o.settings === 'string') process.env.TVINE_SETTINGS = o.settings   // --settings
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
        const withWorker = !!o['with-worker']
        if (!withWorker && (o.concurrency !== undefined || o.beat)) throw new Usage('--concurrency and --beat go with --with-worker (or run them in a job worker: tvine worker --beat)')
        const concurrency = o.concurrency === undefined ? undefined : Number(o.concurrency)
        if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) throw new Usage('--concurrency must be an integer >= 1')
        // like `next start`: start means production unless NODE_ENV says otherwise (stable secret, no inspector feed)
        if (!dev) defaultNodeEnv('production')   // empty (NODE_ENV=) counts as unset
        if (dev && isProduction()) throw new Usage('tvine dev is for development; use tvine start in production')
        if (dev) defaultEnv('TVINE_DEBUG', '1')   // runserver = DEBUG on (dev CSP, inspector feed), unless TVINE_DEBUG says no
        const child = dev && process.env.TVINE_DEV_CHILD === '1'   // the autoreload supervisor's server process
        const ppid = process.ppid
        const running = dev && !child ? devRunning() : undefined
        if (running) { io.err(running); return 1 }
        const auto = dev && o.port === undefined && !env.has('PORT')
        if (dev && !child && !o.noreload) return await devSupervisor(argv, apps, port, host, auto, io)
        const worker = process.env.TVINE_WORKER   // a `tvine start --workers n` worker (the primary forked it)
        if (!dev && !worker) {
          const w = await import('./cli/workers.js')
          let n: number
          try { n = w.workerCount(o.workers as string | undefined, env.has('WEB_CONCURRENCY') ? env.str('WEB_CONCURRENCY') : undefined) } catch (e) { throw new Usage((e as Error).message) }
          if (n > 1) {
            const settings = await loadSettings()
            const bad = w.sharedStateProblem(settings, n, relativeTo(settingsFiles()[0] ?? 'config/settings/prod.ts')) ?? await w.pingRedis(settings)
            if (bad) { io.err(bad); return 1 }
            if (withWorker && !settings.installedApps.includes('tvine.tasks')) throw new Usage("--with-worker runs background jobs: add 'tvine.tasks' to settings.installedApps")
            if (withWorker) io.out('tvine start: --with-worker: web worker 1 runs the job worker' + (o.beat ? ' and the scheduler' : '') + '; the other web workers serve requests only')
            // the slot running jobs gets their grace to finish before the primary gives up on it
            w.runPrimary(n, io, withWorker ? settings.tasks.graceMs + 5_000 : undefined)
            return undefined
          }
          const warn = env.has('NODE_APP_INSTANCE') || env.has('pm_id') ? undefined : w.coresWarning(n)   // pm2 runs its own instances
          if (warn) io.err(warn)
        }
        const srv = await createAgentServer({ appsDir: apps, dev, frontend: dev ? { nextDir: resolve('.next') } : o['api-only'] ? undefined : frontend() })
        // dev, port not forced (--port / PORT): a busy port moves to the next free one, like next dev.
        // A restarted child gets its port forced: the old one may still be letting go of it, so retry briefly.
        const listen = (p: number) => srv.listen(p, host)
        const at = await (child ? retryBusy(() => listenFree(listen, port, false)) : listenFree(listen, port, auto)).catch(async (e) => { await srv.close(); throw e })
        if (at !== port) io.out(`port ${port} in use, using ${at}`)
        const addr = srv.server.address() as AddressInfo
        const restarted = Number(process.env.TVINE_DEV_RESTARTED)
        if (child && restarted) io.out(`tvine dev: ready on :${addr.port} (restarted in ${((Date.now() - restarted) / 1000).toFixed(1)} s)`)
        else if (!worker) io.out(`listening on ${boundUrl(addr)}`)   // workers: the primary prints one line for all
        if (dev && !restarted && (host === undefined || host === '0.0.0.0' || host === '::')) {
          io.out(`  Local:   http://localhost:${addr.port}`)
          for (const ip of lanIps()) io.out(`  Network: http://${ip}:${addr.port}`)
        }
        const regen = dev ? devWatch(apps, io) : undefined
        // --with-worker: jobs (and the scheduler) in this web process — in web worker 1 only when there are several
        const settings = srv.ctx.settings
        let jobs: { name: string; stop(): Promise<void> } | undefined
        if (withWorker && (!worker || worker === '1')) {
          if (!settings.installedApps.includes('tvine.tasks')) { await srv.close(); throw new Usage("--with-worker runs background jobs: add 'tvine.tasks' to settings.installedApps") }
          const t = await import('./contrib/tasks/cli.js')
          jobs = await t.embeddedWorker(apps, settings, { concurrency, beat: !!o.beat }, t.logger())
          io.out(`tvine start: running ${jobs.name} in this process`)
        }
        // a production server whose jobs nobody runs: one line ~30 s after start (web worker 1 only)
        const quiet = !dev && !withWorker && (!worker || worker === '1')
          ? (await import('./contrib/tasks/relay.js')).noWorkerWarning(settings, io.err) : undefined
        let stopping = false
        const stop = () => {
          if (stopping) return
          stopping = true
          process.off('SIGTERM', stop); process.off('SIGINT', stop)
          regen?.close(); quiet?.()
          // running jobs get settings.tasks.graceMs to finish (then they are released for another worker)
          const hard = jobs ? settings.tasks.graceMs + 5_000 : 5_000
          setTimeout(() => { io.err(`tvine: close did not finish within ${hard / 1000} s; exiting`); io.exit(1) }, hard).unref()
          ;(async () => { await jobs?.stop(); await srv.close() })().then(() => io.exit(0), (e: unknown) => { io.err(`tvine: close failed: ${String(e)}`); io.exit(1) })
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
        // the supervisor is gone (killed, crashed): no orphan server. Polled, not process.on('disconnect'):
        // the supervisor may die during startup, before any listener here exists.
        if (child) setInterval(() => { if (!process.connected || process.ppid !== ppid) stop() }, 1_000).unref()
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
        // the HTTP middleware list as it will run, outermost first; which env vars are set (names only, never values)
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
        if (!down && srv.ctx.settings.installedApps.includes('tvine.tasks')) await checkJobs(srv.ctx.settings, io)
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
        for (const w of customKeyWarnings(srv.ctx.settings)) io.err(`tvine check: warning: ${w}`)
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
        const { mcpEnabled } = await import('./transport/mcp.js')
        io.out(table([['action', 'app', 'params', 'permissions', 'mcp'], ...actions.all().map((d) => [
          d.id, d.id.slice(0, d.id.indexOf('.')),
          actions.paramSpecs(d.id).map((p) => p.name + (p.required ? '' : '?')).join(', ') || '-',
          (d.rules?.permissions ?? []).map((p) => p.name || 'fn').join(', ') || '-',
          mcpEnabled(d, settings) ? 'yes' : 'no',
        ])]))
        return 0
      }
      case 'show_urls': {   // show_urls: the project's urls.ts, resolved
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
        // --check implies --dry-run and exits 1 when a migration is missing
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
        const conn = openConn(settings.db.url)   // the connected dialect
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
    if (e instanceof Usage) io.err(`run 'tvine ${cmd} --help' for its flags`)
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

// `tvine check`: who runs the background jobs (the broker's live worker rows), a warning when jobs wait for nobody
export async function checkJobs(settings: Pick<Settings, 'tasks'>, io: Pick<Io, 'out' | 'err'>): Promise<void> {
  if (settings.tasks.broker === 'memory') { io.out("tasks: broker memory (the web server runs jobs itself; dev / tests only)"); return }
  const { broker } = await import('./contrib/tasks/broker.js')
  const { jobWorkers, jobWorkersLine } = await import('./contrib/tasks/relay.js')
  let j
  try { j = jobWorkers(await broker().stats(settings.tasks.leaseMs)) } catch (e) { io.err(`tvine check: warning: tasks: cannot read the broker: ${(e as Error).message}`); return }
  io.out(`${jobWorkersLine(j)} · scheduler ${j.scheduler ? `on (${j.scheduler})` : 'off'}`)
  if (j.alarm) io.err(`tvine check: warning: ${j.waiting} background job(s) are waiting and no job worker is running: start one with tvine worker --beat (see docs/deploy.md#background-jobs)`)
}
