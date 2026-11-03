# Errors

Every action call ends in exactly one outcome: `ok`, `goto`, or `err`. An `err` carries a fixed `code` (one of
eleven), a `message`, and optionally a `reason` (your `DomainError` code), the bad `field`, every bad field in
`errors[]`, `retryAfterMs`, or a `confirm` ask. Handlers report business failures by throwing `DomainError`;
Warp maps everything else (validation, permissions, limits, stale state, crashes) itself. The same `err` reaches
every caller: as an `ApiResult` for `api.*` / `/tvine/api` / `urls.ts`, as a snapshot envelope for agents over
HTTP, as an MCP tool result with `isError: true`. Agent-facing text also gets a fixed recovery hint.

**Import:** `import { DomainError, type ErrCode, type FieldError } from 'tvine'` (client side: `ApiError`, `must`
from `tvine/api`)

## `DomainError`

```ts
class DomainError extends Error {
  constructor(code: string, message: string, field?: string, errors?: FieldError[])
  code: string; field?: string; errors?: FieldError[]
}
interface FieldError { field: string; code?: string; message: string }
```

| Argument | Meaning |
|---|---|
| `code` | Your machine-readable reason (`'out_of_stock'`, `'not_found'`, `'forbidden'`). |
| `message` | Shown to the user / agent. Write it as the business rule. |
| `field` | The param at fault (forms highlight it). |
| `errors` | Several bad fields at once. |

How a thrown `DomainError` becomes an `err`:

| `code` you throw | `err.code` | `err.reason` | HTTP |
|---|---|---|---|
| `'invalid_param'` | `invalid_param` | `'invalid_param'` | 400 |
| `'internal'` | `internal` | `'internal'` | 500 |
| `'human_only'` | `human_only` | `'human_only'` | 403 |
| `'forbidden'` | `domain` | `'forbidden'` | 403 |
| `'not_found'` | `domain` | `'not_found'` | 404 |
| anything else | `domain` | your code | 400 |

Any other thrown error → `internal`, message `"internal error"` (details only in the `tvine` log). The
transaction rolls back in every error case.

## Error codes (`ErrCode`)

| Code | When | Recovery hint (appended for agents) |
|---|---|---|
| `invalid_param` | zod validation failed; unknown or read-only param; a `bind` key sent as a param; bad body / Content-Type; body too large (`reason: 'too_large'`) | fix the field named in the error to match the expected type; see the action spec in the snapshot |
| `unknown_action` | no action with that id (or MCP-disabled over MCP) | use one of the valid actions listed for this page |
| `stale_bind` | `bind` missing (action has `rules.bind`), invalid, expired, or issued for another action | re-read the page and use its fresh action refs |
| `stale_rev` | `rev` given and not the session's current rev (fresh snapshot attached) | state changed; a fresh snapshot is attached, retry against it |
| `expired_sid` | no session / unknown / expired / rotated sid (new sid + snapshot attached when one was created) | a new sid is in the attached snapshot envelope; use it from now on |
| `rate_limited` | a rate bucket is empty; a sid's queue is full; the session is busy on another server (`retryAfterMs` set) | retry after the delay shown |
| `conflict` | the same `cmdId` reused with different params | command already executed with different params; use a new cmdId for new params |
| `domain` | a `DomainError` with your code (in `reason`); permission denied / cross-origin / guarded route (`reason: 'forbidden'`) | the message above is the business rule; change the input or choose another option (forbidden: not allowed for this session; do not retry it, choose another page or action) |
| `internal` | uncaught error, handler timeout, middleware timeout, failed session rotation | server error; retry once, then re-read the page |
| `human_only` | an agent-marked request hit a `humanOnly` action, a `humanOnly` field, or a `confirm.by: 'human'` | only a human can do this; ask the user to do it themselves, do not retry |
| `confirm_required` | a `rules.confirm` action's first call: nothing ran | nothing ran: confirm as the message says (with the token), or ask the user when only they can confirm |

### Reasons you will see

| `reason` | Code | Meaning |
|---|---|---|
| `forbidden` | `domain` | Permission denied, token scope, cross-origin, guarded route, off-site redirect. |
| `not_found` | `domain` | A missing object (class views, your `DomainError('not_found')`). |
| `render_mutation` | `domain` | A non-`readOnly` action was called during a page render. |
| `too_large` | `invalid_param` / `domain` | Body or file over its limit. |
| `unsupported_type` | `domain` | Upload type not in `types`. |
| `confirm_required` | `confirm_required` | The first call of a confirmed action. |
| `confirm_invalid` | `domain` | Bad, expired, reused token, or params changed since the confirm. |
| `human_only` | `human_only` | See above. |
| `two_factor_required`, `reauth_required` | `domain` | A permission refused with these (kept as reason). |
| `cancelled` | `confirm_required` | Client side: the human pressed Cancel on the confirm dialog. |
| `network` | `internal` | Client side: `fetch` failed. |

## `confirm_required`

The first call of an action with `rules.confirm` runs nothing and answers:

```ts
{ ok: false, code: 'confirm_required', reason: 'confirm_required', message: 'Refund order 42? — …',
  confirm: { token?: string, message: string, summary: Record<string, unknown>, expiresIn: 120, by: 'anyone' | 'human' } }
```

Call again with the same params plus `$confirm: token` (in `params`) within 120 s, once. `summary` is the params
with secrets redacted and long values cut to 200 chars. With `by: 'human'` an agent gets no token, and an agent
sending one gets `human_only`. In the browser, `api.*` shows a dialog and resends automatically.

## `goto` (redirects)

| Where | What happens |
|---|---|
| Handler calls Next's `redirect(url)` | The action commits, the outcome is `goto`. The URL must be http(s), on this site's host, and a routed page; else `domain` / `forbidden` (and a rollback). A non-URL target is `internal`. |
| An agent reads a page whose render redirects | The agent gets `goto <url>` instead of a snapshot. |
| `api.*` | `{ ok: true, data, goto }`. |

## Not found

| Where | Do |
|---|---|
| In an action | `throw new DomainError('not_found', 'product 7 not found', 'id')` → 404 on `/tvine/api`. |
| In a page | Next's `notFound()`. For an agent this becomes `domain` / `not_found` (HTTP 404). |
| From `api.*` in a page | `must(await api.catalog.get({ id }), { notFound: true })` throws Next's 404 for `reason: 'not_found'`. |
| Class view helper | `await ProductDetail.object(id)` returns `undefined` for not found / forbidden. |

## Field errors

Validation lists every bad field:

```json
{ "ok": false, "code": "invalid_param", "field": "qty",
  "message": "qty: Number must be greater than or equal to 1; color: Required",
  "errors": [ { "field": "qty", "code": "too_small", "message": "Number must be greater than or equal to 1" },
              { "field": "color", "code": "invalid_type", "message": "Required" } ] }
```

`field` is the first bad field. Nested paths are put in the message (`"address: city: Required"`). Unknown keys
get code `unknown`, read-only ones `read_only`. The human `<Form>` turns them into `{ [field]: message }`.

## HTTP status codes

| Code | `/tvine/api`, `urls.ts` | Agent HTTP (page URL) |
|---|---|---|
| ok | 200 (201 for a generated `create` via `urls.ts`) | 200 (304 on `If-None-Match` for GET) |
| `invalid_param` | 400 (413 body too large) | 400 (413 body too large) |
| `unknown_action` | 404 | 400 |
| `stale_bind`, `stale_rev`, `conflict`, `confirm_required` | 400 | 400 |
| `expired_sid` | 401 | 401 |
| `rate_limited` | 429 (`retryAfterMs` in the body) | 429 + `Retry-After` header |
| `domain` | 403 (`forbidden`), 404 (`not_found`), else 400 | same |
| `human_only` | 403 | 403 |
| `internal` | 500 | 500 |
| no `x-tvine-api: 1` / bad forward | 403 (`domain`, `forbidden`) | — |
| wrong method | 405 + `Allow` | humans' requests pass to Next |
| not a page | — | 404 (`domain`) |

HTTP middleware answers with plain text: 400 (bad host), 403 (IpFilter, BotGuard), 413, 429, 503 (Maintenance,
Timeout).

## Over MCP

A tool result is `{ content: [{ type: 'text', text }], isError: true }` for any `err`. The text is the rendered
envelope (`settings.formats.default`: JSON or notation) including the recovery hint and, for
`confirm_required`, the token. A thrown error inside a tool is never passed through as a JSON-RPC error; it
becomes `internal`. Tab-control errors carry reasons like `awaiting_approval`, `not_connected`, `human_denied`,
`busy`, `timeout`, `tab_closed`.

## On the client (`tvine/api`)

`api.*` never throws; check `r.ok`. `must(r)` returns `r.data` or throws `ApiError` (`code`, `reason`, `field`,
`errors`, `message`).

## Examples

### 1. A business rule

```ts
export const place = defineAction('place', z.object({ productId: z.number().int(), qty: z.number().int().min(1) }),
  async ({ productId, qty }) => {
    const p = await Product.objects.filter({ id: productId }).first()
    if (!p) throw new DomainError('not_found', `product ${productId} not found`, 'productId')
    if (p.stock < qty) throw new DomainError('out_of_stock', `only ${p.stock} left`, 'qty')
    // …
  })
// → { ok: false, code: 'domain', reason: 'out_of_stock', field: 'qty', message: 'only 2 left' }  (HTTP 400)
```

### 2. Several field errors at once

```ts
throw new DomainError('invalid_param', 'address is incomplete', 'zip', [
  { field: 'zip', message: 'unknown zip code' },
  { field: 'city', message: 'does not match the zip' },
])
```

### 3. Handling results in a client component

```tsx
const r = await api.orders.place({ productId: 7, qty: 3 })
if (r.ok) router.push(r.goto ?? '/orders')
else if (r.code === 'rate_limited') setError(`Try again in ${Math.ceil((r.retryAfterMs ?? 1000) / 1000)} s`)
else if (r.reason === 'out_of_stock') setError(r.message)
else for (const e of r.errors ?? []) setFieldError(e.field, e.message)
```

### 4. Object permission denial in a view

```ts
async checkObjectPermissions(ctx, order) {
  if (order.customer !== ctx.request.user.id) throw new DomainError('forbidden', 'not your order')   // 403
}
```

## Gotchas

- Only `invalid_param`, `internal` and `human_only` keep their own code; every other `DomainError` code becomes
  `domain` with your code in `reason`. Switch on `reason`, not `code`, for business errors.
- An uncaught error's message is never sent to the caller; look in the `tvine` log.
- After a commit nothing is reported as a failure (a failing middleware or hook after commit is only logged), so
  a retry with the same `cmdId` gets the stored result.
- `unknown_action` is 404 on `/tvine/api` but 400 on the agent page transport.
- `rate_limited` on `/tvine/api` has no `Retry-After` header; read `retryAfterMs`.
- A redirect to another host is refused (`forbidden`), even from your own handler.

## See also

[actions.md](./actions.md) · [request.md](./request.md) · [views.md](./views.md) · [urls.md](./urls.md) ·
[middleware.md](./middleware.md) · [overview.md](./overview.md)
