# Request, sessions, agents and uploads

Every action call gets one `Request` object (`ctx.request`), built by the transport that received the call:
the HTTP page transport, `/tvine/api`, a `urls.ts` route, MCP, the in-process `api.*` of a server component, or
the human `<Form>` path. It is read-only data about the caller: path, query, headers, IP, user, whether an AI
agent is calling, locale, uploaded files. Next to it sits the `Session` (`ctx.session`): Warp's own per-visitor
state, found by a sid (agents) or a cookie (browsers). This page also covers how agents are detected and how
file uploads work.

**Import:** `import { currentRequest, currentSession, cycleSession, defineUpload, media, ANONYMOUS, type Request, type Session, type TvineUser, type UploadedFile } from 'tvine'`

## `Request`

```ts
interface Request {
  method: 'GET' | 'POST'
  path: string
  route: string
  params: Record<string, string>
  query: URLSearchParams
  headers: ReadonlyHeaders          // get(name): string | null
  ip: string
  id: string
  locale?: string
  agent: { is: boolean; via: 'http' | 'mcp' | 'webmcp' | 'channel' | 'inspector' | 'human'; client?: string;
           verified?: { directory: string; keyid: string } }
  files: UploadedFile[]
  user: TvineUser
  raw?: IncomingMessage
}
```

| Field | Type | Meaning |
|---|---|---|
| `method` | `'GET' \| 'POST'` | `GET` only for an HTTP `GET`; everything else (POST, MCP, `/tvine/api`, in-process) is `POST`. |
| `path` | `string` | The page path. For `/tvine/api` and `urls.ts` calls from a browser it is the **calling page** (the `Referer` path, `/` if none), not the API URL. |
| `route` | `string` | The Next route pattern of `path` (`'/product/[id]'`), or the path when it is not a page. |
| `params` | `Record<string, string>` | Route params from the pattern (`{ id: '42' }`); `[...slug]` joined with `/`. |
| `query` | `URLSearchParams` | The page URL's query. |
| `headers` | `{ get(name) }` | Read-only, case-insensitive. On `/tvine/api` the `x-tvine-*` headers are removed. Over MCP the `cookie` header is removed. |
| `ip` | `string` | Client IP. `X-Forwarded-For` walked right-to-left exactly `settings.trustProxy` hops; never the raw header. Ports, brackets and `::ffff:` removed. |
| `id` | `string` | Request id: a safe incoming `x-request-id`, else the `traceparent` trace id, else a new id. |
| `locale` | `string?` | Set only by the `Locale` middleware (a client-sent `x-tvine-locale` is deleted). |
| `agent` | object | Who is calling, below. |
| `files` | `UploadedFile[]` | Files from a multipart agent POST; empty otherwise. |
| `user` | `TvineUser` | Always present; `ANONYMOUS` when signed out. |
| `raw` | `IncomingMessage?` | The Node request, only on the HTTP page transport and browser `/tvine/api` / `urls.ts` calls. Escape hatch. |

### `TvineUser`

| Field | Type | Meaning |
|---|---|---|
| `isAuthenticated` | `boolean` | Signed in. |
| `isAnonymous` | `boolean?` | `true` on `ANONYMOUS`. |
| `id`, `name` | `string?` | From the auth backend. |
| `claims` | `Record<string, unknown>?` | Whatever a BYO resolver returns. |
| `isActive`, `isStaff`, `isSuperuser` | `boolean?` | Filled by `tvine.auth`. |
| `scopes` | `string[]?` | Token-authenticated: `'*'`, `'read'`, `'app.*'`, `'app.x'`. Dispatch refuses actions outside them. |
| `hasPerm(perm, obj?)` | `Promise<boolean>?` | Is one permission (`'app.codename'`) granted, optionally for `obj`. |

Resolution order: `settings.auth.user(request)` (BYO, wins) → a bearer token (`tvine.auth`) → the session's user.
Details: [contrib/auth.md](./contrib/auth.md).

## How agents are detected (`request.agent`)

| Path in | `agent.is` | `via` | `client` |
|---|---|---|---|
| HTTP page URL with the `settings.header` header (default `x-tvine`, any value) | `true` | `'http'` | `User-Agent` |
| HTTP page URL with `Accept` containing `text/tvine`, `application/tvine+json`, or `text/markdown` ranked at least as high as `text/html` | `true` | `'http'` | `User-Agent` |
| `GET <page>/agent.json` (always) or `<page>/agent.txt` (when `formats.notationPath`) | `true` | `'http'` | `User-Agent` |
| HTTP page URL, none of the above | not an agent: the request goes to Next | — | — |
| `/tvine/api` or a `urls.ts` route with the same header / `Accept` markers | `true` | `'http'` | `User-Agent` |
| `/tvine/api` / `urls.ts` without them | `false` | `'human'` | `User-Agent` |
| MCP (`POST /mcp`) | `true` | `'mcp'` | MCP `clientInfo.name` |
| A bearer API token (`Authorization`, `tvine.auth`) | `true` | unchanged | unchanged |
| Body `agentCmd: { via: 'webmcp' }` (in-browser agent) | `true` | `'webmcp'` | unchanged |
| Body `agentCmd` with any other `via` | `true` | `'channel'` (`'inspector'` only when `settings.debug`) | unchanged |
| Any request of a session whose tab a remote agent controls right now | `true` | `'channel'` | unchanged |
| Next server forward (two-server mode) flagged agent, or an agent's snapshot render | `true` | `'http'` | — |
| `verified` | set only by `tvine.middleware.Shield` for a valid Web Bot Auth signature, never from a header | | |

The flag is **downgrade-only**: a client can mark a request as an agent, never as a human. `denyAgents`,
`humanOnly`, MCP hiding and `confirm.by: 'human'` all read `request.agent.is`.

## Sessions

```ts
interface Session {
  sid: Sid                       // 21-char id
  rev: Rev                       // +1 per committed non-readOnly action
  data: Map<string, unknown>     // your state: cart, wizard step, …
  createdAt: number; lastSeen: number
  controller?: string            // reserved
}
```

| Topic | Rule |
|---|---|
| Found by | `sid` (agents: `x-tvine-sid` header, `?sid=` on agent GET, body `sid`, MCP `sid` arg) or the session cookie (browsers). `/tvine/channel` accepts `?sid=` only when `settings.debug` is on — prefer the header. |
| Created | On an agent page GET without one; on a write through `/tvine/api` (the cookie is set in the reply); never by a page view. A read without a session runs on a throwaway session that is not stored. |
| `data` in actions | The handler works on a deep copy; it replaces the real data only after the action succeeds. A `readOnly` action may write `data` too (saved, no rev bump). |
| One at a time | Commands of one sid run one after another (queue depth 16, then `rate_limited`); with redis also across servers. |
| Idle expiry | `settings.session.ttlMs` (24 h) since `lastSeen`. |
| Absolute expiry | `settings.session.maxAgeMs` (14 days) since `createdAt`; `0` = none. |
| Cap | `settings.session.max` (100 000) live sessions per process; least recently used evicted. |
| Store | `settings.session.backend`: `'memory'` (per process) or `'redis'`. |
| Expired / unknown sid on a command | `expired_sid` with a fresh sid + snapshot attached. |
| Rotation | `cycleSession(ctx)` in a handler: after commit the session gets a new sid; the old sid and its cookies stop working (login, logout). |

### The session cookie

`<cookieName>=<value>; Path=/; Max-Age=<ttlMs/1000>; HttpOnly; SameSite=<Lax|Strict|None>[; Secure]`

| Setting | Default | Effect |
|---|---|---|
| `session.cookieName` | `tvine_s` | Becomes `__Host-tvine_s` when `secure` is on. |
| `session.secure` | on in production (`TVINE_SESSION_SECURE`) | `Secure` flag. |
| `session.sameSite` | `'lax'` | `'none'` needs `secure`. |

The cookie value is not the sid; the sid is never written into a response body for a cookie-only browser.
A sid named by the caller (`?sid=`, header, body) never becomes a browser cookie. App cookies (other than the
session): Not covered by Warp; read `request.headers.get('cookie')` or use Next's `cookies()`.

### In server components

```ts
const currentSession: () => Promise<Session | undefined>   // the page's session, undefined if none
const currentRequest: () => Promise<Request>               // the page's Request (user, agent, ip, …)
```

They read the cookie (or, during an agent's snapshot render, that agent's session). They throw when no tvine
server runs in the process or the page is being prerendered at build: make the page dynamic
(`await connection()`). Reading the session marks the agent snapshot as personal (never shared-cached).

## Uploads

```ts
function defineUpload(name: string, opts: {
  maxBytes: number; types: string[]
  storage?: Storage; permissions?: Permission[]; uploadTo?: string
  public?: boolean; private?: boolean
  rate?: { limit: number; windowMs: number }
}): UploadDef                                             // an ordinary action; export it from views.ts
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxBytes` | `number` | required | File size cap → `too_large` (HTTP 413). |
| `types` | `string[]` | required | Allowed MIME types, checked by sniffing the first bytes (not the client's type). Known: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`. Else `unsupported_type`. |
| `storage` | `Storage` | `DiskStorage(settings.media.dir, settings.media.route)` | Where files go. |
| `permissions` | `Permission[]` | `[]` | Action permissions. |
| `uploadTo` | `string` | — | Key folder: `'avatars'` → `avatars/<id>.png`. Folder names joined by `/`. |
| `public` | `boolean` | `false` | Served with `Cache-Control: public`. |
| `private` | `boolean` | `false` | Only via a signed, expiring URL (`media.url`). Not with `public`. |
| `rate` | rate | 5 per minute | The 5/min default yields to `apps/<app>/rules.ts`; an explicit `rate` beats both. |

The action's param is `file`; the result is an `UploadedFile`:
`{ field: 'file', key, url, type, size }` (for a private file `url` is signed for 1 h).

Ways to send the file:

| Transport | How |
|---|---|
| Agent HTTP (page URL, `x-tvine: 1`) | `multipart/form-data`: text fields `action` (must come before the file), optional `sid`, `cmdId`, `bind`, `rev`; then exactly one file part named `file`; nothing after it. Streamed to storage; removed again if the action fails. |
| JSON (`api.*`, `/tvine/api`, MCP) | `params: { file: { base64: '…' } }`, max 256 KB decoded. URLs are refused. |

`media.url(key, { expiresIn?: seconds (3600), user? })` signs a private-file URL; `user` limits it to that user.

`/tvine/api` also accepts `multipart/form-data` (a `params` JSON part + file parts) for actions that declare
`multipart: { maxBytes, partBytes? }` on the def (the admin uses it); only for a signed-in, same-origin caller.
App-level use of that path: Not covered.

## Examples

### 1. Read the caller in an action

```ts
import { z } from 'zod'
import { defineAction, DomainError, getLogger } from 'tvine'

export const checkout = defineAction('checkout', z.object({}), async (_p, ctx) => {
  const { user, agent, ip } = ctx.request
  if (!user.isAuthenticated) throw new DomainError('forbidden', 'sign in to check out')
  getLogger('orders').info('checkout', { user: user.id, agent: agent.is ? agent.client : 'human', ip })
  return { cart: ctx.session.data.get('cart') ?? {} }
})
```

### 2. A page that shows the cart from the session

```tsx
// app/cart/page.tsx
import { connection } from 'next/server'
import { currentSession } from 'tvine'

export default async function Cart() {
  await connection()
  const s = await currentSession()
  const cart = (s?.data.get('cart') as Record<number, number> | undefined) ?? {}
  return <p>{Object.keys(cart).length} items</p>
}
```

### 3. Product image upload

```ts
// apps/catalog/views.ts
import { defineUpload, isStaff } from 'tvine'
export const uploadImage = defineUpload('uploadImage', {
  maxBytes: 2_000_000, types: ['image/png', 'image/jpeg', 'image/webp'],
  uploadTo: 'products', public: true, permissions: [isStaff],
})   // → catalog.uploadImage
```

```bash
# POST to any routed page (here /sell); the action field comes first
curl -s -X POST http://localhost:3000/sell -H 'x-tvine: 1' \
  -F action=catalog.uploadImage -F sid=$SID -F file=@hat.png
```

### 4. Agent request with an explicit sid

```bash
curl -s http://localhost:3000/shop -H 'x-tvine: 1' -H "x-tvine-sid: $SID"
curl -s -X POST http://localhost:3000/shop -H 'x-tvine: 1' -H 'content-type: application/json' \
  -d "{\"action\":\"cart.addToCart\",\"params\":{\"productId\":7,\"qty\":1},\"sid\":\"$SID\",\"cmdId\":\"c1\"}"
```

## Gotchas

- `request.path` on an API call is the page that made the call, so `settings.guards` apply by page.
- `request.ip` is the socket address unless `settings.trustProxy` is set; behind a proxy set it, or every
  client shares one rate-limit key.
- `request.user` is resolved lazily from the session; inside an action it is final.
- A page view never creates a session (pages cannot set cookies); the first write does.
- `x-tvine` on `/tvine/api` makes the call an agent call (`humanOnly` refuses it).
- Upload type checks sniff bytes; a renamed `.exe` as `image/png` is refused.
- The multipart upload path needs the `action` field before the `file` part.

## See also

[actions.md](./actions.md) · [middleware.md](./middleware.md) · [errors.md](./errors.md) · [settings.md](./settings.md) ·
[contrib/auth.md](./contrib/auth.md) · [overview.md](./overview.md)
