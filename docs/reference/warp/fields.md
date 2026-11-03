# Fields

A field describes one model attribute: its JavaScript value type, how it is validated (zod), which column(s) it gets on each database, how values travel to and from the driver, and which filters it supports. You build fields with `field.<kind>(opts)` inside `defineModel`. Every field object in `warp/src/data/fields/*` owns its own DDL and conversion; the table only collects them. Source: `warp/src/data/fields.ts`, `warp/src/data/fields/*.ts`; admin widgets from `warp/src/contrib/admin/meta.ts`.

## Import

```ts
import { defineModel, field, inc, dec } from 'tvine'
```

In migration files use the `field` exported by `tvine/migrations` (same kinds; `fk` / `m2m` take a model name string). See [migrations.md](migrations.md).

## All kinds at a glance

| Builder | Kind | JS value | Columns |
|---|---|---|---|
| `field.id()` | `id` | `number` | 1, auto-increment pk |
| `field.uuid(o)` | `uuid` | `string` | 1 |
| `field.text(o)` | `text` | `string` | 1 |
| `field.int(o)` | `int` | `number` (integer) | 1 |
| `field.float(o)` | `float` | `number` | 1 |
| `field.bool(o)` | `bool` | `boolean` | 1 |
| `field.money(o)` | `money` | `{ value: number; currency: string }` | 2: `<name>`, `<name>Currency` |
| `field.enum(values, o)` | `enum` | one of `values` | 1 |
| `field.datetime(o)` | `datetime` | `Date` | 1 |
| `field.date(o)` | `date` | `'YYYY-MM-DD'` | 1 |
| `field.time(o)` | `time` | `'HH:MM:SS'` or `'HH:MM:SS.ffffff'` | 1 |
| `field.duration(o)` | `duration` | `number` (milliseconds) | 1 |
| `field.decimal(o)` | `decimal` | `string` (`'12.50'`) | 1 |
| `field.email(o)` | `email` | `string` | 1 |
| `field.url(o)` | `url` | `string` | 1 |
| `field.slug(o)` | `slug` | `string` | 1 |
| `field.file(o)` | `file` | `string` (storage key) | 1 |
| `field.image(o)` | `image` | `string` (storage key) | 1 |
| `field.signature(o)` | `image` | `string` (storage key) | 1 |
| `field.json(o)` | `json` | `unknown` | 1 |
| `field.color(o)` | `color` | `string` (`'#1a2b3c'`) | 1 |
| `field.phone(o)` | `phone` | `string` (E.164) | 1 |
| `field.ip(o)` | `ip` | `string` | 1 |
| `field.country(o)` | `country` | `string` (ISO alpha-2) | 1 |
| `field.markdown(o)` | `markdown` | `string` | 1 |
| `field.code(o)` | `code` | `string` | 1 |
| `field.richText(o)` | `richText` | `string` (sanitized HTML) | 1 |
| `field.percent(o)` | `percent` | `number` (0 to 100) | 1 |
| `field.tags(o)` | `tags` | `string[]` | 1 (JSON) |
| `field.address(o)` | `address` | `Address` | 1 (JSON) |
| `field.dateRange(o)` | `dateRange` | `{ start: string; end: string }` | 1 (JSON) |
| `field.encrypted(o)` / `encryptedText(o)` / `encryptedJson(o)` | `encrypted` | `string` or `unknown` | 1, or 2 with `deterministic` |
| `field.fk(() => M, o)` | `fk` | `number \| string` (key `<name>Id`) | 1: `<name>Id` |
| `field.m2m(() => M, o)` | `m2m` | none on the row | 0 (through table) |

## Common options

Every builder takes an optional `Opts` object. Options a kind does not use are ignored unless noted.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `optional` | `boolean` | `false` | Column is nullable; the value type becomes `V \| null`; may be left out on create (stored as NULL). Django `null=True, blank=True`. |
| `default` | constant | none | Value used when create leaves the field out. Also written as the column `DEFAULT` (must be a literal: string, number, boolean, null, or what the field converts to one). |
| `unique` | `boolean` | `false` | `UNIQUE` on the (first) column. Violations → `DomainError('domain', '<model>.<field> must be unique')`. |
| `index` | `boolean` | `false` | Creates index `<model>_<field>_idx` (in migrations). Django `db_index`. |
| `searchable` | `boolean` | `false` | Field joins the model's default `.search(term)` fields. Not allowed on money. |
| `hidden` | `boolean` | `false` (`true` for encrypted) | Left out of generic views' default serializer output. No DDL. |
| `readOnly` | `boolean` | `false` | Generic views never accept it as create / update input. No DDL. |
| `writeOnly` | `boolean` | `false` | Generic views accept it as input but never output it. No DDL. |
| `humanOnly` | `boolean \| string` | `false` | An agent-marked request that changes this field (admin save, generic views) is refused with `human_only`. A string is the reason shown. No DDL. |
| `auto` | `boolean` | `false` | datetime: set to now on create (same as `autoNowAdd`; legacy name). |
| `autoNowAdd` | `boolean` | `false` | date / datetime: set to now on create. Django `auto_now_add`. |
| `autoNow` | `boolean` | `false` | date / datetime: set to now on create and on every `Model.update()`. Django `auto_now`. |
| `maxLength` | `number` | per kind | email / url / slug / markdown / code / richText / tags (per tag). See each kind. Not enforced on `text`. |
| `maxDigits` | `number` | `12` | decimal: total digits. |
| `decimalPlaces` | `number` | `2` | decimal: digits after the point. |
| `uploadTo` | `string` | none | file / image: storage key prefix, e.g. `'avatars'`. |
| `onDelete` | `OnDelete` | `'RESTRICT'` | fk only. See [models.md](models.md#ondelete-fk-only). |
| `relatedName` | `string` | `<model>_set` | fk / m2m: reverse accessor name on the target. No DDL. |
| `language` | `string` | none | code: `'json' \| 'js' \| 'sql' \| 'html' \| 'css'`; `'json'` validates. |
| `maxItems` | `number` | `100` | tags: maximum number of tags. |
| `choices` | `string[]` | none | tags: only these values are allowed. |
| `allowRemoteImages` | `boolean` | `false` | richText: keep `http(s)` `<img>` sources. No DDL. |

Options marked "No DDL" never enter migrations; changing them needs no `makemigrations`.

## Field reference

Each table lists the JavaScript value, what input is accepted, the column type per database, and the admin widget (`contrib/admin/meta.ts kindOf`).

### field.id()

| | |
|---|---|
| Value | `number` (integer), generated by the database |
| SQLite | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| Postgres | `BIGSERIAL PRIMARY KEY` |
| MySQL | `BIGINT AUTO_INCREMENT PRIMARY KEY` |
| Admin | `int`, read-only |
| Options | none (takes no arguments) |

Must be named `id`. Every model needs `id: field.id()` or `id: field.uuid()`.

### field.uuid(opts)

| | |
|---|---|
| Value | `string` |
| Accepts | any string (`z.string()`); filled with `crypto.randomUUID()` on create when left out |
| SQLite | `TEXT` |
| Postgres | `UUID` |
| MySQL | `CHAR(36)` |
| Admin | `uuid` |
| As pk | `id: field.uuid()` → `PRIMARY KEY NOT NULL` |

### field.text(opts)

| | |
|---|---|
| Value | `string` |
| Accepts | any string; `maxLength` is NOT checked |
| SQLite | `TEXT` |
| Postgres | `TEXT` |
| MySQL | `LONGTEXT`; `VARCHAR(255)` when `unique` or `index` |
| Admin | `password` if named `password` (or `hidden` and name contains "password"); `email` if the name contains "email"; `url` if the name ends in `url` / `Url` / `URL`; `slug` if named `slug`; `textarea` if `maxLength > 255`; else `text` |

### field.int(opts)

| | |
|---|---|
| Value | `number` (integer) |
| SQLite / Postgres / MySQL | `INTEGER` / `BIGINT` / `BIGINT` |
| Admin | `int` |

Supports `inc(n)` / `dec(n)` in `QuerySet.update()`.

### field.float(opts)

| | |
|---|---|
| Value | `number` |
| SQLite / Postgres / MySQL | `REAL` / `DOUBLE PRECISION` / `DOUBLE` |
| Admin | `decimal` |

Supports `inc(n)` / `dec(n)`.

### field.bool(opts)

| | |
|---|---|
| Value | `boolean` |
| SQLite / Postgres / MySQL | `INTEGER` (1/0) / `BOOLEAN` / `TINYINT(1)` |
| Admin | `bool` (never "required") |

### field.money(opts)

| | |
|---|---|
| Value | `{ value: number; currency: string }`, `value` in major units (`29.99`) |
| Accepts | `value` with at most 2 decimals and absolute value below 1e12; `currency` any non-empty string |
| Columns | `<name>` = integer cents, `<name>Currency` |
| SQLite | `INTEGER`, `TEXT` |
| Postgres | `BIGINT`, `TEXT` |
| MySQL | `BIGINT`, `VARCHAR(3)` |
| Admin | `money` (2 decimals; currency from `default.currency`) |
| Not allowed | `searchable`; lookups `contains`, `startswith`, `endswith`, `iexact` |

Filters: `{ price: { value: 10, currency: 'USD' } }` compares amount and currency; a bare number (`price__gte: 10`) compares the amount in any currency. `price__currency: 'EUR'` filters the currency column. Ordering uses the amount. Every currency is treated as 2 minor digits.

### field.enum(values, opts)

| | |
|---|---|
| Value | one of `values` (typed as the union) |
| SQLite / Postgres / MySQL | `TEXT` / `TEXT` / `VARCHAR(255)` |
| Admin | `choice`; labels from the value (`'in_stock'` → `'In stock'`) |

### field.datetime(opts)

| | |
|---|---|
| Value | `Date` |
| Accepts | `Date` |
| SQLite | `INTEGER` (epoch milliseconds) |
| Postgres | `TIMESTAMPTZ` |
| MySQL | `DATETIME(3)` holding UTC; years 1000 to 9999 only |
| Admin | `datetime` |
| Options | `auto`, `autoNowAdd`, `autoNow` |

Lookups: `createdAt__year`, `__month`, `__day`, `__date` (UTC). See [queryset.md](queryset.md#lookups).

### field.date(opts)

| | |
|---|---|
| Value | `string` `'YYYY-MM-DD'` |
| Accepts | that string (a real calendar day) or a `Date` (its UTC day) |
| SQLite / Postgres / MySQL | `TEXT` / `DATE` / `DATE` |
| Admin | `date` |
| Options | `autoNowAdd`, `autoNow` (today, UTC) |

### field.time(opts)

| | |
|---|---|
| Value | `'HH:MM:SS'`, or `'HH:MM:SS.ffffff'` when microseconds are not zero |
| Accepts | `'HH:MM'`, `'HH:MM:SS'`, `'HH:MM:SS.f'` up to 6 digits |
| SQLite / Postgres / MySQL | `TEXT` / `TIME` / `TIME(6)` |
| Admin | `time` |

### field.duration(opts)

| | |
|---|---|
| Value | `number` of milliseconds (fractions keep microseconds) |
| Stored | integer microseconds |
| SQLite / Postgres / MySQL | `INTEGER` / `BIGINT` / `BIGINT` |
| Admin | `duration` (the form shows seconds) |

### field.decimal(opts)

| | |
|---|---|
| Value | `string` with exactly `decimalPlaces` decimals (`'12.50'`) |
| Accepts | a decimal string or a number; refused when over `maxDigits` / `decimalPlaces` |
| SQLite | `NUMERIC` (exact up to about 15 digits) |
| Postgres | `NUMERIC(maxDigits, decimalPlaces)` |
| MySQL | `DECIMAL(maxDigits, decimalPlaces)` |
| Admin | `decimal` |
| Options | `maxDigits` (12), `decimalPlaces` (2) |

### field.email(opts) / field.url(opts) / field.slug(opts)

| | email | url | slug |
|---|---|---|---|
| Value | `string` | `string` | `string` |
| Accepts | valid email | URL with scheme `http`, `https`, `ftp` or `ftps` | letters, digits, `_`, `-` |
| `maxLength` default | 254 | 200 | 50 |
| SQLite | `TEXT` | `TEXT` | `TEXT` |
| Postgres / MySQL | `VARCHAR(maxLength)` | `VARCHAR(maxLength)` | `VARCHAR(maxLength)` |
| Admin | `email` | `url` | `slug` |

### field.file(opts) / field.image(opts) / field.signature(opts)

| | file | image | signature |
|---|---|---|---|
| Value | storage key `string` (max 512) | same | same |
| Kind | `file` | `image` | `image` |
| SQLite / Postgres / MySQL | `TEXT` / `TEXT` / `VARCHAR(512)` | same | same |
| Admin | `file` (accept `application/pdf,image/*`) | `image` (accept `image/*`) | `signature` (drawn by hand) |
| Options | `uploadTo` | `uploadTo` | defaults `humanOnly: 'a signature must be drawn by a person'` |

The column holds the key that `defineUpload({ uploadTo })` returned; the file lives in `settings.media` storage. See [contrib/media.md](contrib/media.md). Any `image` field with `humanOnly` shows as the signature widget.

### field.json(opts)

| | |
|---|---|
| Value | any JSON value (`unknown`) |
| SQLite / Postgres / MySQL | `TEXT` / `JSONB` / `JSON` |
| Admin | `json` |

### Input-shaped fields

Each is plain text, a number or JSON in the database, with its own validation, and maps to its own admin widget.

| Builder | Value / validation | SQLite | Postgres | MySQL | Admin |
|---|---|---|---|---|---|
| `color` | `#rrggbb`, stored lowercase | `TEXT` | `VARCHAR(7)` | `VARCHAR(7)` | `color` |
| `phone` | E.164, e.g. `+15551234567` | `TEXT` | `VARCHAR(16)` | `VARCHAR(16)` | `phone` |
| `ip` | IPv4 or IPv6, stored lowercase | `TEXT` | `VARCHAR(45)` | `VARCHAR(45)` | `ip` |
| `country` | ISO 3166-1 alpha-2, e.g. `'IS'` | `TEXT` | `VARCHAR(2)` | `VARCHAR(2)` | `country` |
| `markdown` | string, at most `maxLength` (default 100 000) | `TEXT` | `TEXT` | `LONGTEXT` | `markdown` |
| `code` | string, at most `maxLength` (default 100 000); `language: 'json'` must parse (empty allowed) | `TEXT` | `TEXT` | `LONGTEXT` | `code` |
| `richText` | HTML, sanitized to an allowlist on every save; `maxLength` counts visible text | `TEXT` | `TEXT` | `LONGTEXT` | `rich` |
| `percent` | number 0 to 100 | `REAL` | `DOUBLE PRECISION` | `DOUBLE` | `percent` |
| `tags` | `string[]`: each trimmed, 1 to `maxLength` (50) chars, deduped, at most `maxItems` (100), only `choices` if given | `TEXT` | `JSONB` | `JSON` | `tags` |
| `address` | `{ line1, line2?, city, region?, postal?, country }`; parts up to 200 chars, `postal` up to 20, `country` ISO; no extra keys | `TEXT` | `JSONB` | `JSON` | `address` |
| `dateRange` | `{ start, end }` as `'YYYY-MM-DD'`, `start <= end`, inclusive | `TEXT` | `JSONB` | `JSON` | `daterange` |

### field.encrypted(opts)

Encrypted at rest with AES-256-GCM (keys from `settings.encryption`).

| | |
|---|---|
| Value | `string` (`of: 'text'`, default) or any JSON (`of: 'json'`) |
| SQLite / Postgres / MySQL | `TEXT` / `TEXT` / `LONGTEXT` |
| Extra column | with `deterministic: true`: `<name>Hash` (`TEXT` / `TEXT` / `VARCHAR(64)`), an HMAC of the value |
| Admin | `text` or `json`, only shown with `hidden: false` |
| Default | `hidden: true` |
| Not allowed | `unique`, `index`, `searchable`, `default` (throws) |
| Filters | only `eq`, `ne`, `in` (and `isnull`), and only with `deterministic: true` |

| Option | Type | Default | Meaning |
|---|---|---|---|
| `of` | `'text' \| 'json'` | `'text'` | Value type. |
| `deterministic` | `boolean` | `false` | Adds the hash column so exact-match filters work. |
| `context` | `string` | none | Extra key-derivation context. |
| `bindAs` | `string` | `'<model>.<field>'` | The name each ciphertext is bound to; set it to the old name after a rename so old values still decrypt. |
| `bindRow` | `boolean` | `false` | Also bind to the row's pk (a ciphertext copied to another row fails). Needs a `uuid` pk; writes must name one row (`create`, `Model.update`, `bulkUpdate`, `filter({ id }).update`). |

`field.encryptedText(o)` = `encrypted({ ...o, of: 'text' })`; `field.encryptedJson(o)` = `encrypted({ ...o, of: 'json' })`. Key rotation: `tvine encryption rotate`. More: [contrib/security.md](contrib/security.md).

### field.fk(() => Target, opts)

| | |
|---|---|
| Row key | `<name>Id` (`customer` → `customerId`) |
| Value | the target's pk: `number` (target pk `id`) or `string` (target pk `uuid`) |
| SQLite / Postgres / MySQL | int pk target: `INTEGER` / `BIGINT` / `BIGINT`; uuid pk target: `TEXT` / `UUID` / `CHAR(36)` |
| Constraint | `REFERENCES <target>(id) ON DELETE <action>` (MySQL: a named table constraint) |
| Admin | `fk` (select; `autocomplete` / `rawId` set in the ModelAdmin) |
| Options | `onDelete`, `relatedName`, plus common ones (`optional`, `unique` for one-to-one, `index`, `default`) |

### field.m2m(() => Target, opts)

| | |
|---|---|
| Row key | none (no column) |
| Storage | auto through table `<model>_<field>`, or `through` model |
| Admin | `m2m` (multiple select) |

| Option | Type | Default | Meaning |
|---|---|---|---|
| `through` | `() => ModelDef` | auto table | Custom through model with one fk to each side. |
| `relatedName` | `string` | `<model>_set` | Reverse accessor on the target. |

Only these two options are typed for m2m.

## Examples

A product catalog with most kinds:

```ts
import { defineModel, field } from 'tvine'

export const Supplier = defineModel('supplier', {
  id: field.uuid(),
  name: field.text({ unique: true }),
  website: field.url({ optional: true }),
  phone: field.phone({ optional: true }),
  country: field.country(),
  address: field.address({ optional: true }),
  apiKey: field.encryptedText({ optional: true }),
})

export const Item = defineModel('item', {
  id: field.id(),
  supplier: field.fk(() => Supplier, { onDelete: 'CASCADE', relatedName: 'items' }),
  slug: field.slug({ unique: true }),
  title: field.text({ searchable: true }),
  description: field.richText({ optional: true }),
  price: field.money(),
  weightKg: field.decimal({ maxDigits: 6, decimalPlaces: 3, optional: true }),
  discount: field.percent({ default: 0 }),
  colour: field.color({ optional: true }),
  labels: field.tags({ maxItems: 10, optional: true }),
  status: field.enum(['draft', 'live', 'retired'], { default: 'draft', index: true }),
  photo: field.image({ uploadTo: 'items', optional: true }),
  specs: field.json({ optional: true }),
  availableOn: field.date({ optional: true }),
  createdAt: field.datetime({ autoNowAdd: true }),
  updatedAt: field.datetime({ autoNow: true }),
})
```

Writing values of each shape:

```ts
const s = await Supplier.create({ name: 'Nordic Lamps', country: 'IS', apiKey: 'sk_live_123' })
await Item.create({
  supplierId: s.id,
  slug: 'desk-lamp',
  title: 'Desk lamp',
  price: { value: 29.99, currency: 'USD' },
  weightKg: '1.250',
  labels: ['desk', 'led', 'desk'],      // stored as ['desk', 'led']
  availableOn: '2026-12-01',
  specs: { watts: 9, dimmable: true },
})
```

Exact-match filter on an encrypted field:

```ts
export const Account = defineModel('account', {
  id: field.id(),
  taxId: field.encryptedText({ deterministic: true }),
})
const hit = await Account.objects.filter({ taxId: 'IS-1234' }).first()
```

## Gotchas

- `field.text({ maxLength })` does not validate length (only the admin uses it to pick a textarea). Use `email` / `url` / `slug` / `markdown`, or validate in the action's zod schema.
- On MySQL a plain `text` is `LONGTEXT`; adding `unique` or `index` makes it `VARCHAR(255)`, and longer values are refused.
- Any `uuid` field left out of `create()` gets a random UUID, not only the pk, even when `optional`.
- `decimal` values come back as strings, `money` as `{ value, currency }`, `date` / `time` as strings, `datetime` as `Date`.
- `contains`, `startswith`, `endswith` are case-insensitive on every engine (they all lower both sides).
- Changing a field so its column set changes (int to fk, money to a scalar) cannot be auto-migrated; see [migrations.md](migrations.md).
- `default` is a constant, not a function.

Not covered by the code: per-field `validators`, `choices` on text (use `field.enum`), `verboseName` / `helpText` (the admin derives labels from names), `blank` separate from `null` (`optional` is both), `editable`, `db_column`, generated columns.

## See also

- [models.md](models.md) — `defineModel`, Meta, relations
- [queryset.md](queryset.md) — lookups each field supports
- [migrations.md](migrations.md) — what a field change does to the table
- [database.md](database.md) — engines and their types
- [contrib/admin.md](contrib/admin.md) — widgets, `formfieldOverrides`, `widgets`
- [contrib/media.md](contrib/media.md) — uploads for `file` / `image`
- [contrib/security.md](contrib/security.md) — encryption keys and rotation
