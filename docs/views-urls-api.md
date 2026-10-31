# Views, URLs and the `api.*` client

Backend code lives in `apps/<app>/views.ts`. Every function or method you write there becomes an **action** with
the id `<app folder>.<name>`. One action answers in four places at once, with the same checks every time:

| Caller | How it calls `catalog.list` |
|---|---|
| Your pages (server or client components) | `api.catalog.list({ ... })` |
| Browser `fetch` | `POST /tvine/api/catalog.list` |
| AI agents over MCP | the `catalog_list` tool, or `do` |
| REST clients (optional) | a path you add in `urls.ts`, e.g. `GET /api/products/` |

Each call goes through one pipeline: zod validation, permissions, rate limits, one database transaction per
request, idempotency (`cmdId`), serializers.

## Setup

Nothing to install beyond `@tvine/warp`. Warp finds `apps/<app>/views.ts` by itself and registers every
exported action and view class. Check what it found:

```bash
cd apps/demo-shop
pnpm exec tvine check        # ... ok: 57 actions
```

## Function actions: `defineAction`

```ts
import { z } from 'zod'
import { defineAction } from '@tvine/warp'
import { Note } from './models.ts'

export const clearAll = defineAction('clearAll', z.object({}),
  async () => ({ deleted: await Note.objects.delete() }),
  { humanOnly: 'Deleting every note', destructive: true })      // → notes.clearAll
```

`defineAction(name, schema, run, rules?)`. `run(params, ctx)` gets the validated params and `ctx`
(`ctx.request.user`, `ctx.request.agent`, `ctx.request.ip`, the session).

### Rules (the 4th argument, or `@action(schema, { rules })`)

| Rule | What it does |
|---|---|
| `readOnly: true` | a read: allowed during page render, `GET` in `urls.ts`, MCP `readOnlyHint` |
| `destructive: true` | metadata only: MCP `destructiveHint`, danger style in the UI |
| `confirm: { message, by? }` | first call returns `confirm_required` + a one-time token; the second call with `$confirm` runs it. `by: 'human'` = only a person may say yes |
| `humanOnly: true \| 'reason'` | every agent path gets `human_only` (403); a person's click works |
| `rate: { limit, windowMs }` | per-action rate limit |
| `mcp: false` | not exposed over MCP at all |
| `permissions: [...]` | DRF-style permission classes ([permissions.md](design/conventions/permissions.md)) |
| `bind` | keys that come only from a server-signed bind, never from the caller |

Full list: [core-actions.md](design/server/core-actions.md), [permissions.md](design/conventions/permissions.md).

## Class views (DRF generics)

```ts
import { z } from 'zod'
import { action, DetailView, ListView, type ViewCtx } from '@tvine/warp'
import { Product } from './models.ts'

export class ProductList extends ListView<Product> {   // → catalog.list
  model = Product
  filters = ['category', 'price__lte']   // ?category=hats&price__lte=30
  searchFields = ['name']                // ?q=
  ordering = ['price', 'name']           // ?sort=-price
  pageSize = 24
}

export class ProductDetail extends DetailView<Product> { // → catalog.get
  model = Product

  @action(z.object({ id: z.number().int(), qty: z.number().int().min(1) }))
  async addToCart({ id, qty }, ctx: ViewCtx) { /* ... */ }  // → catalog.addToCart
}
```

(from `apps/demo-shop/apps/catalog/views.ts`)

| View | Actions it generates |
|---|---|
| `ListView` | `list` (read) |
| `DetailView` | `get` (read) |
| `CreateView` / `UpdateView` / `DeleteView` | `create` / `update` (partial) / `delete` (destructive) |
| `ListCreateView`, `RetrieveUpdateView`, `RetrieveDestroyView`, `RetrieveUpdateDestroyView` | the DRF combinations |
| `ModelViewSet` | all five |

### Options on a view

| Option | Default | Meaning |
|---|---|---|
| `model` | required | a `defineModel` model |
| `filters` | `[]` | Django lookups allowed as params: `'category'`, `'price__lte'`, `'name__contains'` |
| `searchFields` | `[]` | fields searched by `q` |
| `ordering` | `[]` | allowed `sort` values (`-price` = descending) |
| `pageSize` / `maxPageSize` | 25 / 100 | page size |
| `pagination` | `'cursor'` | `'page'` switches to page numbers (`{ items, total, page, numPages }`) |
| `lookupField` / `lookupParam` | `'id'` | DRF `lookup_field` / `lookup_url_kwarg` |
| `serializer` | all non-hidden fields | `defineSerializer({ input?, output })` |
| `permissions` | `[]` | DRF `permission_classes` |

### Hooks you can override (DRF names, camelCase)

`getQueryset`, `filterQueryset`, `paginateQueryset`, `getObject`, `getPermissions`, `checkPermissions`,
`checkObjectPermissions`, `getSerializer`, `getSerializerContext`, `performCreate`, `performUpdate`,
`performDestroy`. Scope a list to the user:

```ts
getQueryset(ctx) { return Order.objects.filter({ owner: ctx.request.user.id }) }
```

### `@action`

`@action(schema, { rules?, permissions?, detail?, methods? })` on a public method. The method's `this` is the
view, so `this.getQueryset()` works. Depth: [generic-views.md](design/conventions/generic-views.md).

## URLs: `urls.ts` (optional)

Without a root `urls.ts`, every action still answers at `POST /tvine/api/<app>.<name>`. Add one for REST paths:

```ts
// urls.ts (next to settings.ts)
import { include, path } from '@tvine/warp'
export const urlpatterns = [path('api/', include('notes.urls'))]

// apps/notes/urls.ts
import { path } from '@tvine/warp'
import { NoteList } from './views.ts'
export const appName = 'notes'
export const urlpatterns = [
  path('notes/', NoteList, { name: 'notes' }),                          // GET → notes.list
  path('notes/<int:id>/pin/', NoteList.action('pin'), { name: 'pin' }),
]
```

```bash
cd examples/notes
pnpm exec tvine show_urls
# pattern                   methods  name         action
# /api/notes/               GET      notes:notes  notes.list
# /api/notes/<int:id>/pin/  POST     notes:pin    notes.pin
```

| API | Meaning |
|---|---|
| `path(route, view, { name?, methods? })` | view = an action, `View.action('x')`, a View class, or `include(...)`. No leading `/` |
| `re_path(regex, view, opts)` | regex route; not reversible |
| `include('app.urls' \| 'tvine.auth.urls' \| patterns, { namespace? })` | namespace defaults to the module's `appName` |
| `reverse('notes:pin', { id: 1 })` | builds a URL; throws `NoReverseMatch` |
| `SimpleRouter` / `DefaultRouter().register('products', View)` | DRF routers: `list`/`create` on `products/`, `get`/`update`/`delete` on `products/<id>/` |

Converters: `int`, `str`, `slug`, `uuid`, `path`. Built-in includes: `tvine.auth.urls`, `tvine.tasks.urls`.
Methods: `GET` for read actions, else `POST`; a wrong method gets `405`. Depth: [urls.md](design/conventions/urls.md).

## The `api.*` client

Pages never import models. They call actions through `api.<app>.<name>` from `@tvine/weft/api`. The same code
works in server and client components.

```tsx
import { api, must } from '@tvine/weft/api'

const page = must(await api.catalog.list({ category: 'hats', sort: '-price' }))     // server component
const p    = must(await api.catalog.get({ id }), { notFound: true })                 // not found → 404 page

// client component: never throws, returns { ok, data } or { ok: false, code, message, field, errors }
const r = await api.catalog.addToCart({ id: 12, qty: 1 })
if (!r.ok) setError(r.field, r.message)
```

- Server components call `dispatch()` in-process (no network). Client components `POST /tvine/api/<id>`.
- Two-server mode (`tvine start --api-only` + a separate Next server): set `TVINE_API_URL` and `TVINE_SECRET`.
- `must(r)` throws `ApiError`; `must(r, { notFound: true })` turns `not_found` into Next's 404.
- Error codes: `invalid_param`, `unknown_action`, `stale_bind`, `expired_sid`, `rate_limited`, `conflict`,
  `domain` (+ `reason`), `human_only`, `confirm_required`, `internal`.

Types come from `tvine generate`, which writes `tvine-api.d.ts` (type queries only, no codegen at runtime):

```bash
pnpm exec tvine generate            # → wrote tvine-api.d.ts
pnpm exec tvine generate --check    # exit 1 when the file is stale (use in CI)
```

`tvine dev` regenerates it on save. Depth: [api-client.md](design/frontend/v2/core/api-client.md).

### Calling `/tvine/api` by hand

The body is `{ "params": { ... } }`, and the request needs `x-tvine-api: 1` and a same-site `Origin`:

```bash
curl -s -X POST http://localhost:3000/tvine/api/catalog.list \
  -H 'x-tvine-api: 1' -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"params":{"category":"hats","sort":"-price"}}'
# {"ok":true,"data":{"items":[{"id":...,"category":"hats",...}],...}}
```

## CLI

| Command | What it does |
|---|---|
| `tvine check` | settings, actions, migrations, and the frontend/backend import boundary |
| `tvine show_urls` | every `urls.ts` route: pattern, methods, name, action |
| `tvine generate [--check]` | write (or check) `tvine-api.d.ts` |

All commands: [cli.md](cli.md).

## Gotchas

- **`/tvine/api` params go under `params`.** Top-level keys like `{"category":"hats"}` are ignored, so you get
  an unfiltered list, not an error.
- **No `x-tvine-api: 1` or a cross-site `Origin` → 403.** That is the CSRF guard; browsers send it via `api.*`.
- **`/tvine/api` counts as a human request**, even with `x-tvine: 1`. `humanOnly` does not stop it there;
  protect with permissions.
- **Renders may only call read actions.** A mutating action during a server render returns
  `domain` / `render_mutation`. Mutate from forms, server actions or client events.
- **Call `router.refresh()` yourself** after a client-side mutation; it is not automatic.
- **Pages must not import models.** `tvine check` follows imports transitively and fails with a fix hint.
  `import type` is allowed. `settings.frontend.boundary: 'warn'` downgrades it while migrating.
- **Stale types.** After changing views, run `tvine generate` (or use `tvine dev`). In the demo,
  `tvine generate --check` currently reports the file as stale.
- **Duplicate names.** When two view classes in one app generate the same action name, the id becomes
  `<app>.<ClassName>.<name>`.
