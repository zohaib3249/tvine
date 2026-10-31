// tvine startproject / startapp (Django django-admin startproject / manage.py startapp).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_RE } from '../core/actions.js'

const PKG_DIR = fileURLToPath(new URL('../../../', import.meta.url))   // the tvine package root (from warp/src/cli or warp/dist/cli)
const DOCS = 'https://github.com/zohaib3249/tvine'
export const PROJECT_RE = /^[a-z][a-z0-9_-]*$/

export interface ProjectOpts { name: string; dir?: string; db?: string; admin?: boolean; tasks?: boolean; pm?: string; local?: boolean }

const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
}
const commonRoot = (a: string, b: string) => {
  const x = a.split(/[\\/]/), y = b.split(/[\\/]/)
  let i = 0
  while (i < x.length && x[i] === y[i]) i++
  return x.slice(0, i).join('/') || '/'
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

// Installed as `tvine` (code imports 'tvine'): --local links this clone; otherwise an npm alias to the running
// CLI's own package (npm name `tvinejs`), as ^major.minor.0: a just-published patch can still be processing on npm
// when npx already runs it, so pinning the exact patch would make the first install fail.
function tvineDep(o: ProjectOpts): string {
  if (o.local) return `${o.pm === 'pnpm' ? 'link' : 'file'}:${PKG_DIR}`   // absolute: a temp dir far from the clone stays readable
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { name: string; version: string }
  const [major, minor] = pkg.version.split('.')
  return `npm:${pkg.name}@^${major}.${minor}.0`
}

export function startProject(o: ProjectOpts): { dir: string; files: string[] } {
  if (!PROJECT_RE.test(o.name)) throw new Error(`project name "${o.name}" must match ${PROJECT_RE} (lowercase, starts with a letter)`)
  const db = o.db ?? 'sqlite', pm = o.pm ?? 'pnpm'
  if (!['sqlite', 'postgres', 'mysql'].includes(db)) throw new Error('--db must be sqlite, postgres or mysql')
  if (!['pnpm', 'npm', 'yarn'].includes(pm)) throw new Error('--pm must be pnpm, npm or yarn')
  const dir = resolve(o.dir ?? o.name)
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`)
  const admin = o.admin !== false, tasks = o.tasks !== false, opts = { ...o, pm }
  const installed = ['tvine.auth', ...(tasks ? ['tvine.tasks'] : []), ...(admin ? ['tvine.admin'] : [])]
  const dbUrl = { sqlite: 'file:./tvine.db', postgres: `postgres://postgres:postgres@localhost:5432/${o.name.replace(/-/g, '_')}`, mysql: `mysql://root:root@localhost:3306/${o.name.replace(/-/g, '_')}` }[db]!
  const title = o.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const t = (s: string) => `tvine ${s}`
  const deps: Record<string, string> = {
    tvine: tvineDep(opts), next: '16.4.2', react: '19.3.1', 'react-dom': '19.3.1',
    ...(db === 'postgres' ? { pg: '^8.13.0' } : db === 'mysql' ? { mysql2: '^3' } : {}),
  }
  const run = pm === 'npm' ? 'npx' : pm
  const files: Record<string, string> = {
    'package.json': json({
      name: o.name, version: '0.1.0', private: true, type: 'module',
      scripts: {
        dev: t('dev'), build: t('build'), start: `${t('migrate')} && ${t('start')}`, migrate: t('migrate'),
        makemigrations: t('makemigrations'), check: t('check'), test: t('test'), createsuperuser: t('createsuperuser'),
        ...(tasks ? { worker: t('worker') } : {}), shell: t('shell'),
      },
      dependencies: deps,
      devDependencies: { '@types/node': '^22.0.0', '@types/react': '^19', '@types/react-dom': '^19', typescript: '^5.6.0', vitest: '^3.0.0' },
      engines: { node: '>=22.15' },
      ...(pm === 'pnpm' ? { pnpm: { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'] } } : {}),
    }),
    'config/settings/base.ts': `// Shared settings (Django settings/base.py). dev.ts and prod.ts build on it; pick one with
// TVINE_SETTINGS=config/settings/prod or tvine --settings (default: prod when NODE_ENV=production, else dev).
// Environment: DATABASE_URL, TVINE_SECRET, TVINE_ALLOWED_HOSTS, TVINE_DEBUG (.env in development).
import type { SettingsInput } from 'tvine'

export const base = {
  site: { name: '${title}', description: 'A Tvine project.' },
  installedApps: ${JSON.stringify(installed).replace(/,/g, ', ').replace(/"/g, "'")},
${admin ? "  mcp: { exclude: ['admin.*'] },   // the admin UI's ~30 actions are for humans; keeps your apps' actions as MCP tools\n" : ''}  // Django MIDDLEWARE, outermost first. Comment a line out to turn it off; add yours as 'config.middleware.<file>'.
  middleware: [
    'tvine.middleware.RequestId',          // x-request-id on every request and log line
    'tvine.middleware.AllowedHosts',       // refuses a Host header not in allowedHosts
    'tvine.middleware.Security',           // security headers: HSTS, CSP, frame, referrer…
    'tvine.middleware.Cors',               // cross-origin rules (settings.cors)
    'tvine.middleware.GZip',               // compresses responses (settings.compression)
    // 'tvine.middleware.ConditionalGet',  // ETag / 304 Not Modified
    // 'tvine.middleware.SslRedirect',     // http → https redirect
    // 'tvine.middleware.RateLimit',       // per-IP request limit for pages
    // 'tvine.middleware.IpFilter',        // allow / deny by IP or CIDR for some paths
    // 'tvine.middleware.Maintenance',     // 503 maintenance page while a flag is on
    // 'tvine.middleware.BodyLimit',       // caps request body size
    // 'tvine.middleware.Timeout',         // aborts slow requests
    // 'tvine.middleware.AccessLog',       // one log line per request
    // 'tvine.middleware.Locale',          // picks the language from Accept-Language / cookie
    // 'tvine.middleware.ServerTiming',    // Server-Timing header for devtools
    // 'tvine.middleware.BotGuard',        // refuses known bad bots by user-agent
    // 'config.middleware.example',        // your own: config/middleware/example.ts
  ],
} satisfies SettingsInput
`,
    'config/middleware/index.ts': `// Your project's HTTP middleware. Enable one in config/settings/base.ts:
//   middleware: [..., 'config.middleware.example']   (or import it and list the object itself)
export { default as example } from './example.ts'
`,
    'config/middleware/example.ts': `// An example middleware (not enabled). Enable it with 'config.middleware.example' in settings.middleware.
import { defineMiddleware } from 'tvine'

export default defineMiddleware({
  name: 'example',
  processRequest(req) {
    // runs before the view; send a response here to stop the request
    void req
  },
  // processResponse(req, res) { res.setHeader('x-example', '1') },
})
`,
    'config/settings/dev.ts': `// Development: tvine dev / migrate / shell use this (then config/settings/local.ts, if present).
import { defineSettings } from 'tvine'
import { base } from './base.ts'

export default defineSettings({
  ...base,
  debug: true,
  allowedHosts: ['localhost', '.localhost', '127.0.0.1', '[::1]'],
})
`,
    'config/settings/prod.ts': `// Production: tvine start, or TVINE_SETTINGS=config/settings/prod. Everything secret comes from the environment.
import { defineSettings } from 'tvine'
import { base } from './base.ts'

const need = ['TVINE_SECRET', 'TVINE_ALLOWED_HOSTS', 'DATABASE_URL'].filter((k) => !process.env[k]?.trim())
if (need.length) throw new Error(\`config/settings/prod.ts: set \${need.join(', ')} in the environment\`)

export default defineSettings({
  ...base,
  debug: false,                 // secret, allowedHosts and db.url are read from the variables above
  session: { secure: true },    // cookies over https only
  middleware: [...base.middleware, 'tvine.middleware.SslRedirect'],
})
`,
    'config/settings/local.example.ts': `// Copy to config/settings/local.ts (git-ignored) for machine-only overrides. tvine dev merges it over dev.ts.
// A plain object, not defineSettings(): only the keys you set change.
import type { SettingsInput } from 'tvine'

export default {
  // db: { url: 'postgres://me@localhost/${o.name.replace(/-/g, '_')}' },
} satisfies SettingsInput
`,
    'config/urls.ts': `// Django ROOT_URLCONF (settings.rootUrlconf). Every action also answers at /tvine/api/<app>.<name> and as an MCP tool at /mcp.
${admin ? '// /admin is served by tvine.admin itself (settings.admin.path); no route needed.\n' : ''}import { include, path } from 'tvine'

export const urlpatterns = [
  path('api/auth/', include('tvine.auth.urls')),
]
`,
    'config/tasks.ts': `// Task worker config, like Celery's (settings.tasksModule). Tasks live in apps/<app>/tasks.ts (defineTask).
// Run: tvine worker [--beat]

// Queues this worker consumes when --queues is not given (default: all).
export const queues: string[] = []

// Periodic tasks for tvine worker --beat, by task id '<app>.<task>'.
export const beatSchedule = {
  // 'blog.cleanup': { cron: '0 3 * * *' },
  // 'blog.ping': { every: 60_000, args: {} },
}
`,
    '.env.example': `# Copy to .env for development. In production set real environment variables instead.
TVINE_SECRET=change-me-to-64-hex-chars-openssl-rand-hex-32
DATABASE_URL=${dbUrl}
TVINE_ALLOWED_HOSTS=example.com,www.example.com
# TVINE_DEBUG=1
`,
    '.env': `# Development only (git-ignored). Generated by tvine startproject.\nTVINE_SECRET=${randomBytes(32).toString('hex')}\nDATABASE_URL=${dbUrl}\n`,
    '.gitignore': 'node_modules/\n.next/\n*.db\n*.db-*\n.env\n.env*.local\nconfig/settings/local.ts\nnext-env.d.ts\n*.tsbuildinfo\nmedia/\n',
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['node'], module: 'ESNext', moduleResolution: 'Bundler',
        allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, isolatedModules: true, erasableSyntaxOnly: true,
        verbatimModuleSyntax: true, esModuleInterop: true, resolveJsonModule: true, jsx: 'react-jsx', incremental: true,
        plugins: [{ name: 'next' }], allowJs: true, jsxImportSource: 'tvine/weft',
      },
      include: ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts', '.next/dev/types/**/*.ts'],
      exclude: ['node_modules', '.next'],
    }),
    'next.config.ts': `import type { NextConfig } from 'next'

export default {
  compress: false,                            // Warp compresses (with its BREACH rule); Next must not gzip twice
  devIndicators: false,                       // no Next.js dev badge: Weft draws its own agent badge
${o.local ? `  turbopack: { root: ${JSON.stringify(commonRoot(dir, PKG_DIR))} },   // --local: the linked clone must sit inside the root\n` : ''}} satisfies NextConfig
`,
    'app/layout.tsx': `import type { ReactNode } from 'react'
import { WeftRoot } from 'tvine/weft'

export const metadata = { title: '${title}' }

// WeftRoot: the agent badge, WebMCP tools and tab control (after the user clicks Allow).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <WeftRoot>{children}</WeftRoot>
      </body>
    </html>
  )
}
`,
    'app/page.tsx': welcomePage(title, admin),
    '.mcp.json': json({ mcpServers: { [o.name]: { type: 'http', url: 'http://localhost:3000/mcp' } } }),
    'README.md': `# ${title}

A [Tvine](${DOCS}) project: Django-style backend (Warp) + Next.js pages (Weft); every action is also an MCP tool.

\`\`\`bash
${pm} install
${run} tvine migrate
${run} tvine createsuperuser
${run} tvine dev            # http://localhost:3000${admin ? ' · /admin' : ''} · /mcp
${run} tvine startapp blog     # apps/blog + installedApps + config/urls.ts
\`\`\`

| File | Django |
|---|---|
| config/settings/base.ts, dev.ts, prod.ts | settings.py split per environment (TVINE_SETTINGS = DJANGO_SETTINGS_MODULE) |
| config/urls.ts | ROOT_URLCONF |
| config/tasks.ts | Celery config: queues, beat schedule |
| apps/<name>/ | an app (listed in installedApps): models, views, urls, admin, migrations |
| app/ | Next.js pages (call the backend through \`api.*\`) |

Claude Code: \`.mcp.json\` points at \`http://localhost:3000/mcp\`; start \`tvine dev\`, then run \`claude\` in this folder.
`,
    'apps/.gitkeep': '',
  }
  write(dir, files)
  return { dir, files: Object.keys(files) }
}

function welcomePage(title: string, admin: boolean): string {
  const card = (href: string, h: string, p: string) => `        <a className="tv-card" href="${href}"><strong>${h}</strong><span>${p}</span></a>`
  return `// The Tvine welcome page (Django's "The install worked successfully!"). Replace it with your own.
const css = \`
.tv{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 16px;box-sizing:border-box;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#e7e9f3;
  background:radial-gradient(1200px 600px at 20% -10%,#3b2a8a 0%,transparent 60%),radial-gradient(900px 500px at 110% 110%,#0e6b74 0%,transparent 55%),#0b0d17}
.tv-wrap{max-width:880px;width:100%}
.tv-logo{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;font-size:18px}
.tv-mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#8b7bff,#2dd4bf);display:grid;place-items:center;color:#0b0d17;font-weight:900}
.tv h1{font-size:clamp(32px,5vw,52px);line-height:1.05;margin:36px 0 12px;letter-spacing:-.02em}
.tv h1 em{font-style:normal;background:linear-gradient(90deg,#a99bff,#2dd4bf);-webkit-background-clip:text;background-clip:text;color:transparent}
.tv p.lead{color:#a8aec8;font-size:18px;max-width:620px;margin:0 0 32px}
.tv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px}
.tv-card{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:14px;text-decoration:none;color:inherit;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);transition:transform .15s,border-color .15s}
.tv-card:hover{transform:translateY(-2px);border-color:#8b7bff}
.tv-card span{color:#a8aec8;font-size:14px}
.tv-steps{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:18px 20px}
.tv-steps h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#8b93b5;margin:0 0 10px}
.tv-steps pre{margin:0;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d6dbff;white-space:pre-wrap}
.tv-steps .c{color:#6b7394}
.tv-foot{margin-top:22px;color:#6b7394;font-size:13px}
\`

export default function Welcome() {
  return (
    <main className="tv">
      <style>{css}</style>
      <div className="tv-wrap">
        <div className="tv-logo"><span className="tv-mark">T</span>Tvine</div>
        <h1>${title} is <em>up and running.</em></h1>
        <p className="lead">The install worked. You see this page because <code>app/page.tsx</code> is the default welcome page. Every action you write is a web endpoint and an agent tool.</p>
        <div className="tv-grid">
${[
  admin ? card('/admin', 'Admin', 'Manage your data. Create a login with tvine createsuperuser.') : '',
  card('/mcp', 'MCP endpoint', 'Your actions as tools for Claude and other agents at /mcp.'),
  card('${DOCS}/blob/main/docs/getting-started.md', 'Docs', 'Models, views, urls, admin, tasks: Django, in TypeScript.'),
  card('/tvine/health', 'Health', 'Is the server up? /tvine/health'),
].filter(Boolean).join('\n')}
        </div>
        <div className="tv-steps">
          <h2>Next steps</h2>
          <pre>{\`tvine startapp blog                \`}<span className="c"># a new app in apps/blog</span>{\`
tvine makemigrations && tvine migrate
claude                              \`}<span className="c"># Claude Code reads .mcp.json: your actions are its tools</span></pre>
        </div>
        <p className="tv-foot">Connect Claude Code: <code>.mcp.json</code> points at http://localhost:3000/mcp.</p>
      </div>
    </main>
  )
}
`
}

// tvine startapp <name>: apps/<name>/ with empty Django-style stubs, then '<name>' in installedApps and its
// include() in the root urls. Each edit goes into the existing array literal; a file of an unexpected shape is
// left alone and the caller prints the line to add instead.
export interface StartAppResult { dir: string; files: string[]; settings: Edit; urls: Edit }
export interface Edit { file?: string; status: 'added' | 'present' | 'manual'; line: string }

export function startApp(appsDir: string, name: string): StartAppResult {
  if (!APP_RE.test(name)) throw new Error(`app name "${name}" must match ${APP_RE} (it becomes the action id prefix)`)
  const dir = join(appsDir, name)
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  const files: Record<string, string> = {
    'models.ts': `// import { defineModel, field } from 'tvine'\n\n// Create your models here.\n`,
    'views.ts': `// Create your views here.\n`,
    'admin.ts': `// Register your models here.\n`,
    'urls.ts': `export const appName = '${name}'\nexport const urlpatterns = []\n`,
    'migrations/.gitkeep': '',
    [`tests/${name}.test.ts`]: `import { expect, it } from 'vitest'\n\n// Create your tests here.\nit('${name} works', () => {\n  expect(true).toBe(true)\n})\n`,
  }
  write(dir, files)
  const root = dirname(appsDir)
  return { dir, files: Object.keys(files), settings: addInstalledApp(root, name), urls: addInclude(root, name) }
}

const rel = (root: string, f: string) => f.slice(root.length + 1)
const firstFile = (root: string, names: string[]) => names.map((n) => join(root, n)).find((f) => existsSync(f))

// appends `item` to the array literal that starts at `open` (index just past '['), keeping its layout
function appendItem(src: string, open: number, close: number, item: string): string {
  const body = src.slice(open, close)
  if (body.includes('\n')) {   // one item per line: a new line before the closing bracket, same indent
    const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  '
    const head = body.replace(/\s*$/, ''), tail = body.slice(head.length)
    const sep = head.trim() === '' || /,\s*$/.test(head) ? '' : ','
    return src.slice(0, open) + head + sep + `\n${indent}${item},` + tail + src.slice(close)
  }
  const t = body.trim()
  return src.slice(0, open) + (t ? `${t.replace(/,$/, '')}, ${item}` : item) + src.slice(close)
}

export function addInstalledApp(root: string, name: string): Edit {
  const line = `'${name}',`
  const file = firstFile(root, ['config/settings/base.ts', 'settings.ts'])
  if (!file) return { status: 'manual', line }
  const src = readFileSync(file, 'utf8')
  const all = [...src.matchAll(/installedApps:\s*\[/g)]
  const close = all.length === 1 ? src.indexOf(']', all[0]!.index! + all[0]![0].length) : -1
  if (close < 0) return { file, status: 'manual', line }
  const open = all[0]!.index! + all[0]![0].length
  const body = src.slice(open, close)
  if (/[[{(]/.test(body)) return { file, status: 'manual', line }   // not a plain list of strings: don't guess
  if (new RegExp(`['"\`]${name}['"\`]`).test(body)) return { file, status: 'present', line }
  writeFileSync(file, appendItem(src, open, close, `'${name}'`))
  return { file, status: 'added', line }
}

export function addInclude(root: string, name: string): Edit {
  const line = `path('${name}/', include('${name}.urls')),`
  const file = firstFile(root, ['config/urls.ts', 'urls.ts'])
  if (!file) return { status: 'manual', line }
  let src = readFileSync(file, 'utf8')
  if (new RegExp(`include\\(['"]${name}\\.urls['"]`).test(src)) return { file, status: 'present', line }
  const m = [...src.matchAll(/export const urlpatterns(?::[^=]+)? = \[/g)]
  const end = m.length === 1 ? /\n\]/.exec(src.slice(m[0]!.index!)) : null
  if (!end) return { file, status: 'manual', line }
  const open = m[0]!.index! + m[0]![0].length, close = m[0]!.index! + end.index! + 1
  src = appendItem(src, open, close, line.slice(0, -1))
  const imp = /import \{([^}]*)\} from 'tvine'\n/.exec(src)
  if (imp) {
    const names = imp[1]!.split(',').map((x) => x.trim()).filter(Boolean)
    for (const n of ['include', 'path']) if (!names.includes(n)) names.push(n)
    src = src.replace(imp[0], `import { ${names.sort().join(', ')} } from 'tvine'\n`)
  } else src = `import { include, path } from 'tvine'\n` + src
  writeFileSync(file, src)
  return { file, status: 'added', line }
}
