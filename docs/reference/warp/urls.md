# URLs (`urls.ts`, `path`, `include`, `reverse`)

`urls.ts` is Django's URLconf for REST-style paths. It is optional: without it every action still answers at
`POST /tvine/api/<app>.<name>`. Each route maps a URL pattern (and HTTP methods) to an action that discovery
already registered; a matched request runs that action exactly as `POST /tvine/api/<id>` does (same caller
check, permissions, rate limits, idempotency, `humanOnly`, origin / CORS, same JSON result). Pages are not routed
here: pages are your Next.js `app/` folder, and Warp reads that route table itself.

**Import:** `import { path, re_path, include, reverse, SimpleRouter, DefaultRouter, NoReverseMatch, ImproperlyConfigured } from 'tvine'`

## Where the files are

| File | Role |
|---|---|
| `config/urls.ts`, else `urls.ts` (project root = the folder above `apps/`) | The root URLconf (Django `ROOT_URLCONF`). Exports `urlpatterns`. |
| `settings.rootUrlconf` | Another root, a path from the project root without extension (`'config/api_urls'`). Must exist, else boot error. |
| `apps/<app>/urls.ts` | An app's patterns, pulled in with `include('<app>.urls')`. Exports `urlpatterns` and optionally `appName` (the default namespace). |
| `include('tvine.auth.urls')` | A built-in app's patterns (`tvine.<label>.urls`), when that app is installed. |

`.ts`, `.js` or `.mjs`; two side by side is a boot error. Every problem fails at boot naming its file.

## `path`

```ts
function path(route: string, view: ActionDef | ViewClass | Include, opts?: { name?: string; methods?: string[] }): UrlEntry
```

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `route` | `string` | — | Django syntax: `'products/<int:id>/'`. No leading `/` (boot error). Matched against the decoded request path. |
| `view` | action def, `View.action('name')`, a View class, or `include(...)` | — | What runs. |
| `opts.name` | `string` | unset | URL name for `reverse`; prefixed by the namespaces (`'catalog:product-detail'`). |
| `opts.methods` | `string[]` | `['GET']` for a `readOnly` action, else `['POST']` | Methods for an action view. Ignored for a View class (it maps its own). |

A View class as `view` (Django `as_view()`): on a route **with** the view's `lookupParam` → `GET` get,
`PUT`/`PATCH` update, `DELETE` delete; on a route **without** it → `GET` list, `POST` create (whichever the class
generates). A route that maps no method fails at boot.

### Converters

| Converter | Matches | Value |
|---|---|---|
| `str` (default: `<name>`) | one segment, no `/` | string |
| `int` | 1–15 digits | number |
| `slug` | `[-a-zA-Z0-9_]+` | string |
| `uuid` | lowercase hex uuid | string |
| `path` | anything, including `/` | string |

Unknown converter or a parameter name that is not an identifier → `ImproperlyConfigured` at `path()` time.
Custom converters: Not covered (no registration API).

## `re_path`

```ts
function re_path(regex: string, view: ActionDef | ViewClass | Include, opts?: { name?: string; methods?: string[] }): UrlEntry
```

Python named groups `(?P<id>\d+)` are accepted; leading `^` and trailing `$` are stripped. Values arrive as
strings. `re_path` routes cannot be reversed.

## `include`

```ts
function include(module: string | UrlEntry[], opts?: { namespace?: string })
```

| Argument | Meaning |
|---|---|
| `module` | `'<app>.urls'` (an installed project app), `'tvine.<label>.urls'` (a built-in), or an array of patterns. |
| `opts.namespace` | Namespace for names inside; defaults to the module's `appName` export. Nested includes join with `:`. |

## `reverse`

```ts
function reverse(name: string, kwargs?: Record<string, string | number>, urls?: UrlTable): string
```

Returns the path (leading `/`) of the first route with that name whose parameters are exactly `kwargs` and whose
converters accept the values. Values are URL-encoded (`path` keeps its `/`). Uses the booted server's table, so
it works from page code once the server runs. Throws `NoReverseMatch` for an unknown name, an unknown namespace,
or kwargs that fit no pattern.

## Routers

`new SimpleRouter({ trailingSlash? }).register(prefix, ViewClass, { basename? }).urls` builds the DRF routes:
`<prefix>/` (list, create), `<prefix>/<id>/` (get, update, delete), and `@action` routes. Names are
`<basename>-list`, `<basename>-detail`, `<basename>-<action>`. Full table: [views.md](./views.md#routers).
`DefaultRouter` is the same as `SimpleRouter` (no API root view).

## How a request on a route is handled

| Step | Rule |
|---|---|
| Match | Path decoded, then every route tested; the first route that has the request's method wins. Path matched but method not → `405` with `Allow`. `HEAD` = `GET`. |
| Caller | Must send `x-tvine-api: 1` (browsers / HTTP clients) or a valid signed `x-tvine-forward` (a Next server in two-server mode). Else `403`. |
| Params (GET) | The query string; repeated keys become arrays; numbers / booleans coerced by the action's schema. |
| Params (other methods) | The JSON body (an object, `Content-Type: application/json`, max `settings.limits.bodyBytes`, else `413`). Empty body = `{}`. |
| Path params | Merged in; a body / query value that differs from the URL value → `400 invalid_param` ("the URL says …"). |
| Headers | `x-tvine-bind` → bind; `Idempotency-Key` → cmdId. |
| Run | `invoke()` → `dispatch()`: same as `/tvine/api`. |
| Reply | JSON `ApiResult` (`{ ok: true, data }` or `{ ok: false, code, … }`), `cache-control: private, no-store`. `201` for a generated `create`. Error statuses: [errors.md](./errors.md#http-status-codes). |

Boot checks: `GET` mapped to a non-`readOnly` action → error ("GET only reaches readOnly actions"); the same
method + pattern routed twice → error; one name on two different patterns → error.

## Page routes vs API routes

| | Page routes | `urls.ts` routes | `/tvine/api/<id>` |
|---|---|---|---|
| Defined by | Next `app/**/page.tsx` | `urlpatterns` | every action, always |
| Human GET | Next renders HTML | JSON | — (POST only) |
| Agent | `x-tvine: 1` GET → snapshot, POST → command | same JSON | same JSON |
| Guards | `settings.guards` by page path | the caller's page is the Referer path | same |

`tvine show_urls` prints every `urls.ts` route: pattern, methods, name, action.

## Examples

### 1. Root URLconf with an app include

```ts
// config/urls.ts
import { include, path } from 'tvine'
export const urlpatterns = [
  path('api/', include('catalog.urls')),
  path('api/auth/', include('tvine.auth.urls')),
]
```

### 2. App patterns: function action, view class, `@action`

```ts
// apps/catalog/urls.ts
import { path } from 'tvine'
import { featured, ProductDetail, ProductList } from './views.ts'

export const appName = 'catalog'
export const urlpatterns = [
  path('products/', ProductList, { name: 'product-list' }),                       // GET → catalog.list
  path('products/<int:id>/', ProductDetail, { name: 'product-detail' }),          // GET → catalog.get
  path('products/<int:id>/add/', ProductDetail.action('addToCart'), { name: 'add' }),   // POST
  path('featured/', featured, { name: 'featured' }),                              // GET (readOnly)
]
```

```bash
curl -s http://localhost:3000/api/products/?category=hats -H 'x-tvine-api: 1'
# {"ok":true,"data":{"items":[...],"pageSize":25}}
curl -s -X POST http://localhost:3000/api/products/7/add/ -H 'x-tvine-api: 1' \
  -H 'content-type: application/json' -H 'Idempotency-Key: k-123' -d '{"qty":2}'
```

### 3. Reverse a URL

```ts
import { reverse } from 'tvine'
reverse('catalog:product-detail', { id: 7 })   // '/api/products/7/'
```

### 4. Router

```ts
// apps/orders/urls.ts
import { SimpleRouter } from 'tvine'
import { OrderViewSet } from './views.ts'
export const appName = 'orders'
export const urlpatterns = new SimpleRouter().register('orders', OrderViewSet).urls
// /orders/ GET POST (orders:order-list), /orders/<int:id>/ GET PUT PATCH DELETE (orders:order-detail)
```

## Gotchas

- No leading `/` in a route: `path('/api/', …)` fails at boot.
- `urls.ts` calls need `x-tvine-api: 1` just like `/tvine/api`; without it every call is `403`.
- `GET` reaches only `readOnly` actions. Use `methods: ['POST']` for writes.
- Path values win only if the body agrees; sending a different `id` in the body is a `400`.
- `include('x.urls')` needs `x` in `apps/` (or installed) and an `apps/x/urls.ts`.
- `re_path` routes are not reversible.
- Routes are read once at boot; a change needs a restart (`tvine dev` reloads).

## See also

[views.md](./views.md) · [actions.md](./actions.md) · [errors.md](./errors.md) · [request.md](./request.md) ·
[settings.md](./settings.md) · [overview.md](./overview.md)
