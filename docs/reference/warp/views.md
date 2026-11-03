# Class views, ViewSets, `@action` and routers

Class views are generic CRUD views. You export a class from
`apps/<app>/views.ts`; at boot Warp creates it once, checks its config against the model, and turns it into
ordinary actions: `list`, `get`, `create`, `update`, `delete` (whichever the base class generates) plus one action
per `@action` method. Those actions are registered exactly like `defineAction` ones (same ids, rules, MCP tools,
`api.*` calls, pipeline). Every call runs on a fresh `Object.create(view)`, so `this.x = …` never leaks between
requests. Routers (`SimpleRouter`) map a view's actions to REST URLs.

**Import:** `import { ListView, DetailView, ModelViewSet, action, defineSerializer, View, GenericView, type ViewCtx } from 'tvine'`
and `import { SimpleRouter, DefaultRouter } from 'tvine'` for routers.

## Base classes

| Class | Generated actions |
|---|---|
| `View` | none (only `@action` methods) |
| `GenericView` | none (`static actions = []`; set it yourself) |
| `ListView` | `list` |
| `DetailView` | `get` |
| `CreateView` | `create` |
| `UpdateView` | `update` |
| `DeleteView` | `delete` |
| `ListCreateView` | `list`, `create` |
| `RetrieveUpdateView` | `get`, `update` |
| `RetrieveDestroyView` | `get`, `delete` |
| `RetrieveUpdateDestroyView` | `get`, `update`, `delete` |
| `ModelViewSet` | `list`, `get`, `create`, `update`, `delete` |

## Ids of generated actions

The action name is the generated name: a `ListView` in `apps/catalog/` gives `catalog.list`. When two view
classes in one app generate the same name, both become `<ExportName>.<name>`: `catalog.ProductList.list`,
`catalog.CategoryList.list`. `@action` methods are named after the method (`catalog.addToCart`), with the same
collision rule.

## Generated actions

| Action | Params | Rules | Result |
|---|---|---|---|
| `list` | `q?` (when there are search fields), `sort?` (when `ordering` is set), `cursor?` or `page?`, one optional param per filter | `readOnly`, `search: 'q'` when searchable | `Paginated` (below), items serialized |
| `get` | `{ [lookupParam]: value }` (strict) | `readOnly` | the serialized object |
| `create` | the serializer input (strict) | — | the serialized new object (HTTP 201 through `urls.ts`) |
| `update` | `{ [lookupParam] }` + the serializer input, all optional (partial, strict) | — | the serialized object |
| `delete` | `{ [lookupParam] }` (strict) | `destructive` | `null` |

Missing object (or scoped out by `getQueryset`) → `DomainError('not_found', '<Model> <id> not found')` →
`domain` / `not_found` (HTTP 404).

List result:

```ts
// pagination 'cursor' (default)
{ items: Row[], pageSize: number, nextCursor?: string, total?: number }   // QuerySet.page(); pass nextCursor as ?cursor=
// pagination 'page'
{ items: Row[], total: number, pageSize: number, page: number, numPages: number }
```

## Options (instance fields)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `model` | `Model` | required (boot error "needs `model = SomeModel`") | The `defineModel` model. |
| `lookupField` | `string` | `'id'` | DRF `lookup_field`: the model field `get`/`update`/`delete` filter on. Must exist. |
| `lookupParam` | `string` | `'id'` | DRF `lookup_url_kwarg`: the param name carrying the lookup value. If the lookup field is writable in `update`, boot fails: set `lookupParam` to something else (e.g. `'key'`) or list it in `readOnlyFields`. |
| `serializer` | `Serializer<T>` | model default | `defineSerializer({ input?, readOnlyFields?, output })`. See [serializers.md](./serializers.md). |
| `permissions` | `Permission[]` | `[]` | Checked per call by `checkPermissions` (before params are validated). Ones that deny agents (`denyAgents`) are also copied into the action rules (MCP hiding), unless you override `getPermissions`. |
| `pageSize` | `number` | `settings.data.defaultPageSize` | Page size when set; else settings. Capped by `maxPageSize`. |
| `maxPageSize` | `number` | `settings.data.maxPageSize` | Upper cap when set; else settings. |
| `pagination` | `'cursor' \| 'page'` | `'cursor'` | `'cursor'`: keyset, stable under inserts. `'page'`: page numbers, `?page=N`. |
| `filters` | `string[]` | the model's enum fields and indexed fields (never hidden / writeOnly) | Field lookups allowed as params: `'status'`, `'price__lte'`, `'tags__in'`, `'name__contains'`. Suffixes: exact, `__lt`, `__lte`, `__gt`, `__gte`, `__in` (comma list or array), `__contains` (text/email/url/slug only, max 200 chars), `__ne`. Unknown field or suffix → boot error. |
| `searchFields` | `string[]` | the model's `searchable` fields | Fields `?q=` searches (max 200 chars). A money field cannot be searched. |
| `ordering` | `string[]` | `[]` | Allowed `sort` values; each also allowed as `-field` (descending). |
| `shapers` | `Shapers` | from `apps/<app>/serializers.ts` | Set by discovery; output shapers by model name. See [serializers.md](./serializers.md). |

### Static fields

| Static | Type | Meaning |
|---|---|---|
| `static permissions` | `Permission[]` | Merged into the rules of every action of the class (checked by dispatch, visible to MCP hiding). |
| `static actions` | `readonly GeneratedAction[]` | Which of `list/get/create/update/delete` to generate (set by the base classes). |

### Param coercion

Filter and lookup values may arrive as URL strings; they are coerced by field type: `"30"` → `30` for
int/float/id/duration, `"true"`/`"false"` for bool, ISO strings → `Date` for datetime, money in major units
(`"30"` = 30.00, max 2 decimals), `"a,b"` → array for `__in`. An empty string is treated as absent.

## Hooks you can override

Names follow DRF, camelCase. `ctx` is a `ViewCtx` (`ActionCtx` + `action`, `actionId`, `params`).

| Hook | Default | Override to |
|---|---|---|
| `getQueryset(ctx)` | `this.model.objects` | Scope rows to the user / tenant. Every list/get/update/delete read goes through it. |
| `filterQueryset(qs, ctx)` | applies filters, `q`, `sort` | Add custom filtering. |
| `paginateQueryset(qs, ctx)` | cursor or page pagination | Change paging. |
| `getObject(ctx)` | scoped + filtered + lookup, `not_found` if none, then `checkObjectPermissions` | Custom lookup. |
| `getPermissions(ctx)` | `this.permissions` | Per-action permissions. |
| `checkPermissions(ctx)` | runs `getPermissions` | — |
| `checkObjectPermissions(ctx, obj)` | allow | Throw `DomainError('forbidden', …)` to deny (DRF `has_object_permission`). |
| `getSerializer(ctx)` | `this.serializer` or the model default | Pick a serializer per action. The advertised create/update schema is read at boot with `ctx.action` set and an anonymous user. |
| `getSerializerContext(ctx)` | `{ request, user, view, action }` | Extra data for `output(obj, sctx)`. |
| `performCreate(data, ctx)` | `model.create(data)` | Set owner, side effects. |
| `performUpdate(obj, data, ctx)` | `model.update(obj.id, data)` (no-op if `data` empty) | — |
| `performDestroy(obj, ctx)` | `model.delete(obj.id)` | Soft delete. |

Order per call: permissions → validate params → hooks → serializer output.

## `@action`

```ts
function action<S extends z.ZodType>(schema: S, opts?: {
  rules?: ActionRules          // any defineAction rule
  permissions?: Permission[]   // extra permissions for this action
  detail?: boolean             // routers: true = on /<prefix>/<id>/<name>/
  methods?: string[]           // routers: HTTP methods
}): MethodDecorator
```

| Option | Default | Meaning |
|---|---|---|
| `rules` | `{}` | Same keys as [actions.md](./actions.md#rules-actionrules). |
| `permissions` | `[]` | Added to the static and instance permissions. |
| `detail` | `true` when the schema has the view's `lookupParam` | Router URL shape. |
| `methods` | `['GET']` if `rules.readOnly`, else `['POST']` | Router methods. `GET` on a non-readOnly action is a boot error in `urls.ts`. |

The method must be public, non-static, string-named. `this` is the view (a per-call copy), so
`this.getObject(ctx)` and `this.getQueryset(ctx)` work. On a `GenericView`, `checkPermissions` runs first.
Works with TC39 decorators, the 2018-09 form (Next's SWC) and `experimentalDecorators`.

## Page helpers (static)

| Helper | Returns | Notes |
|---|---|---|
| `View.asAction(name)` / `View.action(name)` | the registered `ActionDef` | For `<Form action={ProductDetail.asAction('addToCart')}>` or `path('x/', ProductDetail.action('addToCart'))`. Throws if the view was not discovered. |
| `await ListViewClass.queryset(searchParams, ctx?)` | the same `Paginated` as `<app>.list` | Unknown or invalid URL keys are dropped (a hand-edited URL never 500s). Without `ctx`, hooks see `ANONYMOUS`. |
| `await DetailViewClass.object(id, { request? })` | serialized object or `undefined` | `undefined` for `not_found` / `forbidden`; call `notFound()`. |

## Routers

```ts
class SimpleRouter {
  constructor(opts?: { trailingSlash?: boolean })            // default true
  register(prefix: string, view: ViewClass, opts?: { basename?: string }): this
  get urls(): UrlEntry[]
}
class DefaultRouter extends SimpleRouter {}                    // same; no API root view
```

| Route | Methods | Name |
|---|---|---|
| `<prefix>/` | `GET` → `list`, `POST` → `create` | `<basename>-list` |
| `<prefix>/<id>/` | `GET` → `get`, `PUT`/`PATCH` → `update`, `DELETE` → `delete` | `<basename>-detail` |
| `<prefix>/<id>/<name>/` | `@action` with `detail: true` | `<basename>-<name>` |
| `<prefix>/<name>/` | `@action` with `detail: false` | `<basename>-<name>` |

`basename` defaults to the lowercased model name. The `<id>` converter is `int` when the lookup field is an id
or int field, else any segment without `/` or `.`. Use `router.urls` in a `urlpatterns` array; see [urls.md](./urls.md).

## Examples

### 1. Product list + detail with an extra action

```ts
// apps/catalog/views.ts
import { z } from 'zod'
import { action, DetailView, ListView, type ViewCtx } from 'tvine'
import { Product } from './models.ts'

export class ProductList extends ListView<Product> {      // → catalog.list
  model = Product
  filters = ['category', 'price__lte', 'tags__in']          // ?category=hats&price__lte=30
  searchFields = ['name', 'description']                  // ?q=wool
  ordering = ['price', 'createdAt']                        // ?sort=-price
  pageSize = 24
}

export class ProductDetail extends DetailView<Product> {  // → catalog.get
  model = Product

  @action(z.object({ id: z.number().int(), qty: z.number().int().min(1) }))
  async addToCart({ id, qty }: { id: number; qty: number }, ctx: ViewCtx) {   // → catalog.addToCart
    const p = await this.getObject(ctx)                    // ctx.params = { id, qty }, validated
    const cart = (ctx.session.data.get('cart') as Record<number, number> | undefined) ?? {}
    cart[p.id] = (cart[p.id] ?? 0) + qty
    ctx.session.data.set('cart', cart)
    return { ok: true }
  }
}
```

### 2. Orders scoped to the signed-in user

```ts
import { isAuthenticated, ListView } from 'tvine'
import { Order } from './models.ts'

export class MyOrders extends ListView<Order> {            // → orders.list
  model = Order
  static permissions = [isAuthenticated]
  pagination = 'page' as const
  ordering = ['createdAt']
  getQueryset(ctx) { return Order.objects.filter({ customer: ctx.request.user.id }) }
}
```

### 3. A ViewSet with owner set on create and a router

```ts
// apps/catalog/views.ts
import { defineSerializer, DomainError, ModelViewSet } from 'tvine'
import { Review } from './models.ts'

export class ReviewViewSet extends ModelViewSet<Review> {
  model = Review
  serializer = defineSerializer<Review>({ readOnlyFields: ['author'], output: (r) => ({ id: r.id, stars: r.stars, text: r.text }) })
  performCreate(data, ctx) { return Review.create({ ...data, author: ctx.request.user.id }) }
  async checkObjectPermissions(ctx, obj) {
    if (ctx.action !== 'get' && obj.author !== ctx.request.user.id) throw new DomainError('forbidden', 'not your review')
  }
}

// apps/catalog/urls.ts
import { SimpleRouter } from 'tvine'
import { ReviewViewSet } from './views.ts'
const router = new SimpleRouter().register('reviews', ReviewViewSet)
export const appName = 'catalog'
export const urlpatterns = router.urls     // /reviews/ and /reviews/<int:id>/
```

### 4. Server component using the helpers

```tsx
// app/shop/page.tsx
import { ProductList } from '@/apps/catalog/views'
export default async function Shop({ searchParams }) {
  const page = await ProductList.queryset(await searchParams)     // same data as api.catalog.list
  return <ul>{page.items.map((p) => <li key={String(p.id)}>{String(p.name)}</li>)}</ul>
}
```

(Pages should normally call `api.catalog.list(...)`; importing a view class that imports models may trip the
FE/DB boundary check in `tvine check`.)

## Gotchas

- A view class is instantiated once at boot; per-request state on `this` is per call (a fresh copy), not shared.
- `filters` default to the model's enum and indexed fields: set `filters = []` to turn filtering off.
- Every list/get/update/delete read goes through `getQueryset`; scope there, not in `filterQueryset`.
- `update` is always partial; `create` input comes from the serializer (or the model minus read-only fields).
- `serializer.input` must be a plain `z.object(...)` (no `.refine` on the object), or boot fails.
- Switching serializers per request works at run time but the advertised schema (MCP, types) is the boot one.
- Unknown params are rejected (`invalid_param`, "unknown param"); sending a read-only field gives code `read_only`.
- Two classes generating the same action name in one app get prefixed ids (`catalog.ProductList.list`).

## See also

[actions.md](./actions.md) · [serializers.md](./serializers.md) · [urls.md](./urls.md) · [errors.md](./errors.md) ·
[models.md](./models.md) · [contrib/auth.md](./contrib/auth.md) · [overview.md](./overview.md)
