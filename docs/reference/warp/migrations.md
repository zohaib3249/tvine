# Migrations and fixtures

Migrations work like Django's. Each app has code files `apps/<app>/migrations/NNNN_name.ts`, each exporting `migration({ dependencies, operations })`. There is no state file: the schema state is rebuilt by replaying every migration in dependency order, and `makemigrations` diffs that state against the current `models.ts`. `migrate` renders each operation for the connected database at apply time and records it in the table `__tvine_migrations (app, name, checksum, applied_at)`. Fixtures (`dumpdata` / `loaddata`) move rows in and out as JSON. Source: `warp/src/data/migrations.ts`, `migrate.ts`, `schema/*.ts`, `fixtures.ts`, `cli.ts`.

## Import

```ts
import { migration, ops, field } from 'tvine/migrations'          // inside migration files
import { makeMigrations, migrate, migrateCheck } from 'tvine'      // programmatic use
```

## CLI commands

| Command | Flags | What it does |
|---|---|---|
| `tvine makemigrations` | `--name x`, `--allow-drop`, `--merge`, `--empty`, `--check`, `--dry-run` | Diff models against migrations, write new files per changed app. |
| `tvine makemigrations <app> --empty` | `--name x` | Write an empty migration for hand-written operations. (An app argument works only with `--empty`.) |
| `tvine migrate` | `--plan`, `--fake`, `--check` | Apply every unapplied migration, then run apps' `postMigrate` hooks. |
| `tvine migrate <app>` | same | Apply that app up to its latest migration (and what it depends on). |
| `tvine migrate <app> <target>` | same | Go forward OR roll back to `<target>` (a name or a unique prefix like `0002`). |
| `tvine migrate <app> zero` | same | Roll back every migration of the app (and everything depending on them). |
| `tvine sqlmigrate <app> <migration>` | `--backwards` | Print the SQL for the connected database's dialect, with params. |
| `tvine showmigrations` | | Every migration per app, `[X]` applied / `[ ]` not. |
| `tvine dumpdata [app[.model] ...]` | `--output f.json` | Rows as fixture JSON (stdout or file). |
| `tvine loaddata <f.json> ...` | | Load fixture files in ONE transaction, upsert by pk. |
| `tvine check` | | Includes "migrations pending" and "models.ts changed since the last migration". |

| Flag | Meaning |
|---|---|
| `--name x` | Use `NNNN_x` instead of the automatic name. Letters, digits, `_`. |
| `--allow-drop` | Confirm a migration that removes fields or models. Without it `makemigrations` refuses. |
| `--merge` | For an app with two leaf migrations (two branches), write a merge migration depending on both. |
| `--empty` | Empty migration for `<app>`. |
| `--check` (makemigrations) | Dry run; exit 1 if a migration would be written. |
| `--dry-run` | Report the files, write nothing. |
| `--plan` | List what would apply (or roll back); touch nothing. |
| `--fake` | Record as applied (or unapplied) without running SQL. |
| `--check` (migrate) | Exit 1 if migrations are pending, edited, conflicting, or models drifted. Takes no app / target. |

`--check`, `--plan` and `--fake` are mutually exclusive on `migrate`.

## Automatic names

`0001_initial` for an app's first migration. Later ones join one fragment per operation: `<model>` (createModel), `delete_<model>`, `<model>_<field>` (addField), `remove_<model>_<field>`, `alter_<model>_<field>`. Any other operation, or a name over 52 characters, gives `NNNN_auto`. Numbers are the app's highest + 1, zero-padded to 4.

## File format

```ts
// apps/shop/migrations/0002_product_stock.ts
import { migration, ops, field } from 'tvine/migrations'

export default migration({
  dependencies: [
    ['shop', '0001_initial'],
  ],
  operations: [
    ops.addField('product', 'stock', field.int({ default: 0 })),
  ],
})
```

| Part | Meaning |
|---|---|
| `dependencies` | `[app, 'NNNN_name']` pairs. Its own app's previous migration, plus the latest migration of any app it points an fk at. |
| `operations` | Run in order. |
| `field` | Same builders as models, except `field.fk('customer', opts)` and `field.m2m('tag', { through?: 'product_tag', ... })` take the target model NAME (a migration never imports models). |

Files are found by the pattern `NNNN_name.(ts|mts|js|mjs)`; a `.ts` wins over a `.js` of the same name. A file that removes something starts with `// DESTRUCTIVE: drops ...`. Generated files are deterministic.

Checksum: `sha256` of the migration's data (dependencies + operations, key-sorted). Comments and formatting do not count. Editing the data of an applied migration makes `migrate` fail with `migration <app>.<name> was edited after it was applied`.

## Operations (`ops`)

| Operation | Signature | Reverse (rollback) |
|---|---|---|
| `createModel` | `ops.createModel(model, fields, meta?: { indexes?: Record<name, { fields, unique? }>; unique?: string[][]; constraints?: Record<name, ConstraintSpec> })` | deleteModel |
| `deleteModel` | `ops.deleteModel(model)` | recreate from the previous state |
| `addField` | `ops.addField(model, name, field)` | removeField |
| `removeField` | `ops.removeField(model, name)` | addField from the previous state; refused if the field was required without a default, or if removing it also dropped constraints |
| `alterField` | `ops.alterField(model, name, field)` | alterField back to the previous spec |
| `renameField` | `ops.renameField(model, from, to)` | rename back |
| `renameModel` | `ops.renameModel(from, to)` | rename back |
| `addIndex` | `ops.addIndex(model, name, fields, { unique? })` | removeIndex |
| `removeIndex` | `ops.removeIndex(model, name)` | addIndex |
| `addConstraint` | `ops.addConstraint(model, CheckConstraint(...) \| UniqueConstraint(...))` | removeConstraint |
| `removeConstraint` | `ops.removeConstraint(model, name)` | addConstraint |
| `alterUniqueTogether` | `ops.alterUniqueTogether(model, unique: string[][])` | the previous sets |
| `runSQL` | `ops.runSQL(sql, { reverse? })` | `reverse`; without it the migration cannot be rolled back |

`runSQL` arguments: `sql` is a string, an array of strings (one per statement), or a per-database object `{ sqlite?, postgres?, mysql? }` of those. `reverse` has the same shape; `[]` means "nothing to undo". A per-database object missing the connected database throws `runSQL has no SQL for <db>`.

What the autodetector writes:

- Removals first (Meta constraints / indexes / unique sets that changed, then removed fields, then deleted models), then new models (fk targets first), new fields, altered fields, and last the new Meta indexes / unique sets / constraints.
- Renames are never guessed: a renamed field is `removeField` + `addField` and needs `--allow-drop`. The error message prints the `ops.renameField(...)` / `ops.renameModel(...)` line to write by hand instead.
- Field options with no DDL (`hidden`, `readOnly`, `writeOnly`, `relatedName`, `humanOnly`, `allowRemoteImages`) never appear in migrations.

## What makemigrations refuses

| Situation | Message (short) | Do instead |
|---|---|---|
| A field or model would be dropped | `refusing to write a migration that drops ...` | `--allow-drop`, or write `ops.renameField` / `ops.renameModel` |
| New required field, no default | `field <m>.<f> is required and has no default` | add `default`, make it `optional`, or add in two steps (optional, backfill, then required) |
| Column set changes (int → fk, money ↔ scalar) | `column shape changed for <m>.<f>` | `removeField` + `addField` (`--allow-drop`) or `runSQL` |
| Two leaf migrations in one app | `conflicting migrations in <app>` | `makemigrations --merge` |
| Circular fk dependency across apps | `circular migration dependency` | split the fk into a later migration |

`alterField` is also refused at migrate time when it would round stored values (`<type> → <type>`), change an fk target, or change an m2m's kind / target / through. Renaming an auto m2m field, or a model that owns or is the target of an auto m2m, needs `runSQL`. A required `autoNow` / `autoNowAdd` field added to an existing table is added nullable, backfilled with the migration time, then made required.

## How migrate runs

| Database | Behaviour |
|---|---|
| SQLite | One transaction per migration (with its journal row). Foreign keys are turned off for the migration and `PRAGMA foreign_key_check` runs before commit. SQLite cannot ALTER a column, so `alterField` / `removeField` rebuild the table (create new, copy, drop, rename, re-index). |
| Postgres | One transaction per migration; native `ALTER`. A transaction-level advisory lock serializes concurrent `migrate` runs; a migration another run already applied is skipped. |
| MySQL / MariaDB | DDL auto-commits, so each statement is applied and journaled on its own (`NNNN_name#op.stmt` rows). After a failure, fix the cause and run `migrate` again: it resumes. A session lock (`GET_LOCK`, 600 s) serializes concurrent runs. |

After a non-`--plan` run, the CLI calls every installed app's `hooks.ts` `postMigrate({ app, models, applied })` (tvine.auth creates permission rows there).

Rollback computes every reverse statement before running any, so an irreversible operation (runSQL without `reverse`, a lossy change) refuses with nothing touched.

## Built-in app migrations

Contrib apps (`tvine.auth`, `tvine.tasks`, `tvine.admin`, `tvine.audit`, `tvine.shield`) ship their own migrations under their label (`auth`, `tasks`, ...). They join the graph when the app is in `installedApps`, are never written by `makemigrations`, and `makemigrations --empty auth` is refused. With a custom `settings.auth.userModel`, tvine.auth's migrations are rewritten to point at your user table and depend on your user app's first migration.

## Programmatic API

```ts
makeMigrations(appsDir: string, opts?: { name?: string; allowDrop?: boolean; merge?: boolean; empty?: string; dryRun?: boolean; installed?: readonly string[] }): Promise<{ files: string[]; message: string }>
migrate(db: string | Connection, appsDir: string, opts?: { plan?: boolean; fake?: boolean; app?: string; target?: string; installed?: readonly string[] }): Promise<{ applied: string[]; unapplied?: string[] }>
migrateCheck(db: string | Connection, appsDir: string, opts?: { installed?: readonly string[] }): Promise<boolean>
```

`db` is a database URL (opened and closed for the call) or an open connection. `installed` is `settings.installedApps`; leave it out and contrib apps are not included. These do not run `postMigrate` hooks (the CLI does).

## Data migrations

There is no `RunPython` operation. Options the code offers:

- `ops.runSQL(...)` with per-database SQL and a `reverse`.
- An empty migration (`makemigrations <app> --empty`) holding `runSQL`.
- Changing data with the ORM from a script, an action, or a `postMigrate` hook in `apps/<app>/hooks.ts`.

## Fixtures

Format (Django's): a JSON array of rows.

```json
[
  { "model": "shop.customer", "pk": 1, "fields": { "email": "ada@example.com", "name": "Ada", "joinedAt": "2026-11-03T10:00:00.000Z" } },
  { "model": "shop.product", "pk": 7, "fields": { "sku": "LAMP-1", "name": "Desk lamp", "price": { "value": 29.99, "currency": "USD" }, "stock": 4, "active": true, "tags": [1, 2], "updatedAt": "2026-11-03T10:00:00.000Z" } },
  { "model": "shop.order", "pk": 1, "fields": { "customerId": 1, "status": "paid", "total": { "value": 59.98, "currency": "USD" }, "createdAt": "2026-11-03T10:05:00.000Z" } }
]
```

| Key | Meaning |
|---|---|
| `model` | `'<app>.<model name>'` (app label = folder name; model name as given to `defineModel`). |
| `pk` | The primary key value. |
| `fields` | Every other column by row key (`customerId` for an fk); datetimes as ISO strings; m2m (auto through only) as a list of target pks. |

`dumpdata` writes models in fk order (targets first), rows ordered by pk. `loaddata`:

- loads every given file in ONE `atomic()` block;
- creates a row if its pk is new, otherwise updates it (through `Model.create` / `Model.update`, so fields validate and convert as usual);
- orders rows so fk targets load first; required self-fks load parents first (a cycle is refused); optional self-fks are set after all rows exist;
- sets m2m lists with `related(name, pk).set(ids)`;
- resets Postgres id sequences afterwards.

Not covered: `dumpData` / `loadData` are not exported from `tvine`; use the CLI.

## Examples

Hand-written rename plus data fix:

```ts
// apps/shop/migrations/0003_rename_title.ts
import { migration, ops } from 'tvine/migrations'

export default migration({
  dependencies: [['shop', '0002_product_stock']],
  operations: [
    ops.renameField('product', 'title', 'name'),
    ops.runSQL(`UPDATE "product" SET "stock" = 0 WHERE "stock" < 0`, { reverse: [] }),
  ],
})
```

Per-database SQL:

```ts
ops.runSQL(
  { postgres: 'CREATE EXTENSION IF NOT EXISTS pg_trgm', sqlite: [], mysql: [] },
  { reverse: [] },
)
```

A model with an fk to another app, Meta index and constraint (what `makemigrations` writes):

```ts
import { migration, ops, field } from 'tvine/migrations'

export default migration({
  dependencies: [['shop', '0001_initial'], ['crm', '0001_initial']],
  operations: [
    ops.createModel('review', {
      id: field.id(),
      product: field.fk('product', { onDelete: 'CASCADE' }),
      customer: field.fk('customer', { onDelete: 'CASCADE' }),
      stars: field.int(),
    }, {
      indexes: { review_product_stars_idx: { fields: ['product', 'stars'] } },
      constraints: { review_stars_range: { kind: 'check', name: 'review_stars_range', check: { conn: 'and', items: [['stars__gte', 1], ['stars__lte', 5]] } } },
    }),
  ],
})
```

Typical workflow:

```bash
tvine makemigrations            # created shop/migrations/0002_product_stock.ts
tvine migrate --plan            # planned: shop.0002_product_stock
tvine migrate                   # applied shop.0002_product_stock
tvine migrate shop 0001         # roll back to 0001
tvine dumpdata shop --output shop.json
tvine loaddata shop.json        # installed 12 object(s) from 1 fixture(s)
```

## Gotchas

- Never edit an applied migration's operations; write a new one. Comments and formatting are safe.
- A rename needs a hand-written `ops.renameField` / `ops.renameModel`; letting `--allow-drop` through loses the column's data.
- `runSQL` without `reverse` makes the migration (and `migrate <app> <earlier>`) impossible to roll back.
- On MySQL a failed migration stays half-applied; `migrate` again resumes it. To change the migration instead, undo by hand and delete its `NNNN_name#...` rows from `__tvine_migrations`.
- Choose `settings.auth.userModel` before the first `migrate`.
- `migrate` does not run on server start; deploy scripts run `tvine migrate && tvine start` (the scaffolded `start` script).
- `makemigrations` writes constraints as plain data (`{ kind: 'check', name, check: { conn, items } }`). `CheckConstraint(...)` / `UniqueConstraint(...)` from `tvine` return that same data, so a hand-written file may use either.
- `ops.deleteModel` can be rolled back, but only the empty table comes back; its rows are gone.

Not covered by the code: `squashmigrations`, `RunPython`, `SeparateDatabaseAndState`, per-migration `atomic = False`, migrating several database aliases.

## See also

- [models.md](models.md) — Meta indexes, unique sets, constraints
- [fields.md](fields.md) — which options reach the DDL
- [database.md](database.md) — engines, `DATABASE_URL`, test databases
- [contrib/auth.md](contrib/auth.md) — custom user model and its migrations
- [overview.md](overview.md)
