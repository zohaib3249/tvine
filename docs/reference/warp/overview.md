# Warp overview

Warp is the backend half of Tvine: a TypeScript server with models, migrations, auth and admin. You define models (`defineModel`), write actions and views in each app, list the apps in settings, and run `tvine dev`. Every action is reachable four ways from one definition: a human `<Form>` on a Next.js page, plain HTTP at `/tvine/api/<app>.<name>`, optional REST paths from `urls.ts`, and an MCP tool at `/mcp` for AI agents. The data layer (ORM, migrations, fixtures, database drivers) lives in `warp/src/data/`; this folder documents all of it.

## Import

```ts
import { defineModel, field, defineSettings, defineAction, ListView, atomic } from 'tvine'
import { migration, ops, field as mfield } from 'tvine/migrations'   // only inside migration files
```

The npm package is `tvinejs`; projects install it under the name `tvine` (`"tvine": "npm:tvinejs@^0.3.0"`, written by `tvine startproject`), so code imports `'tvine'`.

## Project layout

`tvine startproject shop` writes this (from `warp/src/cli/scaffold.ts`):

| Path | What it is |
|---|---|
| `config/settings/base.ts` | Shared settings object (`satisfies SettingsInput`) |
| `config/settings/dev.ts` | `defineSettings({ ...base, debug: true, ... })`, used by `tvine dev / migrate / shell` |
| `config/settings/prod.ts` | Production settings; throws if `TVINE_SECRET`, `TVINE_ALLOWED_HOSTS`, `DATABASE_URL` are missing |
| `config/settings/local.ts` | Optional, git-ignored; merged over `dev.ts` (copy `local.example.ts`) |
| `config/urls.ts` | Root URL table (`urlpatterns`) |
| `config/tasks.ts` | Worker queues and beat schedule |
| `config/middleware/` | Your own HTTP middleware |
| `apps/<app>/` | One app, listed in `installedApps` |
| `app/` | Next.js pages (the Weft frontend) |
| `.env` | `TVINE_SECRET`, `DATABASE_URL` for development |

Which settings file loads: `TVINE_SETTINGS` (or `tvine --settings config/settings/prod`) names it. Unset: `config/settings/prod` when `NODE_ENV=production`, else `config/settings/dev` plus `config/settings/local` if present. A project without `config/settings/` uses `./settings.ts` (the `examples/notes` project does this).

Files Warp looks for inside `apps/<app>/` (each is optional; `.ts`, `.js` or `.mjs`):

| File | Loaded by | What goes in it |
|---|---|---|
| `models.ts` | `discoverModels` (migrations, `tvine shell`, fixtures) | exported `defineModel(...)` results |
| `migrations/NNNN_name.ts` | `MigrationGraph.load` | `export default migration({ dependencies, operations })` |
| `views.ts` | `discover` (boot) | exported `defineAction(...)` values and View classes; every export becomes actions |
| `serializers.ts` | `discover` | `export const serializers = {...}` used by generic views |
| `rules.ts` | `discover` | app-wide action rules |
| `admin.ts` | tvine.admin | model admin registrations |
| `tasks.ts` | tvine.tasks | `defineTask(...)` background jobs |
| `urls.ts` | `include('<app>.urls')` | `export const appName`, `export const urlpatterns` |
| `hooks.ts` | app signals | e.g. `postMigrate({ app, models, applied })` |
| `middleware.ts` | app middleware | per-app middleware |

Not covered: the code has no `actions.ts` discovery. Actions are exported from `views.ts` (as `defineAction` values or View class methods). If another reference page mentions `actions.ts`, it is a convention for a file you import from `views.ts`.

`tvine startapp blog` creates `apps/blog/{models,views,admin,urls}.ts`, `apps/blog/migrations/`, `apps/blog/tests/blog.test.ts`, and adds `'blog'` to `installedApps` and its `include()` to `config/urls.ts`.

## Request flow

Every command (HTTP, MCP, channel, WebMCP, a human form) runs the same pipeline in `core/dispatch.ts`. The first failure stops it and returns one `err` event.

1. Session is loaded.
2. `humanOnly` guard: an agent calling a human-only action (or changing a `humanOnly` field) gets `human_only`.
3. The action is resolved by id (`<app>.<name>`).
4. Permissions run (`rules.permissions`).
5. Signed bind is checked (values the page signed for this action).
6. Optimistic concurrency check.
7. Middleware (global, then the app's) wraps the next steps.
8. Params are validated with the action's zod schema.
9. `confirm` rule: the first call of a confirm-protected action runs nothing and answers `confirm_required` with a one-time token.
10. Handler runs. With `settings.db.atomicRequests` (default `true`) and the action not `readOnly` and not `rules.atomic: false`, the handler runs inside a lazy `atomic()` block: the transaction opens at the first query and commits when the handler returns, or rolls back if it throws.
11. Commit: session changes are applied, `onCommit` hooks run, events are flushed.
12. The reply carries `ok` and a fresh page snapshot.

ORM writes the handler did not `await` still finish (in call order) before the reply; see [queryset.md](queryset.md#await-or-not).

## How actions become MCP tools

- Boot calls `discover(appsDir)`: every installed app's `views.ts` exports are scanned. `defineAction(name, schema, fn, rules)` values and View classes (their generated actions plus `@action` methods) are registered with id `<app>.<name>`.
- `mcpTools()` (`transport/mcp.ts`) builds the MCP tool list: generic tools `read_page`, `expand`, `ui`, `do`, `request_control`, `release`, then one typed tool per action named with dots turned into underscores (`shop.placeOrder` → `shop_placeOrder`). Its input schema is the action's zod schema as JSON Schema.
- `settings.mcp.tools`: `'both'` (generic + typed), `'generic'`, or `'typed'`.
- An action gets no typed tool (but is still reachable via `do`) when: `rules.mcp === false`, its id matches a glob in `settings.mcp.exclude` (`*` = one dotted segment, `**` = any depth), it is human-only / staff-only / denies agents, its params schema is not an object, or the name collides.
- Over `settings.mcp.maxTools`, typed tools are trimmed to actions with `rules.priority`.
- `readOnlyHint` / `destructiveHint` annotations come from `rules.readOnly` / `rules.destructive`.

## A minimal app (shop)

```ts
// apps/shop/models.ts
import { defineModel, field, type Infer } from 'tvine'

export const Product = defineModel('product', {
  id: field.id(),
  name: field.text({ searchable: true }),
  price: field.money(),
  stock: field.int({ default: 0 }),
})
export type Product = Infer<typeof Product>
```

```bash
tvine makemigrations   # writes apps/shop/migrations/0001_initial.ts
tvine migrate          # creates the table
tvine dev              # http://localhost:3000, /admin, /mcp
```

## Gotchas

- The server never creates tables. Run `tvine migrate` first (also on test databases), or every write fails.
- A model's name is its table name and must be unique across the whole project, including contrib apps (`auth_user`, `tasks_job`, ...).
- Apps must be listed in `settings.installedApps`, or their models, views and migrations are not loaded.
- Pages call the backend only through `api.*` (generated `tvine-api.d.ts`, `tvine generate`); they never import models.

## See also

Data layer (this set):
- [models.md](models.md) — `defineModel`, Meta, relations, model API
- [fields.md](fields.md) — every field kind and option
- [queryset.md](queryset.md) — `Model.objects`, lookups, expressions, aggregates, pagination, transactions
- [migrations.md](migrations.md) — makemigrations, migrate, operations, fixtures
- [database.md](database.md) — SQLite / Postgres / MySQL, `settings.db`, connections

Rest of Warp:
- [actions.md](actions.md), [views.md](views.md), [serializers.md](serializers.md), [urls.md](urls.md)
- [middleware.md](middleware.md), [request.md](request.md), [errors.md](errors.md), [settings.md](settings.md)

Contrib apps:
- [contrib/auth.md](contrib/auth.md), [contrib/admin.md](contrib/admin.md), [contrib/tasks.md](contrib/tasks.md), [contrib/cache.md](contrib/cache.md)
- [contrib/email.md](contrib/email.md), [contrib/media.md](contrib/media.md), [contrib/audit.md](contrib/audit.md), [contrib/security.md](contrib/security.md)
