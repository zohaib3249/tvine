# CLI: `tvine`

`tvine` is Django's `manage.py`. It comes with `tvine`; run it from your app folder (the one with
`settings.ts`):

```bash
pnpm exec tvine            # prints every command
```

Global flag: `--apps ./apps` (where your apps live; that is the default).
`TVINE_DEBUG=1` prints stack traces on errors.

All examples below were run in `examples/notes`.

## Getting the `tvine` command

A bare `tvine` in a shell says "command not found" until you pick one:

1. Inside a project: `pnpm exec tvine <cmd>` / `npx tvine <cmd>`, or a script like `"dev": "tvine dev"` then `pnpm dev`.
2. Global: `npm i -g tvinejs` (gives the `tvine` command). From a clone: `cd packages/tvine && npm link`; undo with `npm unlink -g tvinejs`.

## Scaffolding

| Command | What it does |
|---|---|
| `npx tvinejs startproject my-app` | new project with a welcome page |
| `tvine startproject <name> [--db …] [--no-admin] [--local]` | same, from the CLI |
| `tvine startapp <name>` | `apps/<name>/` empty stubs; adds it to `installedApps` and its `include()` to `config/urls.ts` |
| `tvine shell` | REPL with settings and models loaded |

Every command takes `--settings config/settings/prod` (or `TVINE_SETTINGS`), like Django's `--settings`.

```
mysite/
├─ config/
│  ├─ settings/
│  │  ├─ base.ts            shared: installedApps, middleware, db, auth…
│  │  ├─ dev.ts             base + debug, local hosts (tvine dev, migrate, shell…)
│  │  ├─ prod.ts            base + env-driven secret / allowedHosts / db (tvine start)
│  │  └─ local.example.ts   copy to local.ts (git-ignored) for machine-only overrides
│  ├─ middleware/           your HTTP middleware: index.ts + example.ts (off until listed)
│  ├─ urls.ts               Django ROOT_URLCONF (settings.rootUrlconf)
│  └─ tasks.ts              Celery-like: worker queues, beatSchedule (settings.tasksModule)
├─ apps/                    your Django apps, each listed in installedApps
├─ app/                     Next.js pages (the welcome page)
├─ .env.example  package.json  tsconfig.json  next.config.ts  README.md  .gitignore
```

**Which settings file runs** (Django `DJANGO_SETTINGS_MODULE`): `TVINE_SETTINGS=config/settings/prod` or
`tvine <cmd> --settings config/settings/prod`. Without it: `config/settings/prod` when `NODE_ENV=production`
(`tvine start` sets that), else `config/settings/dev` plus `config/settings/local.ts` if present. A project without
`config/settings/` (like examples/notes) uses its root `settings.ts`.

`tvine startapp blog` creates empty Django-style stubs, adds `'blog'` to `installedApps` in
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

**installedApps** is Django's `INSTALLED_APPS`: project apps by name (`'blog'` = `apps/blog/`), built-in apps as
`'tvine.<name>'`. Only listed apps load. A listed app with no folder, or a name listed twice, fails at boot;
`tvine check` warns about a folder in `apps/` that is not listed.

## Serve

| Command | What it does |
|---|---|
| `start [--port 3000] [--host h] [--api-only]` | Production server: Warp + Next in one process. Needs `next build` first. Defaults to `NODE_ENV=production`, so it needs `TVINE_SECRET` and `TVINE_ALLOWED_HOSTS`. `--api-only` serves only the backend (run Next separately with `TVINE_API_URL`). SIGTERM / SIGINT close gracefully, hard exit at 5 s |
| `dev [--port 3000] [--host h]` | Django `runserver`: Next dev server with hot reload, `tvine-api.d.ts` regenerated on save |
| `inspect [url] [--port 7357]` | Dev inspector: the human page and the agent's view side by side, with a live command feed |

```bash
pnpm exec tvine dev --port 4612
# listening on http://localhost:4612 (bound to [::], every interface)

TVINE_SECRET=$(openssl rand -hex 32) TVINE_ALLOWED_HOSTS=localhost,127.0.0.1 TVINE_SESSION_SECURE=0 \
  pnpm exec tvine start --port 4610

pnpm exec tvine inspect http://127.0.0.1:4610 --port 4611
# inspector on http://127.0.0.1:4611 -> http://127.0.0.1:4610
```

## Check and introspect

| Command | What it does |
|---|---|
| `check` | Settings, actions, migrations and the frontend/backend boundary (a page importing a model). Exit 1 on problems. Prints middleware order, env vars set (names only), backends |
| `routes` | Every action: id, app, params, permissions, whether it is an MCP tool |
| `show_urls` | The `urls.ts` routes: pattern, methods, name, action |
| `generate [--check]` | Write `tvine-api.d.ts` (types for `api.*`). `--check` exits 1 when the file is stale (for CI) |

```bash
pnpm exec tvine show_urls
# pattern                   methods  name         action
# /api/notes/               GET      notes:notes  notes.list
# /api/notes/<int:id>/pin/  POST     notes:pin    notes.pin
```

## Database

| Command | What it does |
|---|---|
| `makemigrations [app] [--name x] [--allow-drop] [--merge] [--empty] [--check] [--dry-run]` | Write migration files from model changes. `--check`: exit 1 if one is missing. `--allow-drop`: allow dropping columns/tables. `--merge`: merge two leaves. `--empty`: an empty migration for `app` |
| `migrate [<app> [<target>\|zero]] [--check] [--plan] [--fake]` | Apply pending migrations. With `<app> <target>`: go forward or roll back to that migration; `zero` unapplies the whole app. `--plan` prints what would run, `--check` exits 1 if anything is pending, `--fake` marks as applied without running |
| `sqlmigrate <app> <migration> [--backwards]` | Print the SQL of one migration (or of its rollback) |
| `showmigrations` | Each app's migrations, `[X]` applied |
| `dumpdata [app[.model] …] [--output f.json]` | Fixtures as JSON, in foreign-key order |
| `loaddata <f.json> …` | Load fixtures in one transaction (upsert by pk) |

```bash
pnpm exec tvine migrate notes zero      # → unapplied notes.0001_initial
pnpm exec tvine migrate notes           # → applied notes.0001_initial
pnpm exec tvine dumpdata notes --output notes.json
pnpm exec tvine loaddata notes.json     # → installed N object(s) from 1 fixture(s)
```

More: [models-and-orm.md](models-and-orm.md).

## Users (needs `tvine.auth`)

| Command | What it does |
|---|---|
| `createsuperuser [--username u] [--email e] [--noinput]` | Make a staff superuser. `--noinput` reads `TVINE_SUPERUSER_USERNAME`, `_EMAIL`, `_PASSWORD` |
| `changepassword <username>` | Set a password (prompts; needs a terminal) |
| `privacy export <user> [--output file]` | A user's data as JSON |
| `privacy erase <user> --yes` | Anonymize / delete a user's data (per model `onErase`). Refuses without `--yes` |

```bash
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com \
TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput
# Superuser created successfully.
pnpm exec tvine privacy export admin --output admin.json
```

## Background jobs (needs `tvine.tasks`)

| Command | What it does |
|---|---|
| `worker [--queues a,b] [--concurrency 10] [--beat] [--name x] [--grace ms]` | Run jobs. `--beat` also fires cron schedules. SIGTERM stops claiming and lets running jobs finish within the grace |
| `tasks list [--status s] [--queue q] [--limit n]` | Queued / running / dead jobs |
| `tasks inspect <id>` | One job in detail |
| `tasks retry <id>` | Re-queue a failed job |
| `tasks purge --dead` | Delete dead jobs |
| `tasks compact` | Vacuum the job database |
| `tasks bench [--jobs n] [--workers n] [--batch n]` | Raw jobs/s of the configured broker |

```bash
pnpm exec tvine worker
# worker <host>:<pid>:<id>: 2 task(s), broker file, queues *, concurrency 10
pnpm exec tvine tasks list
# ID  TASK  STATUS  TRIES  QUEUE  CREATED
pnpm exec tvine tasks bench --jobs 200
# file: 200 jobs · enqueue 10342/s ... · claim+complete 11400 jobs/s ...
```

More: [tasks-cache-email.md](tasks-cache-email.md).

## Maintenance

| Command | What it does |
|---|---|
| `audit prune [--days n]` | Delete audit rows older than n days (default `settings.audit.retentionDays`). Needs `tvine.audit` in `installedApps` |
| `encryption rotate` | Re-encrypt every encrypted field with the newest key in `settings.encryption.keys` |
| `shield mode off\|log\|enforce` | Change the Shield mode; running servers pick it up within 3 s. Needs `tvine.shield` |
| `shield rules disable <id>\|--all` | Turn off one Shield rule, or all of them (the lock-out escape hatch) |
| `shield lists` / `shield lists remove <value>\|--all` | Show Shield's allow / deny entries, or remove one (e.g. your own IP denied by mistake) |
| `shield simulate [--count n] [--hours h]` / `--clear` | Dev only (`debug` on): realistic sample traffic from public IPs through your rules, tagged `simulated.tvine`; `--clear` removes it |

```bash
pnpm exec tvine encryption rotate     # → re-encrypted 0 row(s) with the newest key
```

## Gotchas

- `start` is production mode: no secret or no allowed hosts → it exits with the fix in the message. Use `dev`
  locally.
- `changepassword` needs an interactive terminal; in scripts use `createsuperuser --noinput` or the admin.
- `audit prune` without `tvine.audit` installed exits 1 with "add 'tvine.audit' to settings.installedApps".
- `inspect` binds to 127.0.0.1 and is for development only.

## Releasing

Bump `packages/tvine/package.json`, commit to `main`, then `git tag vX.Y.Z && git push --tags`. See [releasing.md](releasing.md).
