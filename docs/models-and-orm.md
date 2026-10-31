# Models and the ORM

Tvine has its own ORM, modelled on Django's: models in `apps/<app>/models.ts`, `Model.objects` querysets,
migration files you commit. It runs on SQLite (default), Postgres and MySQL/MariaDB with the same code.

## Setup

Nothing for development: the database is `./tvine.db`. For another engine, set the URL:

| URL | Engine | Driver to install in your app |
|---|---|---|
| `file:./tvine.db`, `:memory:` | SQLite | none (built into Node) |
| `postgres://user:pass@host/db` | Postgres | `pg` |
| `mysql://user:pass@host/db`, `mariadb://…` | MySQL / MariaDB | `mysql2` |

Set it as `DATABASE_URL` or `settings.db.url`. Pool and engine details:
[design/conventions/db-engines.md](design/conventions/db-engines.md).

## A model

```ts
// apps/notes/models.ts
import { defineModel, field, type Infer } from 'tvine'

export const Note = defineModel('note', {
  id: field.id(),
  title: field.text({ searchable: true }),
  body: field.text({ default: '' }),
  pinned: field.bool({ default: false }),
  words: field.int({ default: 0 }),
})
export type Note = Infer<typeof Note>
```

```bash
pnpm exec tvine makemigrations     # → apps/notes/migrations/0001_initial.ts
pnpm exec tvine migrate            # → applied notes.0001_initial
```

## Field types

| `field.` | Django | JS value |
|---|---|---|
| `id()` | AutoField | number |
| `uuid()` | UUIDField | string |
| `text()` | TextField / CharField | string |
| `int()`, `float()` | IntegerField, FloatField | number |
| `bool()` | BooleanField | boolean |
| `decimal({ maxDigits, decimalPlaces })` | DecimalField | string `'12.50'` |
| `money()` | — | `{ value, currency }`, major units, stored as integer cents |
| `percent()` | — | number 0–100 |
| `datetime({ auto })` | DateTimeField | `Date` |
| `date({ autoNow, autoNowAdd })`, `time()` | DateField, TimeField | `'YYYY-MM-DD'`, `'HH:MM:SS'` |
| `duration()` | DurationField | milliseconds |
| `dateRange()` | — | `{ start, end }` |
| `email()`, `url()`, `slug()` | EmailField, URLField, SlugField | validated string |
| `phone()`, `color()`, `country()`, `ip()` | — / GenericIPAddressField | E.164, `#rrggbb`, ISO code, IPv4/IPv6 |
| `json()` | JSONField | any JSON |
| `tags({ maxItems, choices })` | — | `string[]` |
| `address()` | — | `{ line1, line2?, city, region?, postal?, country }` |
| `markdown()`, `code({ language })` | — | string |
| `richText({ allowRemoteImages })` | — | HTML, sanitized on every save |
| `file({ uploadTo })`, `image({ uploadTo })` | FileField, ImageField | storage key |
| `signature()` | — | a drawn signature, stored as an image |
| `encryptedText()`, `encryptedJson()`, `encrypted({ of, deterministic, context })` | — | encrypted at rest (AES-256-GCM) |
| `enum(['a', 'b'] as const)` | `choices` | one of the values |
| `fk(() => Model, { onDelete, relatedName })` | ForeignKey | the row gets `<name>Id` |
| `m2m(() => Model, { through, relatedName })` | ManyToManyField | no column; `Model.related('field', id)` |

### Options every field takes

| Option | Meaning |
|---|---|
| `optional` | nullable (Django `null=True, blank=True`) |
| `default` | default value |
| `unique`, `index` | unique / indexed column |
| `searchable` | used by `?q=` search in generic views and the admin |
| `hidden` | left out of generic views' output |
| `readOnly` / `writeOnly` | never accepted as input / never output |
| `humanOnly` | writes marked as coming from an agent are refused (`human_only`) |

`fk` `onDelete`: `CASCADE`, `PROTECT`, `SET_NULL` (needs `optional`), `SET_DEFAULT` (needs `default`),
`RESTRICT` (default), `DO_NOTHING`.

### Encrypted fields

```ts
defineModel('patient', {
  id: field.id(),
  ssn: field.encryptedText({ deterministic: true }),   // filter({ ssn }) works, exact match only
  notes: field.encryptedJson({ optional: true }),      // not filterable
}, { personalData: ['ssn', 'notes'], onErase: 'anonymize' })
```

Keys come from `settings.encryption.keys` / `TVINE_ENCRYPTION_KEYS` (default: derived from the secret).
After adding a key, rewrite old rows: `pnpm exec tvine encryption rotate`. Rules:
[design/conventions/security-features.md](design/conventions/security-features.md).

### Meta

The third argument to `defineModel`:

```ts
defineModel('product', { /* fields */ }, {
  indexes: [['category', 'price'], { fields: ['name'], name: 'product_name_lookup' }],
  unique: [['vendor', 'sku']],                    // unique_together
  constraints: [CheckConstraint({ name: 'price_gte_0', check: Q({ price__gte: 0 }) })],
  ordering: ['-createdAt'],
  personalData: ['email'],                        // collected by "export my data"
  onErase: 'anonymize',                           // 'delete' | 'anonymize' | (userId) => …
})
```

## Querying

```ts
await Product.objects.filter({ category: 'shirts' }).order('-price').page({ size: 24 })   // cursor pages
await Product.objects.search('summer').first()
await Product.objects.filter({ price__lte: 30, stock__gt: 0 }).count()
await Product.objects.exclude({ category: 'hats' }).all()
await Product.objects.slice(0, 10).all()                    // Django qs[0:10]

const p = await Product.create({ name: 'Shirt', price: { value: 29, currency: 'USD' } })
await Product.update(p.id, { stock: 11 })
await Product.get(42)
await Product.delete(42)
```

Lookups: `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `iexact`, `isnull`, `range`, `year`/`month`/`day`/`date`,
and relation paths (`vendor__name`, `product_set__price__gt`).

Expressions and aggregates, as in Django:

```ts
import { F, Q, Sum, Count, Avg } from 'tvine'

await Product.objects.filter({ id }).update({ stock: F('stock').sub(qty) })          // stock = stock - ?
await Product.objects.filter(Q({ category: 'shirts' }).or(Q({ price__lt: 10 })))
await Product.objects.aggregate({ total: Sum('price'), n: Count('id'), avg: Avg('stock') })
await Product.objects.values('category').annotate({ n: Count('id') }).order('-n').all()
```

Also `getOrCreate`, `updateOrCreate`, `bulkCreate`, `bulkUpdate`, `inBulk`, `selectRelated`, `prefetchRelated`,
`selectForUpdate`, `distinct`, `values`, `valuesList`, `exists`, `last`, and `Paginator(qs, perPage)` for page numbers.
Full list: [design/conventions/orm-advanced.md](design/conventions/orm-advanced.md),
[design/conventions/orm-queryset.md](design/conventions/orm-queryset.md).

## Await or not

- **Building a queryset never needs `await`.** `filter`, `exclude`, `order`, `search`, `slice`, `values` run no SQL.
- **Reads need `await`** to get a value: `const n = await qs.count()`.
- **Writes work with or without `await`.** Inside a request, a job or `atomic()`, un-awaited writes run in call
  order and the block waits for them before it commits. If one fails, the whole request rolls back.
- Outside a request (a plain script), un-awaited writes still run but nothing waits; wrap the code in `atomic()`.
- `tvine check` warns on `const x = Model.objects.<read>(…)` without `await`.

## Transactions

Each action is one transaction (Django `ATOMIC_REQUESTS`, `settings.db.atomicRequests`). Opt out per action
with `rules: { atomic: false }`. In your own code, use `atomic(async () => { … })`.

## Migrations

```bash
pnpm exec tvine makemigrations              # write new migration files for model changes
pnpm exec tvine makemigrations --check      # exit 1 if a migration is missing (for CI) → "no changes detected"
pnpm exec tvine makemigrations --dry-run    # show what would be written
pnpm exec tvine migrate                     # apply everything pending
pnpm exec tvine migrate --plan              # → "no migrations to apply"
pnpm exec tvine showmigrations              # [X] applied, [ ] pending
pnpm exec tvine sqlmigrate notes 0001_initial
# CREATE TABLE "note" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL, ...);
pnpm exec tvine migrate notes zero          # roll the app back to nothing → "unapplied notes.0001_initial"
pnpm exec tvine migrate notes               # forward to the latest again
```

Other flags: `makemigrations --name x --empty --merge --allow-drop`, `migrate --fake`, `sqlmigrate --backwards`.
Migrations are TypeScript files with `ops.*` calls (`createModel`, `addField`, `runSQL(sql, { reverse })`, …).
Rollback rules and every op: [design/conventions/orm-advanced.md](design/conventions/orm-advanced.md#5-migrations).

## Fixtures

```bash
pnpm exec tvine dumpdata notes --output notes.json     # Django format: [{ model, pk, fields }]
pnpm exec tvine loaddata notes.json                    # one transaction, upsert by pk
```

`dumpdata` with no argument dumps every app; `app.model` picks one model.

## Gotchas

- **Money is major units** (`29.99`, not cents) with at most 2 decimals. `0.1 + 0.2` is rejected; round computed
  amounts with `Math.round(x * 100) / 100`. Filters on money need a currency or a bare amount.
- `exclude({ a, b })` with more than one key throws; chain two `exclude()` calls or use `exclude(Q(...))`.
- `distinct('field')` works on Postgres only.
- A partial unique index (`UniqueConstraint({ condition })`) is refused on MySQL.
- An index added by a hand-written migration must also be in Meta, or `makemigrations` proposes removing it.
- Pages never import models; `tvine check` fails if they do. Pages use `api.*` ([views-urls-api.md](views-urls-api.md)).

Depth: [design/conventions/models-db.md](design/conventions/models-db.md).
