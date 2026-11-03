# QuerySet

`Model.objects` is a `QuerySet`: a lazy, immutable description of a query. Chain methods (`filter`, `exclude`, `order`, `annotate`, ...) return a new QuerySet and run nothing. Terminal methods (`all`, `first`, `count`, `update`, ...) return a Promise and run SQL. Values always travel as bound parameters, never as SQL text. Source: `warp/src/data/queryset.ts`, `expressions.ts`, `sql/compile.ts`, `related.ts`, `paginator.ts`, `pending.ts`, `engine.ts`.

## Import

```ts
import {
  F, Q, Value, Case, When, Coalesce, Lower, Upper, Length, Abs, Cast, TruncDay, TruncMonth, TruncYear,
  Sum, Count, Avg, Min, Max, Exists, OuterRef, Subquery, Prefetch,
  Paginator, atomic, onCommit, defer, setOnCommitErrorHandler, inc, dec, type Page, type Paginated,
} from 'tvine'
```

Examples below use the shop models from [models.md](models.md#examples): `Customer`, `Product`, `Tag`, `Order` (fk `customer`, relatedName `orders`), `OrderItem` (fk `order` relatedName `items`, fk `product`).

## Chain methods (return a new QuerySet)

| Method | Signature | Meaning |
|---|---|---|
| `filter` | `filter(where: Record<string, unknown> \| QNode \| Expression \| Where[])` | Keep rows matching every lookup (AND). Chained calls AND together. |
| `exclude` | `exclude(where)` | Drop rows matching ONE condition. A plain object with more than one key throws; chain calls or pass `Q(...)`. Null-inclusive: rows where the field is NULL are kept. |
| `order` | `order(...fields: (string \| OrderBy)[])` | Replace the order. `'name'` asc, `'-name'` desc, `'customer__name'` across a relation, an annotation name, or `F('x').desc({ nulls: 'last' })`. |
| `search` | `search(term: string, fields?: string[])` | Case-insensitive substring match OR-ed over `fields` (default: the model's `searchable` fields; throws if none). |
| `slice` | `slice(start: number, end?: number)` | `LIMIT` / `OFFSET` (Django `qs[start:end]`). Non-negative integers. A slice of a slice narrows it. |
| `limit` | `limit(n)` | `slice(0, n)` |
| `offset` | `offset(n)` | `slice(n)` |
| `annotate` | `annotate({ name: Expression, ... })` | Add computed columns. Names must be identifiers without `__` and must not clash with field names. An aggregate makes the query grouped. |
| `having` | `having(q: QNode \| Record<string, unknown>)` | Add a condition (a condition on an aggregate goes to `HAVING`; `filter` does that too). |
| `values` | `values(...names: string[])` | Return plain objects with only these keys (fields, annotations, relation paths). No names = every field + annotation. |
| `valuesList` | `valuesList(...names, { flat?: boolean })` | Return arrays (`[[1, 'Ada'], ...]`), or with `{ flat: true }` and exactly one name, the bare values (`[1, 2]`). |
| `distinct` | `distinct(...fields: string[])` | `SELECT DISTINCT`; with fields, `DISTINCT ON` (Postgres only; `order()` must start with the same fields). |
| `selectRelated` | `selectRelated(...paths: string[])` | Join fk chains (`'customer'`, `'order__customer'`) and attach each related row as an object under the fk name. Forward fk only. |
| `prefetchRelated` | `prefetchRelated(...lookups: (string \| PrefetchNode)[])` | After the main query, load relations with one extra query per hop (IN batched by 1000). Works for fk, reverse fk and m2m; `'items__product'` chains. |
| `selectForUpdate` | `selectForUpdate({ nowait?, skipLocked?, of? })` | `SELECT ... FOR UPDATE`. Must run inside `atomic()`. `nowait` and `skipLocked` are exclusive. No-op on SQLite. |

Once a slice is taken, `filter`, `exclude`, `order`, `update`, `delete`, `aggregate` and `last` throw ("cannot ... a queryset once a slice has been taken").

## Terminal methods (return a Promise)

| Method | Returns | Meaning |
|---|---|---|
| `all(limit = Infinity)` | `T[]` | Every row (or the first `limit`). Fetches in cursor pages of 100, so large tables take several queries. |
| `fetchAll()` | `T[]` | Every row in ONE query. |
| `first()` | `T \| undefined` | First row under the current order. |
| `last()` | `T \| undefined` | Last row (order reversed, pk tie-break included). |
| `count()` | `number` | `COUNT(*)` of the filter (respects a slice). |
| `exists()` | `boolean` | Whether any row matches. |
| `page({ cursor?, size? }, count = true)` | `Paginated<T>` | One cursor page: `{ items, total?, pageSize, nextCursor? }`. `size` default 25, clamped to 1..100. Pass `nextCursor` back as `cursor`. Not for `values()` or sliced querysets. |
| `aggregate({ name: Aggregate })` | `{ [name]: value }` | One row of aggregates over the filter. |
| `inBulk(ids, { field? })` | `Record<string, T>` | Rows keyed by id (or by `field`), IN batched by 1000. |
| `update(patch)` | `number` | `UPDATE` matching rows; returns rows changed. Values validated per field; also takes `inc(n)`, `dec(n)` and expressions. Does NOT touch `autoNow` fields. |
| `delete()` | `number` | `DELETE` matching rows (no filter = every row); `onDelete` rules apply. |
| `getOrCreate(lookup, defaults = {})` | `[T, boolean]` | Find by `lookup` or create from its plain keys + `defaults`; `true` = created. Race-safe (insert-or-nothing, then re-read), in `atomic()`. |
| `updateOrCreate(lookup, defaults = {})` | `[T, boolean]` | Lock the match and write `defaults` to it, or create. |
| `bulkCreate(rows, { batchSize? })` | `T[]` | Multi-row INSERTs in one `atomic()` (at most 1000 rows / 30 000 params per statement). Give the id for every row or none. On MySQL the returned rows are the given rows (no auto ids). |
| `bulkUpdate(rows, fields, { batchSize? })` | `number` | Write `fields` of each row (each needs its pk) with one `CASE` UPDATE per batch, in one `atomic()`. |

## Lookups

A filter key is `path` or `path__lookup`. `path` is a field name (an fk may be written `customer` or `customerId`), an annotation name, or a relation path `a__b__c`.

| Lookup | Example | SQL meaning |
|---|---|---|
| (none) / `exact` / `eq` | `{ status: 'paid' }` | `=`; `null` value → `IS NULL` |
| `ne` | `{ status__ne: 'cart' }` | `<>`, NULL rows included (`IS NULL OR <> x`) |
| `gt` `gte` `lt` `lte` | `{ stock__lte: 5 }` | `>` `>=` `<` `<=` |
| `in` | `{ id__in: [1, 2, 3] }` | `IN (...)`; at most 1000 values; `[]` matches nothing; or a `Subquery(...)` |
| `range` | `{ createdAt__range: [from, to] }` | inclusive `BETWEEN`; exactly two non-null values |
| `contains` / `icontains` | `{ name__contains: 'lamp' }` | case-insensitive substring (both the same) |
| `startswith` / `istartswith` | `{ sku__startswith: 'LAMP' }` | case-insensitive prefix |
| `endswith` / `iendswith` | `{ email__endswith: '@example.com' }` | case-insensitive suffix |
| `iexact` | `{ email__iexact: 'Ada@Example.com' }` | case-insensitive equality; string only |
| `isnull` | `{ customer__isnull: true }` | `IS NULL` / `IS NOT NULL` |
| `year` `month` `day` | `{ createdAt__year: 2026 }`, `{ createdAt__month__gte: 6 }` | date part (UTC) of a `date` / `datetime`; can be followed by a lookup |
| `date` | `{ createdAt__date: '2026-11-03' }` | the UTC day of a datetime as `'YYYY-MM-DD'` |
| `currency` | `{ total__currency: 'EUR' }` | the currency column of a money field |

`contains` is substring search on the column's text form, so it also works on numbers and uuids. Money refuses `contains`, `startswith`, `endswith`, `iexact`. Encrypted fields allow only exact match (see [fields.md](fields.md#fieldencryptedopts)).

### Relation spanning

| Path | Relation | Example |
|---|---|---|
| `customer__email` | forward fk | `Order.objects.filter({ customer__email: 'ada@example.com' })` |
| `orders__status` | reverse fk (by `relatedName`; default `<model>_set`) | `Customer.objects.filter({ orders__status: 'paid' })` |
| `tags__name` | m2m (either direction) | `Product.objects.filter({ tags__name: 'desk' })` |
| `items__product__sku` | several hops | `Order.objects.filter({ items__product__sku: 'LAMP-1' })` |
| `orders__isnull: true` | "has no related row" | customers with no orders |
| `orders` (bare) | the related pk | `Customer.objects.filter({ orders__in: [1, 2] })` |

Filters across relations compile to `IN (SELECT ...)` subqueries, so a row is never duplicated by a to-many relation. Inside ONE `filter()` call (or one `Q` AND node), several lookups through the same to-many relation must all hold for the SAME related row; separate `filter()` calls are independent (Django semantics).

### Values compared to fields and expressions

A lookup value may be an expression: `{ stock__lt: F('reorderAt') }`, `{ id__in: Subquery(qs.values('customer')) }`, `{ customer: OuterRef('id') }` inside a subquery.

## Q objects

```ts
Q(lookups?: Record<string, unknown> | Expression): QNode
q.and(...others: (QNode | Record<string, unknown> | Expression)[]): QNode
q.or(...others): QNode
q.not(): QNode
```

TypeScript has no `&` `|` `~` overloading: use `.and`, `.or`, `.not`. `exclude(Q(...))` negates the whole Q (Django semantics). Negation is null-inclusive.

## Expressions (`data/expressions.ts`)

| Builder | Meaning |
|---|---|
| `F(name)` | A field, annotation or relation path (`F('customer__name')`). |
| `Value(v)` | A literal parameter. Money: `Value({ value: 5, currency: 'USD' })`. |
| `expr.add(x)` `.sub(x)` `.mul(x)` `.div(x)` | Arithmetic; numeric fields only. Money: `+`/`-` another amount of the same currency; `*`/`/` a plain number (money on the left). |
| `expr.asc({ nulls? })` `expr.desc({ nulls? })` | An order term; `nulls: 'first' \| 'last'`. In `order()` only on `F(name)`; annotate other expressions first. |
| `Coalesce(...xs)` | First non-null. |
| `Lower(x)` `Upper(x)` | Unicode-aware case. |
| `Length(x)` | Character length (int). |
| `Abs(x)` | Absolute value. |
| `Cast(x, 'int' \| 'float' \| 'text')` | Type cast. |
| `TruncDay(x)` `TruncMonth(x)` `TruncYear(x)` | Datetime truncated in UTC; datetime fields only. |
| `Case(When(cond, then), ..., { default })` | Conditional value; at least one `When`. `cond` is lookups, a `Q` or a boolean expression. |
| `Subquery(qs)` | Scalar subquery (first row; use `.values('one')` to pick the column, else the pk), or the right side of `__in`. |
| `Exists(qs)` | Boolean; use in `filter()` or `annotate()`. |
| `OuterRef(name)` | A column of the outer query, inside `Subquery` / `Exists`. |
| `Prefetch(path, queryset?)` | A `prefetchRelated` hop with a custom queryset (filter / order the related rows). |

Strings passed where an expression is expected (`Lower('name')`, `Sum('total')`) are field references.

## Aggregates

```ts
Sum(x, { distinct?, filter? })   Avg(x, opts)   Min(x, opts)   Max(x, opts)
Count(x = '*', { distinct?, filter? })
```

| Option | Meaning |
|---|---|
| `distinct` | Aggregate distinct values only. |
| `filter` | Lookups or `Q`: only matching rows count (Django `filter=`). |

Results: `Count` is `0` on no rows; `Sum` / `Avg` / `Min` / `Max` are `null`. `Avg` is a float (on money: rounded to whole cents). `Sum` / `Avg` need a numeric field. On money they return `{ value, currency }`; if the rows mix currencies, reading the result throws `invalid_param` ("mixes currencies"): filter on `<field>__currency` or group by it. Aggregates cannot be nested. `aggregate()` is not supported over `values()`, `distinct()` or aggregate annotations.

Grouping (Django `values().annotate()`): `values(...)` names become `GROUP BY` columns when an annotation is an aggregate. Without `values()`, an aggregate annotation groups per row of the model.

## Pagination

Cursor pages (`qs.page(...)`) are the default for lists. For "page 3 of 12" use `Paginator` (OFFSET / LIMIT):

```ts
new Paginator<T>(objectList: QuerySet<T>, perPage: number, opts?: { orphans?: number; allowEmptyFirstPage?: boolean })
```

| Member | Returns | Meaning |
|---|---|---|
| `count()` | `Promise<number>` | Total rows (one COUNT, cached). |
| `numPages()` | `Promise<number>` | At least 1, unless `allowEmptyFirstPage: false` and there are no rows. |
| `validateNumber(n)` | `Promise<number>` | Accepts an integer or a digit string; else `DomainError('invalid_param', ..., 'page')`. |
| `page(n)` | `Promise<Page<T>>` | `{ items, number, numPages, count, hasNext, hasPrevious, startIndex, endIndex }` (indexes 1-based, 0 when empty). |

| Option | Default | Meaning |
|---|---|---|
| `orphans` | `0` | If the last page would have this many items or fewer, they join the previous page. |
| `allowEmptyFirstPage` | `true` | Page 1 is valid even with no rows. |

## Transactions

```ts
atomic<R>(body: () => Promise<R>, opts?: { signal?: AbortSignal; lazy?: boolean }): Promise<R>
onCommit(fn: () => unknown): void | Promise<void>
defer(fn: () => unknown): void
setOnCommitErrorHandler(fn: (e: unknown) => void): void
```

| Function | Behaviour |
|---|---|
| `atomic(body)` | Runs `body` in one transaction: commit when it resolves, rollback when it throws (or `signal` aborts). A nested `atomic()` joins the outer block (no savepoints). Queries from the callback after the block ended throw. |
| `atomic(body, { lazy: true })` | The transaction opens at the first query; a block that never queries opens nothing. Used per request. |
| `onCommit(fn)` | Inside `atomic()`: run after the outermost commit, dropped on rollback. Outside: run now. From a block already rolled back: throws. A hook that throws after commit goes to the `setOnCommitErrorHandler` handler (default `console.error`), the commit stands. |
| `defer(fn)` | Like `onCommit`, but runs on the next tick outside any transaction and does not hold up the response; errors go to the `tvine.defer` logger. |

Every action that is not `readOnly` already runs inside a lazy `atomic()` when `settings.db.atomicRequests` is `true` (the default). See [database.md](database.md#settingsdb).

## Await or not

QuerySets are not thenables: `await Product.objects.filter(...)` gives back the QuerySet, not rows. Call a terminal method.

Every public ORM call is tracked by the enclosing scope (a request handler, an `atomic()` block, a task job):

- Calls run one after another in call order on the scope's connection.
- The scope waits for all of them before it ends (before COMMIT / before the reply), even ones you did not `await`.
- A failed call nobody awaited fails the scope like a throw (the request rolls back).

Tracked calls: reads `page`, `all`, `fetchAll`, `first`, `last`, `count`, `exists`, `aggregate`, `inBulk`, `Model.get`; writes `update`, `delete`, `getOrCreate`, `updateOrCreate`, `bulkCreate`, `bulkUpdate`, `Model.create`, `Model.update`, `Model.delete`, and `related(...).add / remove / set / clear`. Outside any scope (a script, top level), an un-awaited write still runs; the first one logs a warning on `tvine.db` and a failure is logged, not thrown. Await reads you need the result of.

## Examples

Filters, Q and ordering:

```ts
const cheap = await Product.objects.filter({ active: true, price__lt: 20 }).order('-stock', 'name').all()

const lowOrHidden = await Product.objects
  .filter(Q({ stock__lte: 5 }).or({ active: false }))
  .exclude({ sku__startswith: 'TEST' })
  .fetchAll()

const paidThisYear = await Order.objects
  .filter({ status: 'paid', createdAt__year: 2026, customer__email__endswith: '@example.com' })
  .count()
```

Updates with `inc` / `dec` / `F`, and a safe stock check in a transaction:

```ts
import { atomic, dec, DomainError, F } from 'tvine'

await atomic(async () => {
  const p = await Product.objects.filter({ id: 7 }).selectForUpdate().first()
  if (!p || p.stock < 2) throw new DomainError('domain', 'not enough stock', 'stock')
  await Product.objects.filter({ id: 7 }).update({ stock: dec(2) })
})
await Product.objects.filter({ active: true }).update({ stock: F('stock').add(10) })
```

Aggregates, grouping and annotations:

```ts
const totals = await Order.objects.filter({ status: 'paid', total__currency: 'USD' })
  .aggregate({ revenue: Sum('total'), orders: Count(), avg: Avg('total') })
// { revenue: { value: 1234.5, currency: 'USD' }, orders: 42, avg: { value: 29.39, currency: 'USD' } }

const byStatus = await Order.objects.values('status').annotate({ n: Count() }).order('status').all()
// [{ status: 'cart', n: 3 }, { status: 'paid', n: 42 }]

const loyal = await Customer.objects
  .annotate({ orderCount: Count('orders') })     // LEFT JOIN order, GROUP BY customer
  .filter({ orderCount__gte: 3 })                // goes to HAVING
  .order('-orderCount')
  .all()

const paidPerCustomer = await Order.objects.filter({ status: 'paid' })
  .values('customer').annotate({ n: Count() }).order('customer').all()   // [{ customer: 1, n: 4 }, ...]

const labelled = await Order.objects.annotate({
  size: Case(When({ total__gte: 100 }, 'large'), { default: 'small' }),
  day: TruncDay('createdAt'),
}).values('id', 'size', 'day').all()
```

Subqueries and Exists:

```ts
const buyers = await Customer.objects
  .filter(Exists(Order.objects.filter({ customer: OuterRef('id'), status: 'paid' })))
  .all()

const withLast = await Customer.objects.annotate({
  lastOrderAt: Subquery(Order.objects.filter({ customer: OuterRef('id') }).order('-createdAt').values('createdAt')),
}).all()

const tagged = await Product.objects
  .filter({ id__in: Subquery(Product.objects.filter({ tags__name: 'desk' }).values('id')) })
  .valuesList('sku', { flat: true })
  .all()   // ['LAMP-1', ...]
```

Related rows, pages and get-or-create:

```ts
type OrderWith = Order & { customer: Customer; items: { productId: number; quantity: number }[] }
const recent = await Order.objects.selectRelated('customer').prefetchRelated('items').limit(20).all() as OrderWith[]
recent[0]?.customer.email

const page1 = await Product.objects.filter({ active: true }).page({ size: 50 })
const page2 = await Product.objects.filter({ active: true }).page({ size: 50, cursor: page1.nextCursor })

const [tag, created] = await Tag.objects.getOrCreate({ name: 'desk' })

const pager = new Paginator(Product.objects.filter({ active: true }), 20, { orphans: 3 })
const p3 = await pager.page(3)   // { items, number: 3, numPages, count, hasNext, ... }
```

## Gotchas

- `exclude({ a: 1, b: 2 })` throws. Chain `.exclude({ a: 1 }).exclude({ b: 2 })` (NOT a AND NOT b) or use `exclude(Q({ a: 1, b: 2 }))` (NOT (a AND b)).
- `exclude` and `ne` keep NULL rows (`exclude({ status: 'paid' })` returns rows with `status` NULL too).
- `contains`, `startswith`, `endswith` are always case-insensitive. There is no case-sensitive substring lookup.
- `__in` accepts at most 1000 values; split the list or use `Subquery`.
- `selectRelated` / `prefetchRelated` attach objects that the row type does not show; cast as in the example.
- `Meta.ordering` applies to every query without `.order()`, including `values().annotate()` groupings. Its column is then in ORDER BY but not in GROUP BY: SQLite accepts that, Postgres refuses it. Call `.order(...)` with grouped columns on grouped queries.
- `F()` in `update()` cannot cross relations; filters in `update()` / `delete()` can.
- `QuerySet.update()` skips `autoNow`; use `Model.update(id, patch)` when the timestamp must move.
- `all()` on a big table runs one query per 100 rows (cursor loop). Use `fetchAll()` for one query, or `page()` for real paging.
- `distinct('field')` is Postgres only.
- Inside an aggregate's `filter`, a relation path (`Count('orders', { filter: { orders__status: 'paid' } })`) is an IN subquery on the OUTER row, not a test of each joined row, so it does not count per related row. Aggregate from the related model instead (`Order.objects.filter({ status: 'paid' }).values('customer').annotate({ n: Count() })`). Plain fields of the aggregated model in `filter` work as expected.

Not covered by the code: a raw SQL query API (`raw()`, `extra()`, a cursor), `iterator()`, `union` / `intersection` / `difference`, `only` / `defer` column lists, `reverse()`, `dates()`, `get()` on a QuerySet (use `first()` or `Model.get(id)`), savepoints inside nested `atomic()`. The only raw SQL is `ops.runSQL` in migrations.

## See also

- [models.md](models.md) — the models used above, `related()` managers
- [fields.md](fields.md) — per-field values and filter support
- [database.md](database.md) — engines, pooling, `atomicRequests`
- [views.md](views.md) — generic views that build querysets from requests
- [errors.md](errors.md) — `DomainError` codes
