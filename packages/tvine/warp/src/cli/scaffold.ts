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

// --local links this clone's package; otherwise the running CLI's own version.
function tvineDep(o: ProjectOpts): string {
  if (o.local) return `${o.pm === 'pnpm' ? 'link' : 'file'}:${PKG_DIR}`   // absolute: a temp dir far from the clone stays readable
  return '^' + (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string }).version
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
    'settings.ts': `// Django settings.py: the one settings file (docs/design/conventions/settings.md).
// Secure by default, read from the environment (.env in development, real env vars in production):
//   DATABASE_URL          db url (default sqlite file:./tvine.db)
//   TVINE_SECRET         >= 32 random chars; required in production
//   TVINE_ALLOWED_HOSTS  comma list; required in production (dev accepts localhost only)
//   TVINE_DEBUG          1 = DEBUG (on under \`tvine dev\`, off under \`tvine start\`)
import { defineSettings } from 'tvine'

export default defineSettings({
  site: { name: '${title}', description: 'A Tvine project.' },
  installedApps: ${JSON.stringify(installed).replace(/,/g, ', ').replace(/"/g, "'")},
${admin ? "  mcp: { exclude: ['admin.*'] },   // the admin UI's ~30 actions are for humans; keeps your apps' actions as MCP tools\n" : ''}})
`,
    'urls.ts': `// Django ROOT_URLCONF. Every action also answers at /tvine/api/<app>.<name> and as an MCP tool at /mcp.
${admin ? '// /admin is served by tvine.admin itself (settings.admin.path); no route needed.\n' : ''}import { include, path } from 'tvine'

export const urlpatterns = [
  path('api/auth/', include('tvine.auth.urls')),
]
`,
    '.env.example': `# Copy to .env for development. In production set real environment variables instead.
TVINE_SECRET=change-me-to-64-hex-chars-openssl-rand-hex-32
DATABASE_URL=${dbUrl}
TVINE_ALLOWED_HOSTS=example.com,www.example.com
# TVINE_DEBUG=1
`,
    '.env': `# Development only (git-ignored). Generated by tvine startproject.\nTVINE_SECRET=${randomBytes(32).toString('hex')}\nDATABASE_URL=${dbUrl}\n`,
    '.gitignore': 'node_modules/\n.next/\n*.db\n*.db-*\n.env\n.env*.local\nnext-env.d.ts\n*.tsbuildinfo\nmedia/\n',
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
${run} tvine startapp blog --model Post
\`\`\`

| File | Django |
|---|---|
| settings.ts | settings.py |
| urls.ts | ROOT_URLCONF |
| apps/<name>/ | an app: models, views, urls, admin, migrations |
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
          <pre>{\`tvine startapp blog --model Post   \`}<span className="c"># a new app in apps/blog</span>{\`
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

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

// tvine startapp <name> [--model Name]: apps/<name>/ + one include line in the root urls.ts when it is safe
export function startApp(appsDir: string, name: string, model?: string): { dir: string; files: string[]; urls: 'added' | string } {
  if (!APP_RE.test(name)) throw new Error(`app name "${name}" must match ${APP_RE} (it becomes the action id prefix)`)
  const M = model ?? cap(camel(name))
  if (!/^[A-Z][A-Za-z0-9]*$/.test(M)) throw new Error(`--model "${M}" must be PascalCase, e.g. Post`)
  const dir = join(appsDir, name)
  if (existsSync(dir)) throw new Error(`${dir} already exists`)
  const m = M.toLowerCase(), list = `${M}List`, detail = `${M}Detail`
  const files: Record<string, string> = {
    'models.ts': `// Django models.py. Change a model, then: tvine makemigrations && tvine migrate
import { defineModel, field, type Infer } from 'tvine'

export const ${M} = defineModel('${m}', {
  id: field.id(),                                  // auto primary key
  title: field.text({ searchable: true }),         // ?q= searches it
  body: field.text({ default: '' }),
  published: field.bool({ default: false }),
})
export type ${M} = Infer<typeof ${M}>
`,
    'views.ts': `// Django views.py. Each view is an action: ${name}.list, ${name}.get (also MCP tools at /mcp).
import { DetailView, ListView } from 'tvine'
import { ${M} } from './models.ts'

export class ${list} extends ListView<${M}> {     // → ${name}.list (?q= search, ?sort=, pages)
  model = ${M}
  ordering = ['id', 'title']
}

export class ${detail} extends DetailView<${M}> { // → ${name}.get
  model = ${M}
}
`,
    'urls.ts': `import { path } from 'tvine'
import { ${detail}, ${list} } from './views.ts'

export const appName = '${name}'
export const urlpatterns = [
  path('${m}s/', ${list}, { name: '${m}-list' }),
  path('${m}s/<int:id>/', ${detail}, { name: '${m}-detail' }),
]
`,
    'admin.ts': `// Django admin.py: what /admin shows for ${name}.
import { admin, ModelAdmin } from 'tvine/contrib/admin'
import { ${M} } from './models.ts'

class ${M}Admin extends ModelAdmin {
  listDisplay = ['title', 'published']
  listFilter = ['published']
  searchFields = ['title']
  str(o: any) { return String(o.title) }
}
admin.site.register(${M}, ${M}Admin)
`,
    'serializers.ts': `// Per-node-type snapshot shaping: hide fields from agents, add computed ones.
export const serializers: Record<string, (data: Record<string, unknown>) => Record<string, unknown>> = {}
`,
    'rules.ts': `// App-wide action rules (an action's own rules win). e.g. export const permissions = [isAuthenticated]
export {}
`,
    'middleware.ts': `// Middleware that wraps only this app's actions.
export default []
`,
    'migrations/.gitkeep': '',
    [`tests/${name}.test.ts`]: `import { fileURLToPath } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { createAgentServer, type AgentServer } from 'tvine'

const appsDir = fileURLToPath(new URL('../../', import.meta.url))
const settings = { secret: 'k'.repeat(32), logging: 'none' as const, db: { url: ':memory:' } }
let srv: AgentServer | undefined
afterAll(() => srv?.close())

it('${name} actions are discovered', async () => {
  srv = await createAgentServer({ appsDir, settings })
  expect(srv.ctx.actions.all().map((a) => a.id)).toEqual(expect.arrayContaining(['${name}.list', '${name}.get']))
})
`,
  }
  write(dir, files)
  const line = `path('${name}/', include('${name}.urls')),`
  const urlsFile = join(dirname(appsDir), 'urls.ts')
  let urls = line
  if (existsSync(urlsFile)) {
    const src = readFileSync(urlsFile, 'utf8')
    const open = src.match(/export const urlpatterns(?::[^=]+)? = \[\n/)
    if (open && /import \{[^}]*\binclude\b[^}]*\} from 'tvine'/.test(src) && !src.includes(`include('${name}.urls')`)) {
      const at = open.index! + open[0].length
      writeFileSync(urlsFile, src.slice(0, at) + `  ${line}\n` + src.slice(at))
      urls = 'added'
    }
  }
  return { dir, files: Object.keys(files), urls }
}

