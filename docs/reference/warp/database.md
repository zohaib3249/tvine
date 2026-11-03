# Database

Warp talks to SQLite, PostgreSQL or MySQL / MariaDB through one small driver interface. Which one is used depends only on the database URL. Models never hold a connection: each query looks up the connection when it runs, so defining or importing models opens nothing, and the Postgres / MySQL pool connects on its first query. Source: `warp/src/data/db.ts`, `driver.ts`, `engine.ts`, `sql/dialect.ts`, `sql/dialects/*.ts`, `adapters/memory.ts`, `settings.ts`.

## Import

```ts
import { configureDb, closeDb, atomic, defineSettings } from 'tvine'
```

## Engines

| Engine | URL | Driver package | Notes |
|---|---|---|---|
| SQLite | `file:./tvine.db`, `file:/abs/path.db`, a bare path ending in `.db` / `.sqlite` / `.sqlite3`, `:memory:`, `file::memory:` | `better-sqlite3` (a dependency) | One connection per process. Opened with `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`. All operations go through one serial queue; `atomic()` uses `BEGIN IMMEDIATE`. |
| PostgreSQL | `postgres://...` or `postgresql://...` | `pg` (optional peer dependency: `npm i pg`) | `pg.Pool`, one connection per statement; `atomic()` holds one connection for the block. `int8` values come back as JS numbers (an unsafe integer throws). |
| MySQL / MariaDB | `mysql://...` or `mariadb://...` | `mysql2` (optional peer dependency: `npm i mysql2`) | Pool; every new connection gets strict `sql_mode`, `time_zone = '+00:00'`, `READ COMMITTED`, charset `utf8mb4_bin`. Server-side prepared statements. |

Any other URL is refused (`unsupported database url ...`); error messages never echo the user / password.

MySQL URL query parameters (anything else is refused):

| Param | Values | Meaning |
|---|---|---|
| `ssl` | `true`, `1`, `false`, `0` | TLS with certificate check, or none. |
| `sslmode` | `disable`, `require`, `verify-ca`, `verify-full` | `require` = encrypt without verifying the certificate; `verify-*` = verify. |

Postgres URLs are passed to `pg` as `connectionString`, so `pg`'s own URL options apply.

### Differences that show up in your code

| Topic | SQLite | Postgres | MySQL |
|---|---|---|---|
| DDL in a transaction | yes | yes | no (migrations resume step by step) |
| `INSERT ... RETURNING` | yes | yes | no: the row is read back by pk; `bulkCreate` returns the given rows without auto ids |
| `selectForUpdate()` | no-op (the write lock is already held) | `FOR UPDATE [OF] [NOWAIT \| SKIP LOCKED]` | same as Postgres |
| `distinct('field')` | refused | `DISTINCT ON` | refused |
| Unicode case-insensitive lookups | yes (custom `tv_lower`) | yes | yes |
| `datetime` storage | epoch ms integer | `TIMESTAMPTZ` | `DATETIME(3)` UTC, years 1000 to 9999 |
| `text` with `unique` / `index` | `TEXT` | `TEXT` | `VARCHAR(255)` |
| `onDelete: 'SET_DEFAULT'` | database | database | done by the ORM before the delete |
| Statement parameter limit used | 30 000 per statement (bulk writes are batched) | same | same |

Per-field column types: [fields.md](fields.md).

## settings.db

```ts
db: {
  url: string                     // default: DATABASE_URL, else 'file:./tvine.db'
  pool: { max: number; acquireMs: number; idleMs: number }
  atomicRequests: boolean
  slowQueryMs: number
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | `string` | `DATABASE_URL` env, else `'file:./tvine.db'` | Which database. An explicit setting wins over the env var. `DATABASE_URL` set but blank throws (it never silently falls back to SQLite). An empty `url` fails settings validation. |
| `pool.max` | `number` | `10` | Postgres / MySQL pool size. |
| `pool.acquireMs` | `number` | `5000` | Max wait for a free connection; then `DomainError('internal', 'db busy — retry')`. |
| `pool.idleMs` | `number` | `30000` | Idle connections close after this. |
| `atomicRequests` | `boolean` | `true` | Every action that is not `readOnly` (and not `rules.atomic: false`) runs in one lazy transaction. |
| `slowQueryMs` | `number` | `500` | A statement slower than this logs a `warn` on logger `tvine.db` with its SQL (never its params). `0` turns it off. |

Related settings: `settings.data.defaultPageSize` / `maxPageSize` (QuerySet `page()` and GenericView defaults), `settings.encryption` (keys for encrypted fields), `settings.auth.userModel`. See [settings.md](settings.md).

## Environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | The database URL when `settings.db.url` is not set. Required by the scaffolded `config/settings/prod.ts`. |

`tvine startproject --db sqlite|postgres|mysql` writes the matching `DATABASE_URL` into `.env` and adds `pg` / `mysql2` to `package.json`.

## Connections

There is one connection handler per process (`connections`, on `globalThis` so the Next.js page bundle shares it). The server configures it from settings at boot; you rarely touch it.

| Function | Signature | Meaning |
|---|---|---|
| `configureDb` | `configureDb(url?: string): void` | Point the default connection at `url` (or `DATABASE_URL`, or the default). Closes any open connection. Opens nothing yet. For scripts and tests. |
| `closeDb` | `closeDb(): void` | Close every open connection (pool `end()`, SQLite `close()`). |

Only the `default` alias is configurable from settings. Not covered: several database aliases / database routers.

Pool stats (`size`, `idle`, `waiting`) appear on `/tvine/health` for Postgres / MySQL. Per-statement duration goes to `/tvine/metrics` as `tvine_db_query_duration_seconds` (labels `db`, `op`) when metrics are enabled.

## Transactions on each engine

- SQLite: one writer. Every ORM operation waits its turn in a process-wide queue; inside `atomic()` the block owns the connection and its queries skip the queue. Keep blocks short; a block that awaits slow I/O holds every other query.
- Postgres / MySQL: plain queries run in parallel on the pool; `atomic()` takes one connection for its whole block.
- A query issued from an `atomic()` callback after the block ended throws `query after the atomic block was committed` (or `rolled back` / `aborted`).

API: [queryset.md](queryset.md#transactions).

## Test databases

The code has no test-database helper and no `TEST` settings block. What it supports:

- Point `DATABASE_URL` (or `settings.db.url`) at a throwaway database, run `tvine migrate` on it, then boot the server or run ORM code. The server never creates tables.
- `:memory:` SQLite is one database per connection: `tvine migrate` (another process) and `migrate(url, ...)` (opens and closes its own connection for a URL string) each migrate a different, throwaway in-memory database. Use a temp file (`file:/tmp/x/test.db`).
- `migrate(url, appsDir, { installed })` can run migrations in-process against the same URL.

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureDb, closeDb, migrate } from 'tvine'

const url = `file:${join(mkdtempSync(join(tmpdir(), 'shop-')), 'test.db')}`
await migrate(url, './apps', { installed: ['tvine.auth', 'shop'] })
configureDb(url)
// ... ORM calls ...
closeDb()
```

`warp/src/data/adapters/memory.ts` (`memorySource(items)`) is an in-process array data source for demos and internal tests. It is not exported from `tvine`; models always use the SQL engine.

## Examples

SQLite in development, Postgres in production:

```ts
// config/settings/dev.ts
import { defineSettings } from 'tvine'
import { base } from './base.ts'

export default defineSettings({
  ...base,
  debug: true,
  db: { url: 'file:./tvine.db', slowQueryMs: 200 },
})
```

```ts
// config/settings/prod.ts
import { defineSettings } from 'tvine'
import { base } from './base.ts'

export default defineSettings({
  ...base,
  debug: false,
  db: { pool: { max: 20, acquireMs: 2_000, idleMs: 30_000 } },   // url comes from DATABASE_URL
})
```

```bash
DATABASE_URL=postgres://shop:secret@db.internal:5432/shop tvine migrate
DATABASE_URL='mysql://shop:secret@db.internal:3306/shop?sslmode=require' tvine start
```

A script outside the server:

```ts
import { configureDb, closeDb } from 'tvine'
import { Product } from './apps/shop/models.ts'

configureDb(process.env.DATABASE_URL)
const n = await Product.objects.filter({ stock: 0 }).update({ active: false })
console.log(`${n} products hidden`)
closeDb()
```

Turning off the per-request transaction for one action (rules: [actions.md](actions.md)):

```ts
// apps/shop/views.ts
import { z } from 'zod'
import { defineAction } from 'tvine'
import { Product } from './models.ts'

// each write commits on its own; a failure halfway keeps the rows already written
export const restockAll = defineAction('restockAll', z.object({ amount: z.number().int().min(1) }), async ({ amount }) => {
  const ids = await Product.objects.filter({ active: true }).valuesList('id', { flat: true }).fetchAll() as number[]
  for (const id of ids) await Product.objects.filter({ id }).update({ stock: amount })
  return { updated: ids.length }
}, { atomic: false })
```

## Gotchas

- Postgres and MySQL drivers are optional: install `pg` or `mysql2`, or the first query fails with `install pg to use postgres:// urls`.
- `DATABASE_URL=""` (set but empty) throws on purpose.
- On SQLite, one long `atomic()` block blocks every other query in the process.
- MySQL stores and compares text with `utf8mb4_bin` (exact, case-sensitive equality, like SQLite / Postgres); the case-insensitive lookups lower both sides.
- `configureDb()` closes open connections; do not call it while requests are running.
- The ORM never creates tables; run `tvine migrate`.

## See also

- [migrations.md](migrations.md) — schema changes per engine
- [queryset.md](queryset.md) — `atomic`, `onCommit`, `selectForUpdate`
- [fields.md](fields.md) — column types per engine
- [settings.md](settings.md) — the whole settings object
- [overview.md](overview.md)
