# Actions (`defineAction`)

An action is one named backend function with a zod schema for its params. You export it from
`apps/<app>/views.ts`; at boot Warp discovers it and gives it the id `<app>.<name>`. From then on the same
action answers everywhere: the typed `api.<app>.<name>()` client in your pages, `POST /tvine/api/<app>.<name>`,
an agent's `POST` to a page, the MCP `do` tool and its own typed MCP tool, and any `urls.ts` path you map to it.
Every caller goes through one pipeline (`core/dispatch.ts`): origin check, rate limits, session, `humanOnly`,
permissions, bind, rev, action middleware, validation, `confirm`, the handler in one DB transaction, commit.

**Import:** `import { defineAction, DomainError, type ActionCtx, type ActionRules } from 'tvine'`

## Signature

```ts
function defineAction<S extends z.ZodType, R = unknown>(
  name: string,
  schema: S,
  run: (params: z.infer<S>, ctx: ActionCtx) => Promise<R>,
  rules?: ActionRules,
): ActionDef<S> & { run(params: z.infer<S>, ctx: ActionCtx): Promise<R> }
```

| Argument | Type | Meaning |
|---|---|---|
| `name` | `string` | Bare name (`'addToCart'`) or already qualified with its own app (`'cart.addToCart'`). A dotted name must start with the app folder's name, or boot fails. |
| `schema` | zod schema | The params. Use `z.object({...})`: only an object schema gets advertised params (MCP tool input, snapshot param specs). |
| `run` | `async (params, ctx) => result` | The handler. `params` is the parsed zod output (defaults filled, unknown keys stripped unless the schema is `.strict()`). The return value is the result. |
| `rules` | `ActionRules` | Optional. Every key below. |

The returned object is the action definition. After discovery its `id` property holds the final id
(`'cart.addToCart'`), so `import { addToCart } from './views.ts'` sees the qualified id.

## Ids

| Rule | Detail |
|---|---|
| Id form | `<app>.<name>`. `<app>` is the folder under `apps/` and must match `/^[a-z][a-z0-9_]*$/`. |
| Where they are found | Every export of `apps/<app>/views.ts` (or `.js` / `.mjs`; two of them side by side is a boot error) that is an action def or a View class. |
| Duplicates | Two actions with the same id fail at boot (`duplicate id cart.addToCart`), naming the file and export. |
| Reserved | The app name `weft` is reserved for framework built-ins. |
| Same name in two apps | Works on the server. A page bundle that resolves the id by bare name throws "defined by several apps"; give it the qualified name: `defineAction('cart.add', …)`. |
| Installed apps | Project apps come from `apps/`; built-ins (`tvine.auth`, …) register under their label (`auth.login`). See [settings.md](./settings.md) `installedApps`. |

## The handler context (`ActionCtx`)

```ts
interface ActionCtx {
  request: Request        // path, query, headers, ip, user, agent, locale, files, raw — see request.md
  session: Session        // { sid, rev, data: Map<string, unknown>, createdAt, lastSeen }
  sid: Sid                // same as session.sid
  settings: Settings      // the validated settings
  channels: ChannelLayer  // pub/sub; sends are held until commit, dropped on rollback
}
```

| Field | What you use it for |
|---|---|
| `ctx.request.user` | The signed-in user, always present (`ANONYMOUS` = `{ isAuthenticated: false, isAnonymous: true }`). |
| `ctx.request.agent` | `{ is, via, client?, verified? }`: is an AI agent calling? See [request.md](./request.md). |
| `ctx.request.ip` | Client IP, derived with `settings.trustProxy`. |
| `ctx.session.data` | Per-session state (a cart). The handler gets a deep copy; it is saved only if the action succeeds. |
| `ctx.channels.group(name).send(event)` | Push an event to a group; delivered after commit only. |
| `ctx.settings` | Read settings at run time. |

`currentAction()` (in `core/dispatch.ts`, not exported from `tvine`) returns the running `ActionCtx`; it is used
internally by `tvine.tasks`. Not covered as public API.

Class-view methods get a `ViewCtx` instead: the same fields plus `action`, `actionId`, `params`. See [views.md](./views.md).

## Return values

| Handler does | Caller gets |
|---|---|
| returns a value | `ok` with that value as the result. Over `api.*` / `/tvine/api`: `{ ok: true, data }` (JSON round-tripped: a `Date` becomes a string, `undefined` becomes `null`). |
| returns nothing | `{ ok: true, data: null }` |
| throws `DomainError(code, message, field?)` | `err` with code `domain` and `reason: code` (except codes `invalid_param`, `internal`, `human_only`, which keep their own code). See [errors.md](./errors.md). |
| throws Next's `redirect('/orders/42')` | `goto` to that path (the action still commits). The target must be http(s), this site's host, and a routed page; else `domain` / `forbidden`. `api.*` returns `{ ok: true, data: null, goto: '/orders/42' }`. |
| throws anything else | `internal` ("internal error"), logged on `tvine`; the transaction rolls back. |
| runs longer than `settings.limits.handlerMs` (10 s) | `internal` ("handler timeout"); the transaction is aborted. |

## Rules (`ActionRules`)

The fourth argument. Every key:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `readOnly` | `boolean` | `false` | A read. No DB transaction, no session `rev` bump. Allowed while a page renders (`api.*` in a server component); reachable by `GET` in `urls.ts`; MCP `readOnlyHint`; token scope `read` covers it; required by `cache`. |
| `destructive` | `boolean` | `false` | MCP `destructiveHint` (ignored when `readOnly`). The typed tool description says "(destructive)". |
| `permissions` | `Permission[]` | `[]` | Checked before params are validated. First deny wins; a throwing permission is a deny. Merged: `apps/<app>/rules.ts` permissions first, then the action's. Built-ins: `allowAny`, `denyAgents`, `isAuthenticated`, `isStaff`, `isSuperuser`, `hasPerm(...)`, `modelPermissions(Model)`, `allOf`, `anyOf`, `loginRequired`, `permissionRequired`, `userPassesTest`, `staffMemberRequired` (see [contrib/auth.md](./contrib/auth.md)). Denied → `domain` / `forbidden`. |
| `rate` | `{ limit: number; windowMs: number }` | `settings.limits.rate` (60 / 60 s) | The action's own bucket, keyed by session + action id. `limit >= 1`, `windowMs > 0`, else boot error. Over it → `rate_limited` + `retryAfterMs`. |
| `mcp` | `boolean` | `true` (unless matched by `settings.mcp.exclude`) | `false`: no typed MCP tool, refused by the MCP `do` tool (answers `unknown_action`), hidden from MCP snapshots. Other transports still work. |
| `priority` | `boolean` | `false` | Kept when the typed MCP tool list is trimmed to `settings.mcp.maxTools`. |
| `humanOnly` | `true \| string` | unset | Every agent-marked request gets `human_only` (HTTP 403), before replay and permissions. The string is shown in the message. No typed MCP tool. A human's own request runs it. |
| `confirm` | `true \| { message?, by? } \| (params, ctx) => rule \| undefined` | unset | Two-step call. First call runs nothing and returns `confirm_required` with a signed, single-use token (bound to sid + action + params, valid 120 s). Same call again with `params.$confirm = token` runs it. `message`: a string or `(params, ctx) => string` (default `Confirm <id>?`). `by: 'human'`: an agent never gets a token and cannot confirm. A function decides per call. |
| `bind` | `string[]` | `[]` | Params that may only come from the server-signed `bind` token of an action ref (never from the caller). With `bind` set, a call without a bind → `stale_bind`; sending one of these keys as a param → `invalid_param`. Each key must be a param of the schema (boot error otherwise). Not advertised as params or MCP inputs. |
| `atomic` | `boolean` | `true` | `false` opts out of the per-action DB transaction (`settings.db.atomicRequests`). |
| `cache` | `{ timeout: number; varyOn?: string[]; cache?: string; tags?: string[] }` | unset | Django `cache_page` for the result. Needs `readOnly` (boot error otherwise), `timeout` in seconds > 0, not with `secretResult`. `varyOn` default `['user']`; add `'session'`, `'query'` or a header name. `cache`: the `settings.caches` alias. `tags`: dropped by `cache.invalidateTags([...])`. Errors are never cached. |
| `secretResult` | `boolean` | `false` | The result is a one-time secret (a new API token): blanked as `[redacted]` in hook payloads. Not allowed with `cache`. |
| `audit` | `boolean` | `true` | `false`: never write a `tvine.audit` row for this action (when `settings.audit.enabled`). |
| `search` | `string` | unset | Names the param that is a visitor's search term (admin "Top searches"). Generated `list` actions set `'q'` when the view has search fields. |
| `anonymous` | `boolean` | — | Declared in the type ("default true in v1"); nothing reads it in this release. |
| `humanAttention` | `true \| string` | — | Reserved placeholder; no behaviour on the server. |

### Where rules come from (precedence)

`settings.limits.rate` < the def's own defaults (e.g. `defineUpload`'s 5/min) < `apps/<app>/rules.ts` < the
action's `rules`. `apps/<app>/rules.ts` may export only `rate`, `mcp` and `permissions`; permissions add up
(app first), the others are overridden by the action.

```ts
// apps/orders/rules.ts — applies to every action of the orders app
import { isAuthenticated } from 'tvine'
export const permissions = [isAuthenticated]
export const rate = { limit: 30, windowMs: 60_000 }
```

## How one action is reachable

| Caller | How | Notes |
|---|---|---|
| Page (server component) | `await api.cart.addToCart({ productId: 7, qty: 1 })` from `tvine/api` | In-process. During a render only `readOnly` actions run (`domain` / `render_mutation` otherwise). |
| Page (client component) | same call | `POST /tvine/api/cart.addToCart` with the session cookie. |
| Any HTTP client | `POST /tvine/api/cart.addToCart`, body `{ "params": {...}, "bind"?, "cmdId"? }`, header `x-tvine-api: 1` | Same-origin (or `settings.cors`). See [request.md](./request.md). |
| Agent over HTTP | `POST <page url>` with header `x-tvine: 1`, body `{ "action": "cart.addToCart", "params": {...}, "sid": "...", "bind"?, "cmdId"?, "rev"? }` | Reply is a snapshot envelope (json / notation). |
| MCP | typed tool `cart_addToCart` (dots → `_`) with the params plus `url`, `sid`, `cmdId`, `bind`; or `do` with `{ url, action, params, sid }` | Server at `POST /mcp`. |
| REST | a `urls.ts` route: `path('api/cart/add/', addToCart)` | See [urls.md](./urls.md). |

### The typed `api.*` client

`api` is a proxy: `api.<app>.<name>(params?, opts?)` calls id `<app>.<name>` and **never throws**; it returns

```ts
type ApiResult<T> =
  | { ok: true; data: T; goto?: string }
  | { ok: false; code: ErrCode; reason?: string; field?: string; errors?: FieldError[];
      message: string; retryAfterMs?: number; confirm?: ConfirmAsk }
```

`opts`: `{ cmdId?: string; bind?: string; signal?: AbortSignal }`. `must(r)` returns `data` or throws
`ApiError`; `must(r, { notFound: true })` turns `reason: 'not_found'` into Next's 404. In the browser a
`confirm_required` answer shows a confirm dialog and resends with the token (agents get the result instead).

Types: `tvine generate` writes `tvine-api.d.ts`, which types each call from the action's zod input
(`z.input`) and the handler's return type (`ActionIn` / `ActionOut` from `tvine/types`). `tvine dev`
regenerates it on save; `tvine generate --check` fails when it is stale.

### MCP tool details

| Point | Detail |
|---|---|
| Name | id with `.` replaced by `_` (`catalog.list` → `catalog_list`). |
| Input schema | The zod schema as JSON Schema, minus `bind` keys, plus `url`, `sid`, `cmdId`, `bind`. Skipped (warning, still reachable by `do`) when the schema is not an object, a param is named `url`/`sid`/`cmdId`/`bind`, or the name is taken. |
| Hints | `readOnlyHint` = `readOnly`; `destructiveHint` = `destructive && !readOnly`. |
| Hidden | `mcp: false`, `settings.mcp.exclude` globs (`*` one segment, `**` any depth), `humanOnly`, or a permission list containing `isStaff`, `isSuperuser` or `denyAgents`. Hidden typed tools are still enforced on every path. |
| Mode | `settings.mcp.tools`: `'both'` (default; 6 generic tools + typed), `'generic'`, `'typed'`. |
| Trim | Over `settings.mcp.maxTools` (40), typed tools are cut to `priority` ones; the rest work through `do`. |

## Idempotency, rev, bind

| Field (command) | Meaning |
|---|---|
| `cmdId` | Idempotency key. A retry with the same `cmdId` and same params replays the first result, never runs twice. Same `cmdId`, different params → `conflict`. `/tvine/api`: body `cmdId`; `urls.ts`: header `Idempotency-Key`. Ignored on throwaway sessions (anonymous reads). |
| `rev` | Optimistic concurrency: if given and not the session's current rev → `stale_rev` + fresh snapshot. |
| `bind` | Opaque HMAC-signed context from an action ref. Must be valid and issued for this action, else `stale_bind`. Its values are merged over the params. |

## Action middleware

Functions around the handler, for every action (`settings.actionMiddleware`) or one app's actions
(`apps/<app>/middleware.ts`, `export default [fn, ...]`). Global ones run first.

```ts
type Middleware = (cmd: Command, ctx: ActionCtx, next: () => AsyncIterable<Event>) => AsyncIterable<Event>
```

They run after the origin check, rate limits, session, `humanOnly`, permissions, bind and rev checks, and
before param validation, `confirm` and the handler. `cmd` is frozen. Yield your own `err` event to stop;
`yield* next()` to continue; `next()` at most once. Full detail: [middleware.md](./middleware.md#action-middleware).

## Examples

### 1. A cart action using the session

```ts
// apps/cart/views.ts
import { z } from 'zod'
import { defineAction, DomainError } from 'tvine'
import { Product } from '../catalog/models.ts'

export const addToCart = defineAction('addToCart',
  z.object({ productId: z.number().int(), qty: z.number().int().min(1).max(99) }),
  async ({ productId, qty }, ctx) => {
    const p = await Product.objects.filter({ id: productId }).first()
    if (!p) throw new DomainError('not_found', `product ${productId} not found`, 'productId')
    const cart = (ctx.session.data.get('cart') as Record<number, number> | undefined) ?? {}
    cart[productId] = (cart[productId] ?? 0) + qty
    ctx.session.data.set('cart', cart)
    return { lines: Object.keys(cart).length }
  },
  { rate: { limit: 20, windowMs: 60_000 } })          // → cart.addToCart, tool cart_addToCart
```

### 2. A cached read

```ts
export const featured = defineAction('featured', z.object({ limit: z.number().int().max(20).default(8) }),
  async ({ limit }) => Product.objects.filter({ featured: true }).order('-createdAt').page({ size: limit }),
  { readOnly: true, cache: { timeout: 60, varyOn: [], tags: ['products'] } })   // one copy for everyone
```

### 3. A confirmed, human-only refund

```ts
import { isStaff } from 'tvine'

export const refund = defineAction('refund', z.object({ orderId: z.number().int() }),
  async ({ orderId }) => { /* ... */ return { refunded: orderId } },
  { permissions: [isStaff], destructive: true,
    confirm: { message: (p) => `Refund order ${p.orderId}?`, by: 'human' } })
```

### 4. Calling it from a page

```tsx
import { api, must } from 'tvine/api'

const r = await api.cart.addToCart({ productId: 7, qty: 2 })
if (!r.ok) setError(r.field ?? 'form', r.message)        // client component: never throws
const items = must(await api.catalog.featured({}))         // server component: data or ApiError
```

### 5. Redirect after placing an order

```ts
import { redirect } from 'next/navigation'

export const place = defineAction('place', z.object({}), async (_p, ctx) => {
  const order = await createOrderFromCart(ctx)              // your code
  ctx.session.data.delete('cart')
  redirect(`/orders/${order.id}`)                           // → goto; must be a routed page of this site
})
```

## Gotchas

- `/tvine/api` params go under `params`. Top-level keys are ignored.
- A page render may only call `readOnly` actions; a write during render returns `domain` / `render_mutation`.
- `ctx.session.data` writes are applied only when the action succeeds. Writes made by middleware after `next()`
  returned are outside the commit.
- `confirm` is opt-in per action; `$confirm` is stripped from params before your handler and never validated.
- Rules on an action override `rules.ts` for `rate` and `mcp`; `permissions` always add up.
- A permission is checked before params are validated, so it cannot read validated params.
- `bind` keys must be in the schema, or boot fails.
- `rules.cache` without `readOnly` is a boot error.
- `humanOnly` cannot be overridden by any rule, permission or hook.

## See also

[views.md](./views.md) · [errors.md](./errors.md) · [request.md](./request.md) · [middleware.md](./middleware.md) ·
[urls.md](./urls.md) · [serializers.md](./serializers.md) · [settings.md](./settings.md) · [contrib/auth.md](./contrib/auth.md) ·
[overview.md](./overview.md)
