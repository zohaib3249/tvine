# Installation

## Requirements

- Node.js 22.15 or newer
- pnpm 9
- Nothing else for development: the default database is a SQLite file. Postgres and MySQL need their driver (`pg`, `mysql2`) installed in your app.

## Get the repo and build it

Clone [github.com/zohaib3249/tvine](https://github.com/zohaib3249/tvine), then in its folder:

```bash
pnpm install
pnpm -r build          # warp, weft, admin, inspect + the demo and example Next apps (about 20 s)
```

## Run the demo shop

```bash
cd apps/demo-shop
pnpm demo              # migrate, seed 60 products, serve on http://localhost:3000
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin (create a login first, below)
- Health: http://localhost:3000/tvine/health

Make an admin login (run in `apps/demo-shop`):

```bash
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com \
TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput
```

## A new project

The packages are not on npm yet. Build your app inside this repo, in `apps/<name>/` or `examples/<name>/`
(both are pnpm workspace folders), so `workspace:*` dependencies resolve.

The smallest working app is [examples/notes](../examples/notes). Copy it and rename it:

```
examples/notes/
├─ package.json        deps: @tvine/warp, @tvine/weft, @tvine/admin, next, react, zod
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
pnpm --filter @tvine/warp test    # one package
```

More in [testing.md](testing.md).

## Gotchas

- `tvine start` runs in production mode. It refuses to boot without `TVINE_SECRET` (32+ chars) and
  `TVINE_ALLOWED_HOSTS`. For a local run use `pnpm demo` / `tvine dev`, or see [deploy.md](deploy.md).
- `next.config.ts` must list `@tvine/warp` in `serverExternalPackages` and set `compress: false`
  (Warp compresses). Copy the one from `examples/notes`.
- After editing a package under `packages/`, rebuild it (`pnpm -r build`); apps import the built `dist/`.

Next: [settings-and-env.md](settings-and-env.md), [cli.md](cli.md).
