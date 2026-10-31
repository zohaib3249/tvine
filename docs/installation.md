# Installation

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
2. **Global**: `npm i -g tvine` (from a clone: `cd packages/tvine && npm link`). Now `tvine` works in any folder.
   Undo with `npm unlink -g tvine`.

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

`npm install tvine` gives the backend, frontend, admin, inspector, forms and the `tvine` CLI in one package.

```bash
npx tvine startproject my-app [--db postgres] [--no-admin] [--local]
cd my-app && pnpm install
pnpm exec tvine migrate
pnpm exec tvine createsuperuser
pnpm exec tvine dev                             # opens the Tvine welcome page
pnpm exec tvine startapp blog --model Post      # (new) adds apps/blog with a model, views, admin
pnpm exec tvine shell                           # (new) a REPL with your models loaded
```

## A new project by hand

Until the scaffolder lands (and the packages are on npm), Build your app inside this repo, in `apps/<name>/` or `examples/<name>/`
(both are pnpm workspace folders), so `workspace:*` dependencies resolve.

The smallest working app is [examples/notes](../examples/notes). Copy it and rename it:

```
examples/notes/
├─ package.json        deps: tvine, next, react, zod
├─ settings.ts         Django settings.py
├─ urls.ts             optional REST paths
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
