# Installation

npm package name: `tvinejs` (you import it and run it as `tvine`).

## Requirements

- Node.js 22.15 or newer
- pnpm 9
- Nothing else for development: the default database is a SQLite file. Postgres and MySQL need their driver (`pg`, `mysql2`) installed in your app.

## Get the repo and build it

Clone [github.com/zohaib3249/tvine](https://github.com/zohaib3249/tvine), then in its folder:

```bash
pnpm install
pnpm -r build          # warp, weft, admin, inspect + the example Next app
```

## Getting the `tvine` command

`tvine` is the CLI that ships with the `tvine` package. A bare `tvine start` in a shell says "command not found" until you pick one of these:

1. **Inside a project** (what these docs use): `pnpm exec tvine <cmd>` or `npx tvine <cmd>`, or a package.json
   script such as `"dev": "tvine dev"`, then `pnpm dev`.
2. **Global**: `npm i -g tvinejs` (gives the `tvine` command) (from a clone: `cd packages/tvine && npm link`). Now `tvine` works in any folder.
   Undo with `npm unlink -g tvinejs`.

## Run the example app

```bash
cd examples/notes
pnpm exec tvine migrate
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com \
TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput
pnpm exec tvine dev --port 4400
```

- App: http://localhost:4400
- Admin: http://localhost:4400/admin
- What an agent sees: `curl -H 'x-tvine: 1' http://localhost:4400/`

## Create a project

`npm install tvine@npm:tvinejs` (npm name is tvinejs; you import it as tvine) gives the backend, frontend, admin, inspector, forms and the `tvine` CLI in one package.

```bash
npx tvinejs startproject my-app [--db postgres] [--no-admin] [--local]
cd my-app && pnpm install
pnpm exec tvine migrate
pnpm exec tvine createsuperuser
pnpm exec tvine dev                             # opens the Tvine welcome page
pnpm exec tvine startapp blog                   # apps/blog stubs + installedApps + config/urls.ts
pnpm exec tvine shell                           # a REPL with your models loaded
```

The generated project:

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

## A new project by hand

Until the scaffolder lands (and the packages are on npm), Build your app inside this repo, in `apps/<name>/` or `examples/<name>/`
(both are pnpm workspace folders), so `workspace:*` dependencies resolve.

The smallest working app is [examples/notes](../examples/notes). Copy it and rename it:

```
examples/notes/
├─ package.json        deps: tvine, next, react, zod
├─ settings.ts         Django settings.py (a one-file project; startproject makes config/settings/)
├─ urls.ts             optional REST paths (ROOT_URLCONF)
├─ next.config.ts
├─ apps/notes/         one app: models, views, urls, admin, tasks, migrations
├─ app/                Next.js pages
└─ components/
```

After copying, run `pnpm install` at the repo root so pnpm links the new folder, then in your app folder:

```bash
pnpm exec tvine migrate          # create the tables
pnpm exec tvine check            # settings + actions + migrations + frontend/backend boundary
pnpm exec tvine dev --port 4400  # Next dev server + Warp in one process
```

The full walkthrough, from an empty folder to a working app with admin, agents and background jobs, is
[getting-started.md](getting-started.md).

**Autoreload:** like Django's `runserver`, `tvine dev` restarts the server when backend code changes: anything
under `apps/` (models, views, serializers, actions, admin, tasks, urls…), `config/`, `.env*` or `tvine.config.*`.
It prints `tvine dev: apps/blog/views.ts changed, restarting…`, then `ready on :3000 (restarted in 1.2 s)` on the
same port. Pages and components (`app/`, `components/`, CSS) are not restarted: Next hot-reloads them. A file that
breaks the server (a syntax error in a model) prints `server exited (code 1)`; fix it and save, it starts again.
`tvine dev --noreload` runs one process and never restarts.

## Local network & port forwarding

`tvine dev` prints where the app is:

```
  Local:   http://localhost:3000
  Network: http://192.168.1.20:3000
```

- **Port:** if 3000 is busy, `tvine dev` takes the next free one (up to +20) and says `port 3000 in use, using 3001`. `--port` or `PORT` means exactly that port: busy fails. `tvine start` never switches ports.
- **Hosts (dev only):** localhost, 127.0.0.1, `[::1]`, this machine's LAN IPs and its hostname(`.local`) are accepted automatically, and Next's HMR (`allowedDevOrigins`) gets the same list, so a phone on the same Wi-Fi works.
- **Port forwarding:** add the tunnel's domain in settings (or `TVINE_DEV_ALLOWED_HOSTS=a.example.com,*.b.dev`):

```ts
dev: { allowedHosts: ['*.devtunnels.ms'] },        // VS Code port forwarding
dev: { allowedHosts: ['*.app.github.dev'] },       // GitHub Codespaces
dev: { allowedHosts: ['*.ngrok-free.app'] },       // ngrok
```

None of this applies in production: `tvine start` still needs `allowedHosts` listed.

## Run the tests

```bash
pnpm test                          # every package
pnpm -C packages/tvine test
```

More in [testing.md](testing.md).

## Gotchas

- `tvine start` runs in production mode. It refuses to boot without `TVINE_SECRET` (32+ chars) and
  `TVINE_ALLOWED_HOSTS`. For a local run use `tvine dev`, or see [deploy.md](deploy.md).
- `next.config.ts` must set `compress: false`
  (Warp compresses). Copy the one from `examples/notes`.
- After editing a package under `packages/`, rebuild it (`pnpm -r build`); apps import the built `dist/`.

Next: [settings-and-env.md](settings-and-env.md), [cli.md](cli.md).
