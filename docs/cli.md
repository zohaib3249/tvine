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
2. Global: `npm i -g tvine`. From a clone: `cd packages/tvine && npm link`; undo with `npm unlink -g tvine`.

## Scaffolding (new)

Not on this branch yet; marked (new) until the scaffolding release merges.

| Command | What it does |
|---|---|
| `npx tvine startproject my-app` | new project with a welcome page |
| `tvine startproject <name> [--db …] [--no-admin] [--local]` (new) | same, from the CLI |
| `tvine startapp <name> [--model Name]` (new) | adds `apps/<name>/` (models, views, admin, urls) |
| `tvine shell` (new) | REPL with settings and models loaded |

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
