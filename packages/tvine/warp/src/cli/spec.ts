// tvine's command spec (docs/cli.md is generated from it: cli-docs.test.ts)
// ---- the command spec: ONE source for parsing, `tvine help`, `--help`, the usage list and docs/cli.md ----------------
// Each command: its group, positionals (usage text + min/max), flags (type, placeholder, default, meaning), examples.
import { editDistance } from '../core/edit-distance.js'

export interface Flag { type: 'string' | 'boolean'; arg?: string; default?: string; desc: string; short?: string }
export interface Command { group: string; usage?: string; args: [min: number, max: number]; desc: string; flags: Record<string, Flag>; examples: string[]; passthrough?: boolean }
const s = (arg: string, desc: string, dflt?: string): Flag => ({ type: 'string', arg, desc, ...(dflt !== undefined && { default: dflt }) })
const b = (desc: string): Flag => ({ type: 'boolean', desc })
export const GROUPS = ['Project', 'Database', 'Run', 'Users', 'Jobs', 'Maintenance', 'Tools'] as const
// every command also takes these
export const GLOBAL_FLAGS: Record<string, Flag> = {
  apps: s('./apps', 'where your apps live', 'apps'),
  settings: s('path', 'the settings module to load (or TVINE_SETTINGS); default: config/settings/prod when NODE_ENV=production, else config/settings/dev'),
  help: { type: 'boolean', short: 'h', desc: 'print this help and exit (works anywhere on the line; the command does not run)' },
}
export const COMMANDS: Record<string, Command> = {
  startproject: { group: 'Project', usage: '<name> [dir]', args: [1, 2], desc: 'Create a ready-to-run project (settings, urls, a welcome page, admin and background jobs) and install its packages.',
    flags: { db: s('sqlite|postgres|mysql', 'the database the project starts with', 'sqlite'), 'no-admin': b('leave out tvine.admin'), 'no-tasks': b('leave out tvine.tasks (background jobs)'),
      pm: s('pnpm|npm|yarn', 'the package manager to install with', 'pnpm'), 'no-install': b('write the files only; install yourself'), local: b("link this clone's packages instead of the npm ones") },
    examples: ['npx tvinejs startproject my-app', 'tvine startproject shop ./shop --db postgres --pm npm'] },
  startapp: { group: 'Project', usage: '<name>', args: [1, 1], desc: 'Create apps/<name>/ with empty stubs, add it to installedApps and its include() to config/urls.ts.',
    flags: {}, examples: ['tvine startapp blog'] },
  check: { group: 'Project', args: [0, 0], desc: 'Check settings, actions, migrations, Redis, background job workers and the frontend/database boundary; print middleware order, env vars set (names only) and backends. Exit 1 on problems.',
    flags: {}, examples: ['tvine check', 'tvine check --settings config/settings/prod'] },
  routes: { group: 'Project', args: [0, 0], desc: 'Print every action: id, app, params, permissions, whether it is an MCP tool.', flags: {}, examples: ['tvine routes'] },
  show_urls: { group: 'Project', args: [0, 0], desc: 'Print the urls.ts routes: pattern, methods, name, action.', flags: {}, examples: ['tvine show_urls'] },
  generate: { group: 'Project', args: [0, 0], desc: 'Write tvine-api.d.ts (the types for api.*).',
    flags: { check: b('write nothing; exit 1 when the file is missing or stale (for CI)') }, examples: ['tvine generate', 'tvine generate --check'] },

  makemigrations: { group: 'Database', usage: '[app]', args: [0, 1], desc: 'Write migration files from model changes.',
    flags: { name: s('x', 'the new migration\'s name (default: generated from the changes)'), 'allow-drop': b('allow a migration that drops columns or tables'), merge: b('merge two migration leaves'),
      empty: b('an empty migration for [app] (needs the app)'), check: b('write nothing; exit 1 when a migration is missing (for CI)'), 'dry-run': b('print what would be written, write nothing') },
    examples: ['tvine makemigrations', 'tvine makemigrations --check', 'tvine makemigrations blog --empty --name seed_tags'] },
  migrate: { group: 'Database', usage: '[<app> [<target>|zero]]', args: [0, 2], desc: 'Apply pending migrations. <app>: forward to its latest; <target>: forward or roll back to it; zero: unapply the whole app.',
    flags: { check: b('apply nothing; exit 1 when anything is pending'), plan: b('print what would run, run nothing'), fake: b('mark as applied (or unapplied) without running the SQL') },
    examples: ['tvine migrate', 'tvine migrate notes zero', 'tvine migrate --check'] },
  sqlmigrate: { group: 'Database', usage: '<app> <migration>', args: [2, 2], desc: 'Print the SQL of one migration for the connected database.',
    flags: { backwards: b('the SQL of its rollback instead') }, examples: ['tvine sqlmigrate notes 0001_initial'] },
  showmigrations: { group: 'Database', args: [0, 0], desc: "List each app's migrations; [X] = applied.", flags: {}, examples: ['tvine showmigrations'] },
  dumpdata: { group: 'Database', usage: '[app[.model] …]', args: [0, Infinity], desc: 'Print fixtures as JSON, in foreign-key order (every model, or the apps / models named).',
    flags: { output: s('f.json', 'write to this file instead of stdout') }, examples: ['tvine dumpdata notes --output notes.json'] },
  loaddata: { group: 'Database', usage: '<f.json> …', args: [1, Infinity], desc: 'Load fixture files in one transaction (upsert by primary key).', flags: {}, examples: ['tvine loaddata notes.json'] },
  encryption: { group: 'Database', usage: 'rotate', args: [1, 1], desc: 'Re-encrypt every encrypted field with the newest key in settings.encryption.keys.', flags: {}, examples: ['tvine encryption rotate'] },

  dev: { group: 'Run', args: [0, 0], desc: 'Development server: Next with hot reload; the server restarts on any backend change (apps/, config/, .env…); tvine-api.d.ts is regenerated on save.',
    flags: { port: s('n', 'the port (or PORT); a busy port moves to the next free one unless forced', '3000'), host: s('h', 'the address to bind (or HOST)', 'every interface'), noreload: b('one process, no restart on changes') },
    examples: ['tvine dev', 'tvine dev --port 4000'] },
  build: { group: 'Run', args: [0, 0], desc: 'next build: the pages tvine start serves.', flags: {}, examples: ['tvine build'] },
  start: { group: 'Run', args: [0, 0], desc: 'Production web server: pages (after tvine build), API, MCP. NODE_ENV=production by default, so it needs TVINE_SECRET and TVINE_ALLOWED_HOSTS. It runs no background jobs unless --with-worker is given: run `tvine worker --beat` next to it (about 30 s after start it warns once when no job worker is running). SIGTERM / SIGINT: graceful close, hard exit at 5 s (with --with-worker: the job grace + 5 s).',
    flags: { port: s('n', 'the port (or PORT)', '3000'), host: s('h', 'the address to bind (or HOST)', 'every interface'), 'api-only': b('no frontend: Next runs separately with TVINE_API_URL'),
      workers: s('n|auto', 'web worker processes on one port (or WEB_CONCURRENCY; the flag wins); auto = CPU cores; a crashed one is restarted; more than 1 needs every backend on Redis (it refuses and lists what to change)', '1'),
      'with-worker': b('also run a job worker inside the web process (small single-process sites); with --workers > 1 only web worker 1 runs it'),
      concurrency: s('n', 'with --with-worker: jobs at once', '10'), beat: b('with --with-worker: also run the scheduler (cron / every)') },
    examples: ['tvine start', 'tvine start --workers auto', 'tvine start --with-worker --beat'] },
  shell: { group: 'Run', args: [0, 0], desc: 'Node REPL with settings loaded, the database configured and every model by name (await works).', flags: {}, examples: ['tvine shell'] },
  test: { group: 'Run', usage: '[vitest args]', args: [0, Infinity], passthrough: true, desc: 'vitest run; every argument after `test` goes to vitest.', flags: {}, examples: ['tvine test', 'tvine test apps/blog'] },

  createsuperuser: { group: 'Users', args: [0, 0], desc: 'Create a staff superuser (tvine.auth). Prompts for what is missing.',
    flags: { username: s('u', 'the username'), email: s('e', 'the email'), noinput: b('no prompts: read TVINE_SUPERUSER_USERNAME / _EMAIL / _PASSWORD') },
    examples: ['tvine createsuperuser', "TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=a@example.com TVINE_SUPERUSER_PASSWORD='change-me-42' tvine createsuperuser --noinput"] },
  changepassword: { group: 'Users', usage: '<username>', args: [1, 1], desc: "Set a user's password (tvine.auth; prompts, needs a terminal).", flags: {}, examples: ['tvine changepassword admin'] },
  privacy: { group: 'Users', usage: 'export|erase <username>', args: [2, 2], desc: "tvine.auth: a user's data as JSON (export), or anonymize / delete it per model onErase (erase).",
    flags: { output: s('file', 'export: write to this file (mode 600) instead of stdout'), yes: b('erase: confirm (it cannot be undone)') },
    examples: ['tvine privacy export alice --output alice.json', 'tvine privacy erase alice --yes'] },

  worker: { group: 'Jobs', args: [0, 0], desc: 'Run a job worker (tvine.tasks): claims queued jobs with leases, so each job runs once; a dead worker\'s lease expires and another takes its job. Run as many as you like. SIGTERM: stop claiming, finish or release running jobs within the grace.',
    flags: { queues: s('a,b', 'the queues to take jobs from; * = every queue', 'config/tasks.ts queues, else *'), concurrency: s('n', 'jobs at once in this worker', '10'),
      beat: b('also run the scheduler (cron / every); several --beat workers are safe: one leads, the others stand by and take over in ~30 s'),
      name: s('x', 'the worker name shown in tasks list / admin', '<host>:<pid>:<random>'), grace: s('ms', 'on stop: how long running jobs may finish before they are released', 'settings.tasks.graceMs (30000)') },
    examples: ['tvine worker --beat', 'tvine worker --queues emails,default --concurrency 20', 'tvine worker --name reports-1 --grace 60000'] },
  tasks: { group: 'Jobs', usage: 'list | inspect <id> | retry <id> | purge --dead | compact | bench', args: [0, 2], desc: 'Look at and fix background jobs: list them, show one, re-queue a dead one, delete dead ones, compact the file broker, or measure the broker.',
    flags: { status: s('s', 'list: only this status: queued, running, success, dead, expired, cancelled or deduped'), queue: s('q', 'list: only this queue'), limit: s('n', 'list: at most n rows', '50'),
      dead: b('purge: delete the dead jobs'), jobs: s('n', 'bench: jobs to push through', '5000'), workers: s('n', 'bench: claimers at once', '4'), batch: s('n', 'bench: jobs per claim (max 100)', 'settings.tasks.claimBatch (10)') },
    examples: ['tvine tasks list --status dead', 'tvine tasks retry <id>', 'tvine tasks bench --jobs 200'] },

  audit: { group: 'Maintenance', usage: 'prune', args: [1, 1], desc: 'tvine.audit: delete audit rows older than n days.',
    flags: { days: s('n', 'keep this many days', 'settings.audit.retentionDays') }, examples: ['tvine audit prune', 'tvine audit prune --days 90'] },
  shield: { group: 'Maintenance', usage: 'mode off|log|enforce | rules disable <id> | lists [remove <value>] | simulate', args: [1, 3],
    desc: 'tvine.shield escape hatch (running servers pick changes up within 3 s): set the mode, turn rules off, show / remove allow-deny entries, or (dev only) add sample traffic.',
    flags: { all: b('rules disable / lists remove: every rule / entry'), count: s('n', 'simulate: requests to add', '300'), hours: s('h', 'simulate: spread over the last h hours', '24'), clear: b('simulate: remove the simulated traffic') },
    examples: ['tvine shield mode log', 'tvine shield rules disable --all', 'tvine shield lists remove 203.0.113.7'] },

  inspect: { group: 'Tools', usage: '[url]', args: [0, 1], desc: "Dev inspector on 127.0.0.1: the page and the agent's view side by side, with a live command feed.",
    flags: { port: s('n', "the inspector's port", '7357') }, examples: ['tvine inspect', 'tvine inspect http://127.0.0.1:4610 --port 4611'] },
  docs: { group: 'Tools', args: [0, 0], desc: "Print the guides' URL.", flags: { ai: b('print the AI-assistant guide (AGENTS.md) instead'), path: b('with --ai: only its file path') }, examples: ['tvine docs', 'tvine docs --ai --path'] },
  help: { group: 'Tools', usage: '[command]', args: [0, 1], desc: 'Every command, or one command\'s usage, flags and examples.', flags: {}, examples: ['tvine help', 'tvine help worker'] },
}

const flagUsage = ([n, f]: [string, Flag]) => f.type === 'boolean' ? `[--${n}]` : `[--${n} ${f.arg}]`
const flagName = (n: string, f: Flag) => `${f.short ? `-${f.short}, ` : ''}--${n}${f.type === 'string' ? ` ${f.arg}` : ''}`
export const usageLine = (name: string): string => { const c = COMMANDS[name]!; return ['tvine', name, c.usage, ...Object.entries(c.flags).map(flagUsage)].filter(Boolean).join(' ') }
function flagList(flags: Record<string, Flag>): string[] {
  const rows = Object.entries(flags).map(([n, f]) => [flagName(n, f), f.desc + (f.default !== undefined ? ` (default: ${f.default})` : '')] as const)
  const w = Math.max(...rows.map((r) => r[0].length))
  return rows.map(([a, d]) => `  ${a.padEnd(w)}  ${d}`)
}
const flagsOf = (name: string) => ({ ...COMMANDS[name]!.flags, ...GLOBAL_FLAGS })
export const flagsHelp = (name: string): string => [`flags for tvine ${name}:`, ...flagList(flagsOf(name))].join('\n')
// `tvine <command> --help` / `tvine help <command>`
export function commandHelp(name: string): string {
  const c = COMMANDS[name]!
  return [`usage: ${usageLine(name)}`, '', c.desc, '', 'flags:', ...flagList(flagsOf(name)), '', 'examples:', ...c.examples.map((e) => `  ${e}`)].join('\n')
}
// `tvine` / `tvine help`: every command by group
export function usageText(): string {
  const out = ['usage: tvine <command> [flags]   (every command: --apps ./apps, --settings config/settings/prod or TVINE_SETTINGS)', 'tvine help <command> (or tvine <command> --help): its flags, defaults and examples']
  for (const g of GROUPS) {
    out.push('', g)
    for (const [n, c] of Object.entries(COMMANDS)) if (c.group === g) out.push(`  ${usageLine(n).slice('tvine '.length)}`, `      ${c.desc.split(/(?<=\.)\s/)[0]}`)
  }
  return out.join('\n')
}
// docs/cli.md's command reference (between its cli-reference markers; cli-docs.test.ts keeps them equal)
export function cliReference(): string {
  const cell = (t: string) => t.replace(/\|/g, '\\|')
  const row = (f: string, x: Flag) => `| \`${cell(flagName(f, x))}\` | ${x.default !== undefined ? `\`${cell(x.default)}\`` : '-'} | ${cell(x.desc)} |`
  const out: string[] = ['### Every command', '', '| Flag | Default | What it does |', '|---|---|---|', ...Object.entries(GLOBAL_FLAGS).map(([f, x]) => row(f, x)), '']
  for (const g of GROUPS) {
    out.push(`### ${g}`, '')
    for (const [n, c] of Object.entries(COMMANDS)) {
      if (c.group !== g) continue
      out.push(`#### \`tvine ${n}\``, '', '```', usageLine(n), '```', '', c.desc, '')
      if (Object.keys(c.flags).length) {
        out.push('| Flag | Default | What it does |', '|---|---|---|')
        for (const [f, x] of Object.entries(c.flags)) out.push(row(f, x))
        out.push('')
      }
      out.push('```bash', ...c.examples, '```', '')
    }
  }
  return out.join('\n').trimEnd()
}
// the closest name within a small edit distance (a typo), or undefined
export function closest(word: string, names: readonly string[]): string | undefined {
  let best: string | undefined, bestD = Infinity
  for (const n of names) { const x = editDistance(word, n); if (x < bestD) { best = n; bestD = x } }
  return bestD <= Math.max(1, Math.min(3, Math.floor(word.length / 3))) ? best : undefined
}
