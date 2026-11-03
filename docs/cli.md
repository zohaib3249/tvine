# CLI: `tvine`

`tvine` is the management command. It comes with `tvine`; run it from your app folder (the one with
`settings.ts`):

```bash
pnpm exec tvine help              # every command
pnpm exec tvine worker --help     # one command: usage, every flag with its default, examples (also -h, tvine help worker)
```

Every command takes `--apps ./apps` (where your apps live; that is the default) and `--settings config/settings/prod`
(or `TVINE_SETTINGS`). `--help` / `-h` works anywhere on the line and never runs the command. A mistyped flag or
command names the closest real one (`unknown option '--queus'. Did you mean --queues?`) and lists the right flags.
`TVINE_DEBUG=1` prints stack traces on errors.

All examples below were run in `examples/notes`.

## Getting the `tvine` command

A bare `tvine` in a shell says "command not found" until you pick one:

1. Inside a project: `pnpm exec tvine <cmd>` / `npx tvine <cmd>`, or a script like `"dev": "tvine dev"` then `pnpm dev`.
2. Global: `npm i -g tvinejs` (gives the `tvine` command). From a clone: `cd packages/tvine && npm link`; undo with `npm unlink -g tvinejs`.

## Project layout

```
mysite/
├─ config/
│  ├─ settings/
│  │  ├─ base.ts            shared: installedApps, middleware, db, auth…
│  │  ├─ dev.ts             base + debug, local hosts (tvine dev, migrate, shell…)
│  │  ├─ prod.ts            base + env-driven secret / allowedHosts / db (tvine start)
│  │  └─ local.example.ts   copy to local.ts (git-ignored) for machine-only overrides
│  ├─ middleware/           your HTTP middleware: index.ts + example.ts (off until listed)
│  ├─ urls.ts               root URL table (settings.rootUrlconf)
│  └─ tasks.ts              job worker queues, beatSchedule (settings.tasksModule)
├─ apps/                    your apps, each listed in installedApps
├─ app/                     Next.js pages (the welcome page)
├─ .env.example  package.json  tsconfig.json  next.config.ts  README.md  .gitignore
```

**Which settings file runs**: `TVINE_SETTINGS=config/settings/prod` or
`tvine <cmd> --settings config/settings/prod`. Without it: `config/settings/prod` when `NODE_ENV=production`
(`tvine start` sets that), else `config/settings/dev` plus `config/settings/local.ts` if present. A project without
`config/settings/` (like examples/notes) uses its root `settings.ts`.

`tvine startapp blog` creates empty app stubs, adds `'blog'` to `installedApps` in
`config/settings/base.ts` and `path('blog/', include('blog.urls'))` to `config/urls.ts` (it prints the line instead
when the file has a shape it does not recognise; an entry already there is left alone):

```
apps/blog/
├─ models.ts        // Create your models here.
├─ views.ts         // Create your views here.
├─ admin.ts         // Register your models here.
├─ urls.ts          export const appName = 'blog'; export const urlpatterns = []
├─ tests/blog.test.ts
└─ migrations/
```

Optional app files (create them when you need them):

| File | What it holds |
|---|---|
| `rules.ts` | app-wide action rules: rate limits, permissions (an action's own rules win) |
| `serializers.ts` | per-node-type snapshot shaping: hide fields from agents, add computed ones |
| `middleware.ts` | action middleware that wraps only this app's actions |
| `tasks.ts` | background tasks (`defineTask`) |
| `hooks.ts` | `postMigrate` and other app hooks |

**installedApps** lists the apps that load: project apps by name (`'blog'` = `apps/blog/`), built-in apps as
`'tvine.<name>'`. Only listed apps load. A listed app with no folder, or a name listed twice, fails at boot;
`tvine check` warns about a folder in `apps/` that is not listed.

## Commands

Generated from the command spec (`packages/tvine/warp/src/cli/spec.ts`), the same one `tvine help` prints, so the
two never disagree. Guides: [deploy.md](deploy.md) (start, workers), [tasks-cache-email.md](tasks-cache-email.md)
(jobs), [models-and-orm.md](models-and-orm.md) (migrations), [shield.md](shield.md).

<!-- cli-reference: generated from packages/tvine/warp/src/cli/spec.ts; in packages/tvine/warp: UPDATE_CLI_DOCS=1 pnpm vitest run test/server/cli-help.test.ts -->

### Every command

| Flag | Default | What it does |
|---|---|---|
| `--apps ./apps` | `apps` | where your apps live |
| `--settings path` | - | the settings module to load (or TVINE_SETTINGS); default: config/settings/prod when NODE_ENV=production, else config/settings/dev |
| `-h, --help` | - | print this help and exit (works anywhere on the line; the command does not run) |

### Project

#### `tvine startproject`

```
tvine startproject <name> [dir] [--db sqlite|postgres|mysql] [--no-admin] [--no-tasks] [--pm pnpm|npm|yarn] [--no-install] [--local]
```

Create a ready-to-run project (settings, urls, a welcome page, admin and background jobs) and install its packages.

| Flag | Default | What it does |
|---|---|---|
| `--db sqlite\|postgres\|mysql` | `sqlite` | the database the project starts with |
| `--no-admin` | - | leave out tvine.admin |
| `--no-tasks` | - | leave out tvine.tasks (background jobs) |
| `--pm pnpm\|npm\|yarn` | `pnpm` | the package manager to install with |
| `--no-install` | - | write the files only; install yourself |
| `--local` | - | link this clone's packages instead of the npm ones |

```bash
npx tvinejs startproject my-app
tvine startproject shop ./shop --db postgres --pm npm
```

#### `tvine startapp`

```
tvine startapp <name>
```

Create apps/<name>/ with empty stubs, add it to installedApps and its include() to config/urls.ts.

```bash
tvine startapp blog
```

#### `tvine check`

```
tvine check
```

Check settings, actions, migrations, Redis, background job workers and the frontend/database boundary; print middleware order, env vars set (names only) and backends. Exit 1 on problems.

```bash
tvine check
tvine check --settings config/settings/prod
```

#### `tvine routes`

```
tvine routes
```

Print every action: id, app, params, permissions, whether it is an MCP tool.

```bash
tvine routes
```

#### `tvine show_urls`

```
tvine show_urls
```

Print the urls.ts routes: pattern, methods, name, action.

```bash
tvine show_urls
```

#### `tvine generate`

```
tvine generate [--check]
```

Write tvine-api.d.ts (the types for api.*).

| Flag | Default | What it does |
|---|---|---|
| `--check` | - | write nothing; exit 1 when the file is missing or stale (for CI) |

```bash
tvine generate
tvine generate --check
```

### Database

#### `tvine makemigrations`

```
tvine makemigrations [app] [--name x] [--allow-drop] [--merge] [--empty] [--check] [--dry-run]
```

Write migration files from model changes.

| Flag | Default | What it does |
|---|---|---|
| `--name x` | - | the new migration's name (default: generated from the changes) |
| `--allow-drop` | - | allow a migration that drops columns or tables |
| `--merge` | - | merge two migration leaves |
| `--empty` | - | an empty migration for [app] (needs the app) |
| `--check` | - | write nothing; exit 1 when a migration is missing (for CI) |
| `--dry-run` | - | print what would be written, write nothing |

```bash
tvine makemigrations
tvine makemigrations --check
tvine makemigrations blog --empty --name seed_tags
```

#### `tvine migrate`

```
tvine migrate [<app> [<target>|zero]] [--check] [--plan] [--fake]
```

Apply pending migrations. <app>: forward to its latest; <target>: forward or roll back to it; zero: unapply the whole app.

| Flag | Default | What it does |
|---|---|---|
| `--check` | - | apply nothing; exit 1 when anything is pending |
| `--plan` | - | print what would run, run nothing |
| `--fake` | - | mark as applied (or unapplied) without running the SQL |

```bash
tvine migrate
tvine migrate notes zero
tvine migrate --check
```

#### `tvine sqlmigrate`

```
tvine sqlmigrate <app> <migration> [--backwards]
```

Print the SQL of one migration for the connected database.

| Flag | Default | What it does |
|---|---|---|
| `--backwards` | - | the SQL of its rollback instead |

```bash
tvine sqlmigrate notes 0001_initial
```

#### `tvine showmigrations`

```
tvine showmigrations
```

List each app's migrations; [X] = applied.

```bash
tvine showmigrations
```

#### `tvine dumpdata`

```
tvine dumpdata [app[.model] …] [--output f.json]
```

Print fixtures as JSON, in foreign-key order (every model, or the apps / models named).

| Flag | Default | What it does |
|---|---|---|
| `--output f.json` | - | write to this file instead of stdout |

```bash
tvine dumpdata notes --output notes.json
```

#### `tvine loaddata`

```
tvine loaddata <f.json> …
```

Load fixture files in one transaction (upsert by primary key).

```bash
tvine loaddata notes.json
```

#### `tvine encryption`

```
tvine encryption rotate
```

Re-encrypt every encrypted field with the newest key in settings.encryption.keys.

```bash
tvine encryption rotate
```

### Run

#### `tvine dev`

```
tvine dev [--port n] [--host h] [--noreload]
```

Development server: Next with hot reload; the server restarts on any backend change (apps/, config/, .env…); tvine-api.d.ts is regenerated on save.

| Flag | Default | What it does |
|---|---|---|
| `--port n` | `3000` | the port (or PORT); a busy port moves to the next free one unless forced |
| `--host h` | `every interface` | the address to bind (or HOST) |
| `--noreload` | - | one process, no restart on changes |

```bash
tvine dev
tvine dev --port 4000
```

#### `tvine build`

```
tvine build
```

next build: the pages tvine start serves.

```bash
tvine build
```

#### `tvine start`

```
tvine start [--port n] [--host h] [--api-only] [--workers n|auto] [--with-worker] [--concurrency n] [--beat]
```

Production web server: pages (after tvine build), API, MCP. NODE_ENV=production by default, so it needs TVINE_SECRET and TVINE_ALLOWED_HOSTS. It runs no background jobs unless --with-worker is given: run `tvine worker --beat` next to it (about 30 s after start it warns once when no job worker is running). SIGTERM / SIGINT: graceful close, hard exit at 5 s (with --with-worker: the job grace + 5 s).

| Flag | Default | What it does |
|---|---|---|
| `--port n` | `3000` | the port (or PORT) |
| `--host h` | `every interface` | the address to bind (or HOST) |
| `--api-only` | - | no frontend: Next runs separately with TVINE_API_URL |
| `--workers n\|auto` | `1` | web worker processes on one port (or WEB_CONCURRENCY; the flag wins); auto = CPU cores; a crashed one is restarted; more than 1 needs every backend on Redis (it refuses and lists what to change) |
| `--with-worker` | - | also run a job worker inside the web process (small single-process sites); with --workers > 1 only web worker 1 runs it |
| `--concurrency n` | `10` | with --with-worker: jobs at once |
| `--beat` | - | with --with-worker: also run the scheduler (cron / every) |

```bash
tvine start
tvine start --workers auto
tvine start --with-worker --beat
```

#### `tvine shell`

```
tvine shell
```

Node REPL with settings loaded, the database configured and every model by name (await works).

```bash
tvine shell
```

#### `tvine test`

```
tvine test [vitest args]
```

vitest run; every argument after `test` goes to vitest.

```bash
tvine test
tvine test apps/blog
```

### Users

#### `tvine createsuperuser`

```
tvine createsuperuser [--username u] [--email e] [--noinput]
```

Create a staff superuser (tvine.auth). Prompts for what is missing.

| Flag | Default | What it does |
|---|---|---|
| `--username u` | - | the username |
| `--email e` | - | the email |
| `--noinput` | - | no prompts: read TVINE_SUPERUSER_USERNAME / _EMAIL / _PASSWORD |

```bash
tvine createsuperuser
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=a@example.com TVINE_SUPERUSER_PASSWORD='change-me-42' tvine createsuperuser --noinput
```

#### `tvine changepassword`

```
tvine changepassword <username>
```

Set a user's password (tvine.auth; prompts, needs a terminal).

```bash
tvine changepassword admin
```

#### `tvine privacy`

```
tvine privacy export|erase <username> [--output file] [--yes]
```

tvine.auth: a user's data as JSON (export), or anonymize / delete it per model onErase (erase).

| Flag | Default | What it does |
|---|---|---|
| `--output file` | - | export: write to this file (mode 600) instead of stdout |
| `--yes` | - | erase: confirm (it cannot be undone) |

```bash
tvine privacy export alice --output alice.json
tvine privacy erase alice --yes
```

### Jobs

#### `tvine worker`

```
tvine worker [--queues a,b] [--concurrency n] [--beat] [--name x] [--grace ms]
```

Run a job worker (tvine.tasks): claims queued jobs with leases, so each job runs once; a dead worker's lease expires and another takes its job. Run as many as you like. SIGTERM: stop claiming, finish or release running jobs within the grace.

| Flag | Default | What it does |
|---|---|---|
| `--queues a,b` | `config/tasks.ts queues, else *` | the queues to take jobs from; * = every queue |
| `--concurrency n` | `10` | jobs at once in this worker |
| `--beat` | - | also run the scheduler (cron / every); several --beat workers are safe: one leads, the others stand by and take over in ~30 s |
| `--name x` | `<host>:<pid>:<random>` | the worker name shown in tasks list / admin |
| `--grace ms` | `settings.tasks.graceMs (30000)` | on stop: how long running jobs may finish before they are released |

```bash
tvine worker --beat
tvine worker --queues emails,default --concurrency 20
tvine worker --name reports-1 --grace 60000
```

#### `tvine tasks`

```
tvine tasks list | inspect <id> | retry <id> | purge --dead | compact | bench [--status s] [--queue q] [--limit n] [--dead] [--jobs n] [--workers n] [--batch n]
```

Look at and fix background jobs: list them, show one, re-queue a dead one, delete dead ones, compact the file broker, or measure the broker.

| Flag | Default | What it does |
|---|---|---|
| `--status s` | - | list: only this status: queued, running, success, dead, expired, cancelled or deduped |
| `--queue q` | - | list: only this queue |
| `--limit n` | `50` | list: at most n rows |
| `--dead` | - | purge: delete the dead jobs |
| `--jobs n` | `5000` | bench: jobs to push through |
| `--workers n` | `4` | bench: claimers at once |
| `--batch n` | `settings.tasks.claimBatch (10)` | bench: jobs per claim (max 100) |

```bash
tvine tasks list --status dead
tvine tasks retry <id>
tvine tasks bench --jobs 200
```

### Maintenance

#### `tvine audit`

```
tvine audit prune [--days n]
```

tvine.audit: delete audit rows older than n days.

| Flag | Default | What it does |
|---|---|---|
| `--days n` | `settings.audit.retentionDays` | keep this many days |

```bash
tvine audit prune
tvine audit prune --days 90
```

#### `tvine shield`

```
tvine shield mode off|log|enforce | rules disable <id> | lists [remove <value>] | simulate [--all] [--count n] [--hours h] [--clear]
```

tvine.shield escape hatch (running servers pick changes up within 3 s): set the mode, turn rules off, show / remove allow-deny entries, or (dev only) add sample traffic.

| Flag | Default | What it does |
|---|---|---|
| `--all` | - | rules disable / lists remove: every rule / entry |
| `--count n` | `300` | simulate: requests to add |
| `--hours h` | `24` | simulate: spread over the last h hours |
| `--clear` | - | simulate: remove the simulated traffic |

```bash
tvine shield mode log
tvine shield rules disable --all
tvine shield lists remove 203.0.113.7
```

### Tools

#### `tvine inspect`

```
tvine inspect [url] [--port n]
```

Dev inspector on 127.0.0.1: the page and the agent's view side by side, with a live command feed.

| Flag | Default | What it does |
|---|---|---|
| `--port n` | `7357` | the inspector's port |

```bash
tvine inspect
tvine inspect http://127.0.0.1:4610 --port 4611
```

#### `tvine docs`

```
tvine docs [--ai] [--path]
```

Print the guides' URL.

| Flag | Default | What it does |
|---|---|---|
| `--ai` | - | print the AI-assistant guide (AGENTS.md) instead |
| `--path` | - | with --ai: only its file path |

```bash
tvine docs
tvine docs --ai --path
```

#### `tvine help`

```
tvine help [command]
```

Every command, or one command's usage, flags and examples.

```bash
tvine help
tvine help worker
```

<!-- /cli-reference -->

Inside a project the full docs ship in the package: `node_modules/tvine/llms-full.txt` (everything in one file) and
`node_modules/tvine/docs/<topic>.md`.

## Gotchas

- `start` is production mode: no secret or no allowed hosts → it exits with the fix in the message. Use `dev`
  locally.
- `start` runs no background jobs (unless `--with-worker`): run `tvine worker --beat` next to it. About 30 s after
  start, a server whose jobs nobody runs prints once:
  `tvine start: background jobs are queued but no job worker is running. Start one: tvine worker --beat   (see docs/deploy.md#background-jobs)`.
  See [deploy.md](deploy.md#how-a-tvine-app-runs-in-production).
- `changepassword` needs an interactive terminal; in scripts use `createsuperuser --noinput` or the admin.
- `audit prune` without `tvine.audit` installed exits 1 with "add 'tvine.audit' to settings.installedApps".
- `inspect` binds to 127.0.0.1 and is for development only.

## Releasing

Bump `packages/tvine/package.json`, commit to `main`, then `git tag vX.Y.Z && git push --tags`. See [releasing.md](releasing.md).
