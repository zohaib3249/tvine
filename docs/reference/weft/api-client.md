# The `api.*` client

## What it is

`tvine/api` is the frontend's only data path. `api.<app>.<name>(params)` calls the backend action whose id
is `<app>.<name>` (a function view, an `@action` method, or a ListView's generated `list` / `get` /
`create` / `update` / `delete`). It never throws: it returns an `ApiResult`. The same import works in
server components (in-process dispatch, or signed HTTP to a separate API server) and in client components
(a same-origin POST with the session cookie). Types come from a generated `tvine-api.d.ts`.

## Import

```ts
import { api, must, ApiError, currentUser, UserProvider, useUser,
         type ApiResult, type ApiCall, type ApiOpts, type ErrCode, type FieldError, type CurrentUser } from 'tvine/api'
```

`tvine/api` resolves by condition: the `react-server` build (server components, server actions) is
`server-only`; every other bundle gets the browser build. Same names in both.

## Calling an action

```ts
interface ApiCall<P = Record<string, unknown>, R = unknown> {
  (params?: P, opts?: ApiOpts): Promise<ApiResult<R>>
  readonly id: string                          // e.g. 'shop.addToCart'
}
interface ApiOpts { cmdId?: string; bind?: string; signal?: AbortSignal }

type ApiResult<T = unknown> =
  | { ok: true; data: T; goto?: string }
  | { ok: false; code: ErrCode; reason?: string; field?: string; errors?: FieldError[]; message: string; retryAfterMs?: number; confirm?: ConfirmAsk }

interface FieldError { field: string; code?: string; message: string }
```

| `ApiOpts` | Meaning |
|---|---|
| `cmdId` | Idempotency key: a retry with the same `cmdId` does not run the action twice. |
| `bind` | A signed bind token (from a server-side `bindAction`) for actions with `rules.bind`. |
| `signal` | `AbortSignal` to cancel the request. |

| `ErrCode` | When |
|---|---|
| `invalid_param` | Bad params. `errors` lists every bad field; `field` is the first. |
| `unknown_action` | No such action id. |
| `stale_bind` | The bind token is wrong / expired. |
| `stale_rev` | The page changed since the agent read it. |
| `expired_sid` | Session gone. |
| `rate_limited` | Too many calls; `retryAfterMs` says when to retry. |
| `conflict` | A write conflict. |
| `domain` | Refused by the app; `reason` says why (e.g. `forbidden`, `not_found`). |
| `internal` | Server error, or `reason: 'network'` when the request did not reach the server. |
| `human_only` | The action has `rules.humanOnly` and the caller is an agent. |
| `confirm_required` | The action has `rules.confirm`; see "Confirm". |

### `must`

```ts
function must<T>(r: ApiResult<T>, o?: { notFound?: boolean }): T
```

Returns `r.data`, or throws `ApiError` (`code`, `reason`, `field`, `errors`, `message`). With
`{ notFound: true }`, a result with `reason: 'not_found'` throws Next's 404 instead (the page renders
`not-found.tsx`).

```ts
class ApiError extends Error { code: ErrCode; reason?: string; field?: string; errors?: FieldError[] }
```

## Server components

```tsx
// app/products/[id]/page.tsx
import { Page } from 'tvine/weft'
import { api, must } from 'tvine/api'

type Product = { id: number; name: string; price: string; description: string }

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const p = must(await api.shop.get({ id: Number(id) }), { notFound: true }) as Product
  return (
    <Page name="product" title={p.name}>
      <h1>{p.name}</h1>
      <p>{p.price}</p>
      <p>{p.description}</p>
    </Page>
  )
}
```

How the server build reaches the backend:

| Setup | Transport |
|---|---|
| `tvine dev` / `tvine start` (one process) | In-process dispatch. No HTTP. |
| Frontend separate from a `tvine start --api-only` server | HTTP POST to `TVINE_API_URL` + `/tvine/api/<id>`, with the caller's session cookie, IP and agent flag in a signed `x-tvine-forward` header (HMAC with the first key of `TVINE_SECRET`, valid 30 s). A session cookie minted by the API server is set on the response. |
| Neither | Throws: `tvine/api: no backend. Run the app with tvine start/tvine dev …` |

Env used by the split mode: `TVINE_API_URL`, `TVINE_SECRET` (comma list; first signs),
`TVINE_COOKIE_NAME`, `TVINE_HEADER` (default `x-tvine`), `TVINE_TRUST_PROXY` (number of trusted proxy hops
for the client IP; else `unknown`), `TVINE_SESSION_SECURE`, `TVINE_SESSION_SAMESITE` (default `lax`),
`TVINE_SESSION_TTL_S` (default 86400). The cookie is `__Host-tvine_s` when secure (production by default),
else `tvine_s`.

## Client components

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { Button, toast } from 'tvine/widgets'
import { api } from 'tvine/api'

export function AddToCart({ productId }: { productId: number }) {
  const router = useRouter()
  return (
    <Button name="add" onClick={async () => {
      const r = await api.cart.add({ productId, qty: 1 })
      if (!r.ok) return toast({ title: r.message, kind: 'error' })
      toast({ title: 'Added to cart', kind: 'success' })
      router.refresh()                // re-render server components with the new cart
    }}>Add to cart</Button>
  )
}
```

The browser build POSTs `{ params, bind?, cmdId? }` as JSON to `/tvine/api/<id>` with
`credentials: 'same-origin'` and the header `x-tvine-api: 1` (which forces a CORS preflight from other
sites). The session cookie is httpOnly: no session id is ever readable from JS. A network failure returns
`{ ok: false, code: 'internal', reason: 'network', message }`.

## Generated types: `tvine-api.d.ts`

```bash
tvine generate            # write tvine-api.d.ts in the project root
tvine generate --check    # exit 1 when it is stale (CI)
```

`tvine dev` regenerates it on every change to `apps/*/views` / serializers. The file is type queries only
(`typeof import('./apps/shop/views.js')`), so it never pulls models into the frontend bundle:

```ts
// generated by tvine generate — do not edit
import type { ApiCall } from 'tvine/api'
import type { ActionIn, ActionOut, ViewIn, ViewOut } from 'tvine/types'
type Shop = typeof import('./apps/shop/views.js')
declare module 'tvine/api' {
  interface ApiManifest {
    shop: {
      "addToCart": ApiCall<ActionIn<Shop["addToCart"]>, ActionOut<Shop["addToCart"]>>
      "list": ApiCall<ViewIn<Shop["Products"], "list">, ViewOut<Shop["Products"], "list">>
    }
  }
}
export {}
```

| Action kind | Params type | Result type |
|---|---|---|
| Function view (`defineAction`) | `z.input` of its schema | what `run` resolves to |
| `@action` method on a class view | the method's first param | what it resolves to |
| ListView `list` | `{ q?, sort?, cursor?, [filter]: unknown }` | `Paginated<Record<string, unknown>>` |
| ListView `get` / `create` / `update` | `Record<string, unknown>` | `Record<string, unknown>` |
| ListView `delete` | `Record<string, unknown>` | `null` |

When the same action name is used by several view classes in one app, the key becomes `<Class>.<name>`.
List rows are untyped: cast them (`must(await api.shop.list({})).items as Product[]`). Values are JSON on
the wire (a `Date` arrives as a string). Without the generated file, `api` is typed loosely as
`Record<string, Record<string, ApiCall>>`.

## Auth and session

```ts
currentUser(): Promise<CurrentUser | null>
interface CurrentUser { id: string; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }
function UserProvider(props: { user: CurrentUser | null; children?: ReactNode }): JSX.Element
function useUser(): CurrentUser | null
```

`currentUser()` calls `auth.me` through the same api path (never the ORM). `null` when signed out, when
`tvine.auth` is not installed, or on any error. On the server it is deduped per render (React `cache`).
Pass it to client components with `UserProvider`:

```tsx
// app/layout.tsx
import { WeftRoot } from 'tvine/weft'
import { currentUser, UserProvider } from 'tvine/api'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>
    <WeftRoot><UserProvider user={await currentUser()}>{children}</UserProvider></WeftRoot>
  </body></html>
}

// components/account-link.tsx
'use client'
import { useUser } from 'tvine/api'
export function AccountLink() {
  const user = useUser()
  return user ? <a href="/account">{user.username}</a> : <a href="/login">Sign in</a>
}
```

Sign-in / sign-out are ordinary actions (e.g. `api.auth.login(...)`, `api.auth.logout({})`), see
the `tvine.auth` app's actions in [../warp/actions.md](../warp/actions.md). Not covered here: their exact params.

## Confirm

When an action has `rules.confirm`, the first call returns `code: 'confirm_required'` with
`confirm: { token, message, summary, expiresIn, by: 'anyone' | 'human' }`. In the browser, `api.*`
handles it for a person: it asks (the `<WeftRoot>` dialog, else `window.confirm`), and on yes resends once
with `params.$confirm = token` and a new `cmdId` (`<cmdId>.c`). Cancel returns
`{ ok: false, code: 'confirm_required', reason: 'cancelled', message: 'Cancelled: nothing was done.' }`.
The server build never confirms on its own: it returns the `confirm_required` result.

```ts
setConfirmHandler(fn?: (ask: ConfirmAsk) => Promise<boolean>): void   // replace the dialog (undefined = default)
askConfirm(ask: ConfirmAsk): Promise<boolean>
confirmed(r, resend: (token) => Promise<R>): Promise<R>              // the ask-then-resend step, reusable
```

## Agent marking

The server always knows whether a call came from an agent:

| Call | Marked as |
|---|---|
| A person's click → `api.*` | human |
| A WebMCP agent's step runs a control whose handler calls `api.*` | agent (`via: 'webmcp'`): while a step runs, the browser build adds `agentCmd: { via }` to the body |
| A remote agent driving the tab, or the dev gallery's "try it as agent": the executor's own posts (a control bound to a server action, the `do` tool) | agent (`agentCmd: { via: 'channel' \| 'inspector' }`) |
| A remote agent driving the tab: `api.*` calls made by *your* handlers during its step | **agent** — the browser does not add the mark, but the server marks every request of the session as agent while a forwarded command runs (and a short time after), whatever the client sends (`asAgent` in warp `core/dispatch.ts`) |
| A server component rendered for an agent's snapshot | agent (split mode forwards the agent flag from `x-tvine` / the tvine `Accept` header) |

The marker is downgrade-only: page code can mark its own call as agent, never turn an agent call into a
human one. `rules.humanOnly`, `denyAgents` and `mcp: false` are enforced on the server for agent calls.

## Lower-level exports

| Export | Build | Meaning |
|---|---|---|
| `makeApi(transport)` | both | Build an `api` proxy over your own `Transport = (id, params, opts) => Promise<ApiResult>`. |
| `browserTransport` | browser | The default browser transport. |
| `agentVia()` | browser | The current agent mark (`'webmcp'`) while an agent step runs, else `undefined`. |
| `serverTransport`, `forwardTransport({ url, secret, cookieName?, header?, next? })`, `signForward(payload, secret, now?)` | server | The server transports and the forward header signer. |
| `network(e)` | both | The `internal/network` result for a caught error. |

## Gotchas

- `api.*` never throws (except the server build with no backend configured). Check `r.ok`, or use `must`.
- After a mutation in a client component, call `router.refresh()` yourself; `api.*` does not.
- `api.*` sends JSON only; for file uploads post `multipart/form-data` yourself (see [forms.md](forms.md#file-uploads)).
- Do not import `apps/**`, models or the ORM in frontend files; `tvine check` fails. `import type` is fine.
- During a remote-tab agent step the browser does not mark your handlers' `api.*` calls, but the server does: while a forwarded command runs in a tab of the session, every request of that session is an agent request, so `rules.humanOnly` still refuses them. (Per session, not per tab: a person acting in another tab of the same session at that moment is treated as agent too, which is stricter, never looser.)
- `currentUser()` returns `null` on any error, not only when signed out.
- `api` is a Proxy: `api.shop.foo` exists for any name; a wrong name fails at call time with `unknown_action` (types catch it once `tvine-api.d.ts` is generated).

## See also

- [forms.md](forms.md) — submitting forms, validation errors, uploads, confirm
- [agents-in-the-browser.md](agents-in-the-browser.md) — how agent calls reach the server
- [overview.md](overview.md) — the frontend boundary
- [../warp/actions.md](../warp/actions.md), [../warp/views.md](../warp/views.md) — defining the actions `api.*` calls
