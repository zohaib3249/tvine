# Models

A model is one database table described in TypeScript. `defineModel(name, fields, meta?)` returns a `Model` object that carries the field definitions, a zod schema for rows, the `objects` query manager, and a few row-level helpers (`create`, `get`, `update`, `delete`, `related`). Rows are plain JavaScript objects, not class instances. Source: `warp/src/data/model.ts`, `fields.ts`, `fields/base.ts`, `registry.ts`, `related.ts`, `swappable.ts`.

## Import

```ts
import { defineModel, field, modelRegistry, CheckConstraint, UniqueConstraint, type Model, type Infer } from 'tvine'
```

## defineModel

```ts
function defineModel<const F extends Fields>(name: string, fields: F, meta?: ModelMeta): Model<F>
```

| Argument | Type | Meaning |
|---|---|---|
| `name` | `string` | Model name. It is also the table name, the key in the registry, and the prefix of generated names (indexes, auto m2m tables, default reverse names). Must be a valid SQL identifier (`[A-Za-z_][A-Za-z0-9_]*`). |
| `fields` | `Record<string, Field>` | Field name → `field.x(...)`. Must contain `id: field.id()` or `id: field.uuid()` (the primary key is always the field named `id`). See [fields.md](fields.md). |
| `meta` | `ModelMeta` | Optional. Table options (below). |

`defineModel` checks the definition at once and throws a plain `Error` on: missing `id`, unknown or m2m fields named in Meta, `onDelete` on a non-fk field, `SET_NULL` without `optional: true`, `SET_DEFAULT` without `default`, an unknown `onDelete` value, an invalid `relatedName`, an index name longer than 63 characters, a non-string `ordering` entry, a `searchable` money field, and reverse-name clashes between relations (see [Relations](#relations)).

## Meta options (ModelMeta)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ordering` | `string[]` | none | Default order when a query has no `.order()`. `'field'` ascending, `'-field'` descending. The primary key is always added last as a tie-breaker. |
| `indexes` | `(string[] \| { fields: string[]; name?: string; unique?: boolean })[]` | `[]` | Extra indexes. A bare array is the field list. The name defaults to `<model>_<fields joined by _>_idx` (`_uniq` when `unique: true`), shortened with a hash when over 63 characters. |
| `unique` | `string[][]` | `[]` | Unique-together sets. Each entry is a list of field names. |
| `constraints` | `ConstraintSpec[]` | `[]` | `CheckConstraint(...)` / `UniqueConstraint(...)` results. |
| `personalData` | `string[]` | none | Fields that `privacy.export(user)` collects from rows that reference a user (tvine.auth). |
| `onErase` | `'delete' \| 'anonymize' \| (userId: number) => Promise<void> \| void` | `'anonymize'` | What `privacy.erase(user)` does with these rows. `'anonymize'` blanks the `personalData` fields; each must then be `optional`, or of kind `text`, `email`, `slug`, `url`, `encrypted`. |

Meta indexes, unique sets and constraints are created by migrations, not by `defineModel`. Field-level `index: true` / `unique: true` live on the field (see [fields.md](fields.md#common-options)).

### CheckConstraint / UniqueConstraint

```ts
CheckConstraint(o: { name: string; check: QNode | Record<string, unknown> }): CheckSpec
UniqueConstraint(o: { name: string; fields: string[]; condition?: QNode | Record<string, unknown> }): UniqueSpec
```

| Option | Meaning |
|---|---|
| `name` | Identifier, at most 63 characters. Required. |
| `check` | Lookups that must hold for every row, as an object or `Q(...)`. Values must be plain JSON or `F('field')`. No relation paths, no subqueries, no `Exists`. |
| `fields` | Unique columns (UniqueConstraint). |
| `condition` | Makes the unique constraint partial (only rows matching it). |

## The Model object

```ts
interface Model<F, T = Row<F>> {
  readonly name: string
  readonly fields: F
  readonly meta: ModelMeta
  readonly schema: z.ZodType<T>          // what a read returns
  readonly objects: QuerySet<T>          // see queryset.md
  create(data: Create<F>): Promise<T>
  get(id: string | number): Promise<T | undefined>
  update(id: string | number, patch: Partial<Record<keyof T & string, unknown>>): Promise<T>
  delete(id: string | number): Promise<void>
  related(name: string, id: string | number): RelatedManager
}
```

| Member | Behaviour |
|---|---|
| `create(data)` | Validates `data` with a strict zod schema (unknown keys are refused), fills defaults (`uuid` pk = random UUID, `auto` / `autoNowAdd` / `autoNow` date/datetime = now, `default`), inserts, returns the stored row. Bad input → `DomainError('invalid_param')` naming the field. |
| `get(id)` | The row with that primary key, or `undefined`. |
| `update(id, patch)` | Writes `patch` (validated per field), sets every `autoNow` field not in the patch to now, re-reads and returns the row. Throws `DomainError('domain', '<model> <id> not found')` if no row matched. An empty patch still counts as a save. |
| `delete(id)` | Deletes that row (no error if it does not exist). `onDelete` rules apply. |
| `related(name, id)` | Manager for a many-to-many field or a reverse relation of row `id` (below). |
| `schema` | zod object of the row shape (keys use the stored name: `customerId` for fk `customer`). |

### Row and create types

```ts
type Row<F>    // what reads return
type Create<F> // what create() takes
type Infer<M>  // Row of a model: Infer<typeof Product>
```

- Row keys: the field name, except an fk field `customer` is stored and returned as `customerId`; m2m fields have no key.
- An `optional: true` field has type `V | null`.
- In `Create<F>`, a field is optional when it is `optional`, has `default`, `auto`, `autoNow`, `autoNowAdd`, or is `id` / `uuid`.

```ts
export const Product = defineModel('product', { id: field.id(), name: field.text() })
export type Product = Infer<typeof Product>   // { id: number; name: string }
```

### Errors from the database

Constraint failures come back in model vocabulary (`engine.ts wrapErr`), on every engine:

| Database error | DomainError |
|---|---|
| unique / primary key | `'domain'`, `"<model>.<field> must be unique"`, `field` set |
| not null / no default | `'invalid_param'`, `"<model>.<field> is required"` |
| foreign key | `'domain'`, `"<model> is still referenced by other records, or points at a record that does not exist"` |
| value too long / out of range (mysql) | `'invalid_param'`, `"<model>.<field> is too long or invalid"` |

## Relations

| Kind | Declared as | Column | Reverse accessor on the target |
|---|---|---|---|
| Foreign key (many-to-one) | `field.fk(() => Target, opts)` | `<name>Id` | `relatedName`, default `<sourceModelName>_set` |
| One-to-one | `field.fk(() => Target, { unique: true })` | `<name>Id UNIQUE` | same as fk |
| Many-to-many | `field.m2m(() => Target, { through?, relatedName? })` | none; a through table | `relatedName`, default `<sourceModelName>_set` |

The target is a function so models can point at each other before both are defined.

### onDelete (fk only)

| Value | What happens when the target row is deleted |
|---|---|
| `'RESTRICT'` (default) | The database refuses the delete. |
| `'PROTECT'` | The ORM checks first and throws `DomainError('domain', 'cannot delete <model>: still referenced by <source>.<field> (on delete PROTECT)')`; the database also has RESTRICT. |
| `'CASCADE'` | Referencing rows are deleted too. |
| `'SET_NULL'` | The fk becomes NULL. Needs `optional: true`. |
| `'SET_DEFAULT'` | The fk becomes its `default`. Needs `default`. On MySQL the ORM sets it before deleting. |
| `'DO_NOTHING'` | `NO ACTION` in the database. |

### Many-to-many

- Without `through`: an auto table named `<model>_<field>` (shortened if over 63 chars) with `id`, `<model>Id`, `<target>Id`, both `CASCADE`, unique per pair. A self-referencing m2m uses `from_<model>Id` / `to_<model>Id`.
- With `through: () => ThroughModel`: your model, which must have one fk to each side. Its rows are created / deleted through its own `objects`; `related(...).add/remove/set/clear` refuse.

### Reverse names and clashes

Every reverse name on a model must be unique and must not equal one of its field names. A clash throws at `defineModel` time: `"<A>.<f> and <B>.<g> both give <T> the reverse name "<n>": set relatedName on one of them"`.

### RelatedManager (`Model.related(name, id)`)

```ts
interface RelatedManager<T> {
  all(): QuerySet<T>
  add(...items: (string | number | object)[]): Promise<void>
  remove(...items: (string | number | object)[]): Promise<void>
  set(items: (string | number | object)[]): Promise<void>
  clear(): Promise<void>
}
```

| Relation | `all()` | `add / remove / set / clear` |
|---|---|---|
| m2m (either direction), auto through | the related rows | add missing pairs / delete pairs / make the set exactly this / delete all pairs. Each runs in `atomic()`. Items are ids or rows (the row's pk is used). |
| m2m with custom `through` | the related rows | refused (`invalid_param`): write the through model |
| reverse fk (`orders`, `order_set`) | the referencing rows | refused: set the fk on those rows instead |
| forward fk | refused: read the fk with `get()` | refused |

## Registry and discovery

- `modelRegistry(): Model[]` — every defined model. The last definition per name wins.
- `discoverModels(appsDir)` (used by `makemigrations`, `migrate`, `tvine shell`, `dumpdata`, `loaddata`) imports `apps/<app>/models.ts` for each installed app. A model belongs to the app whose `models.ts` exports it. Exporting the same model from two apps throws. Finding no models at all throws (so a broken import is never read as "all models removed").
- Defining or importing a model opens no database connection; the connection is looked up when a query runs.

## Swappable user model

`settings.auth.userModel`, default `'auth.User'` (table `auth_user`). A custom value `'accounts.User'` means table `accounts_user`, defined with `defineUserModel` / `extendUser` from `tvine/auth` in `apps/accounts/models.ts`. It must be chosen before the first `tvine migrate`; changing it later makes `migrate` fail with a checksum message. Details: [contrib/auth.md](contrib/auth.md).

## Examples

```ts
// apps/shop/models.ts
import { defineModel, field, CheckConstraint, type Infer } from 'tvine'

export const Customer = defineModel('customer', {
  id: field.id(),
  email: field.email({ unique: true }),
  name: field.text({ searchable: true }),
  joinedAt: field.datetime({ autoNowAdd: true }),
})

export const Tag = defineModel('tag', {
  id: field.id(),
  name: field.slug({ unique: true }),
})

export const Product = defineModel('product', {
  id: field.id(),
  sku: field.text({ unique: true }),
  name: field.text({ searchable: true }),
  price: field.money(),
  stock: field.int({ default: 0 }),
  active: field.bool({ default: true }),
  tags: field.m2m(() => Tag, { relatedName: 'products' }),
  updatedAt: field.datetime({ autoNow: true }),
}, { ordering: ['name'], indexes: [['active', 'name']] })

export const Order = defineModel('order', {
  id: field.id(),
  customer: field.fk(() => Customer, { onDelete: 'PROTECT', relatedName: 'orders' }),
  status: field.enum(['cart', 'paid', 'shipped', 'cancelled'], { default: 'cart' }),
  total: field.money({ default: { value: 0, currency: 'USD' } }),
  createdAt: field.datetime({ autoNowAdd: true }),
}, { ordering: ['-createdAt'] })

export const OrderItem = defineModel('order_item', {
  id: field.id(),
  order: field.fk(() => Order, { onDelete: 'CASCADE', relatedName: 'items' }),
  product: field.fk(() => Product, { onDelete: 'PROTECT' }),
  quantity: field.int(),
}, {
  unique: [['order', 'product']],
  constraints: [CheckConstraint({ name: 'order_item_qty_positive', check: { quantity__gt: 0 } })],
})

export type Customer = Infer<typeof Customer>
export type Product = Infer<typeof Product>
export type Order = Infer<typeof Order>
```

Create, read, update, delete:

```ts
const ada = await Customer.create({ email: 'ada@example.com', name: 'Ada' })
const lamp = await Product.create({ sku: 'LAMP-1', name: 'Desk lamp', price: { value: 29.99, currency: 'USD' } })
const order = await Order.create({ customerId: ada.id })          // fk is passed as customerId
await OrderItem.create({ orderId: order.id, productId: lamp.id, quantity: 2 })

const same = await Product.get(lamp.id)                           // Product | undefined
await Product.update(lamp.id, { stock: 10 })                      // updatedAt set to now
await Order.delete(order.id)                                      // its items go too (CASCADE)
```

Many-to-many:

```ts
const desk = await Tag.create({ name: 'desk' })
await Product.related('tags', lamp.id).add(desk.id)
const tags = await Product.related('tags', lamp.id).all().all()   // QuerySet → rows
const lamps = await Tag.related('products', desk.id).all().all()  // reverse m2m by relatedName
await Product.related('tags', lamp.id).set([])                    // remove every tag
```

Reverse fk:

```ts
const adasOrders = await Customer.related('orders', ada.id).all().filter({ status: 'paid' }).all()
```

## Gotchas

- The fk key differs between definition and data: define `customer: field.fk(...)`, write and read `customerId`. Filters and `update()` accept both `customer` and `customerId`.
- `create()` refuses unknown keys, including m2m field names. Set m2m links with `related(...).add()` after creating.
- `Model.update()` sets `autoNow` fields; `Model.objects.filter(...).update()` does not.
- `get()` returns `undefined`, it does not throw. `update()` throws when the row is missing. `delete()` is silent.
- Rows are plain objects. There are no instance methods and no `save()`. (The user model gets methods such as `checkPassword` through an internal row prototype; app models cannot.)
- `default` must be a constant (it is written into the table DDL). There is no callable default; use `auto` / `autoNow` / `autoNowAdd` for timestamps, and a `uuid` pk is generated automatically.
- There is no separate one-to-one field: use `field.fk(..., { unique: true })`. Its reverse side is still a reverse fk (a list via `related()` / `prefetchRelated`), not a single object.
- `PROTECT` and `RESTRICT` both block deletes; only `PROTECT` gives the readable ORM error.

Not covered by the code (do not look for them): abstract models, model inheritance, proxy models, custom managers, verbose names / plural names, a `db_table` option (the name is the table), and model-level `clean()` validation.

## See also

- [fields.md](fields.md) — every field kind and option
- [queryset.md](queryset.md) — `objects`, lookups, relation spanning, prefetch
- [migrations.md](migrations.md) — turning models into tables
- [database.md](database.md) — connections and engines
- [contrib/auth.md](contrib/auth.md) — user model, `defineUserModel`, privacy export / erase
- [overview.md](overview.md)
