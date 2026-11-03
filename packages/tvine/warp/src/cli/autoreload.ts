// tvine dev autoreload: the parent watches the project and runs the real server as a child (TVINE_DEV_CHILD=1);
// a change to any backend file stops the child and starts a fresh one, because Node's ESM cache cannot drop
// modules. Next's frontend (app/, components/, …, *.css) is left to Next HMR; open tabs reload themselves after a
// restart through GET /tvine/dev/reload (transport/inspector.ts devReloadTransport, weft runtime/devReload.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { join, relative } from 'node:path'

// never a restart: deps, build output, any dot dir (.git, .next, .idea, .vscode, …), data the app writes
// (media/, data/, *.db*, sqlite, logs), generated files (tvine-api.d.ts, next-env.d.ts, *.tsbuildinfo), OS and editor scratch files (vim's 4913 probe)
const IGNORED = /(^|\/)(node_modules|dist|coverage|\.(?!env)[^/]+)(\/|$)|^(media|data)\/|\.db[^/]*$|\.sqlite3?(-\w+)?$|\.log$|\.tsbuildinfo$|(^|\/)(tvine-api\.d\.ts|next-env\.d\.ts|\.DS_Store|4913|\.#[^/]*|[^/]*~|[^/]*\.sw[a-z])$/
// Next hot-reloads these itself (HMR): the frontend dirs and every stylesheet
const NEXT_HMR = /^(src\/)?(app|components|pages)(\/|$)|^(public|styles)(\/|$)/

// a project-relative path → does it need a server restart? Any file does (code, json, md, html, templates, the
// root package.json, lib/, config/, .env*), except IGNORED and what Next hot-reloads. apps: the apps dir, always backend.
export function restartsOn(rel: string, apps = 'apps'): boolean {
  const p = rel.replace(/\\/g, '/')
  if (!p || IGNORED.test(p) || /\.s?css$/.test(p)) return false
  return p.startsWith(`${apps}/`) || !NEXT_HMR.test(p)
}

// a `link:`ed framework (node_modules/tvine realpath outside node_modules): its built dist dirs to watch too
export function linkedDists(root: string): string[] {
  let pkg: string
  try { pkg = realpathSync(join(root, 'node_modules/tvine')) } catch { return [] }
  if (/[\\/]node_modules[\\/]/.test(pkg)) return []
  return ['warp', 'weft', 'admin'].map((d) => join(pkg, d, 'dist')).filter((d) => existsSync(d))
}

export interface Supervisor { close(): Promise<void> }

// cmd: the child's [bin, ...args]; it runs with env TVINE_DEV_CHILD=1 (+ TVINE_DEV_RESTARTED=<ms> after a restart)
export function supervise(o: { root: string; apps: string; cmd: string[]; out(s: string): void; err(s: string): void; dists?: string[] }): Supervisor {
  let child: ChildProcess | undefined, closing = false, timer: ReturnType<typeof setTimeout> | undefined, file = ''
  let chain = Promise.resolve()
  const start = (restartedAt?: number) => {
    const env = { ...process.env, TVINE_DEV_CHILD: '1', ...(restartedAt ? { TVINE_DEV_RESTARTED: String(restartedAt) } : {}) }
    const c = spawn(o.cmd[0]!, o.cmd.slice(1), { cwd: o.root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
    c.on('exit', (code, sig) => {
      if (child !== c) return
      child = undefined
      if (!closing) o.err(`tvine dev: server exited (code ${code ?? sig}) — fix the error, it restarts on the next save`)
    })
    child = c
  }
  const stop = (): Promise<void> => {
    const c = child
    if (!c || c.exitCode !== null || c.signalCode !== null) { child = undefined; return Promise.resolve() }
    child = undefined
    return new Promise((ok) => {
      const kill = setTimeout(() => c.kill('SIGKILL'), 3_000)
      c.once('exit', () => { clearTimeout(kill); ok() })
      c.kill('SIGTERM')
    })
  }
  const changed = (f: string, ms: number) => {
    file = f
    clearTimeout(timer)
    timer = setTimeout(() => {
      chain = chain.then(async () => {
        if (closing) return
        o.out(`tvine dev: ${file} changed, restarting…`)
        const t = Date.now()
        await stop()
        if (!closing) start(t)
      })
    }, ms)
  }
  const appsRel = relative(o.root, o.apps).replace(/\\/g, '/') || 'apps'
  // ponytail: fs.watch recursive (Node >= 20 on Linux); polling fallback if a filesystem drops events
  const watchers: FSWatcher[] = [watch(o.root, { recursive: true }, (_e, f) => { const p = String(f ?? ''); if (restartsOn(p, appsRel)) changed(p, 150) })]
  for (const d of o.dists ?? []) watchers.push(watch(d, { recursive: true }, (_e, f) => changed(join('tvine', relative(join(d, '../..'), join(d, String(f ?? '')))), 500)))
  start()
  return {
    async close() {
      closing = true
      clearTimeout(timer)
      for (const w of watchers) w.close()
      await chain
      await stop()
    },
  }
}
