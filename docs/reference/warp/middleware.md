# Middleware

Tvine has two kinds of middleware. **HTTP middleware** is Django's `MIDDLEWARE`: it wraps every HTTP request
the server answers (pages, `/tvine/api`, `/mcp`, media, `urls.ts` routes), sees the raw Node request on the way
in and the response headers on the way out. You list it in `settings.middleware`; only listed entries run.
**Action middleware** wraps every action call (any transport, including in-process `api.*` and MCP) after
the security checks; it sees the command and can stop it or reshape its events. Hooks (`apps/<app>/hooks.ts`)
only observe.

**Import:** `import { defineMiddleware, MIDDLEWARE_CATALOG, type HttpMiddleware, type MwRequest, type RequestState, type BuildCtx, type Middleware, type Event, Hooks } from 'tvine'`

## HTTP middleware: `settings.middleware`

```ts
middleware: unknown[]   // outermost first
```

Each entry is one of:

| Entry | Example | Meaning |
|---|---|---|
| a built-in name | `'tvine.middleware.GZip'` | from the catalog below |
| `[name, options]` | `['tvine.middleware.RateLimit', { limit: 300 }]` | with options |
| a dotted project path | `'config.middleware.timing'` | default export of `config/middleware/timing.ts` (from the project root, `.ts`/`.js`/`.mjs`); missing file or no default export → boot error |
| an object | `defineMiddleware({ name, ... })` | inline |
| a class | `class Timing { constructor(opts, build) {…} processRequest(req, res) {…} }` | built with `(options, BuildCtx)`; its `name` is the class name |
| `[object \| class \| path, options]` | `['config.middleware.timing', { slowMs: 500 }]` | options go to the class constructor |

Default (when you leave `middleware` out): `RequestId`, `AllowedHosts`, `Security`, `Cors`, `GZip`.
`middleware: []` turns all of them off, security headers included. Order is the list order, except
`AllowedHosts`, which is always moved to the front. `tvine check` prints the order it will use.

Plain functions in `settings.middleware` (the old form) are moved to `actionMiddleware`; a list of only
functions keeps the default HTTP list.

`settings.admin.allowIps` appends `['tvine.middleware.IpFilter', { paths: [admin.path], allow: allowIps }]`.

## Built-in catalog

| Name | Default | What it does |
|---|---|---|
| `RequestId` | on | Takes a safe `x-request-id` (`[\w.-]{1,128}`) or the `traceparent` trace id, else a new one; sets `req.tvine.id`, adds it to every log line, echoes `x-request-id`. |
| `AllowedHosts` | on | Unknown `Host` (or trusted `X-Forwarded-Host`) → `400 Bad Request (invalid host)`. A direct loopback request (no proxy headers, `trustProxy` 0) always passes. Dev + debug: localhost, LAN IPs, the hostname, `dev.allowedHosts`, `TVINE_DEV_ALLOWED_HOSTS` are added, and the 400 names the line to add. No `Host` passes outside production. |
| `Security` | on | Security headers from `settings.security.headers` (CSP with a per-response nonce, HSTS on https, COOP, CORP, Referrer-Policy, Permissions-Policy). Sets `req.tvine.cspNonce`. |
| `Cors` | on | Applies `settings.cors`: answers preflights, adds allow headers for allowed origins, `Vary: Origin`; only on paths this server answers. |
| `GZip` | on | Turns on gzip / brotli per `settings.compression`. |
| `SslRedirect` | off | Plain http → `301` to `https://<host><url>` (https read through `trustProxy`). |
| `ConditionalGet` | off | `GET`/`HEAD` 200 with an `ETag` matching `If-None-Match` → `304`. |
| `RateLimit` | off | Per-IP token bucket on every path → `429` + `Retry-After`. Uses `settings.limits.backend`. |
| `IpFilter` | off | Allow / deny by address or CIDR → `403`. Bad CIDR → boot error. Unparseable client IP never matches `allow`. |
| `Maintenance` | off | `503` + `Retry-After` while on (HTML for `Accept: text/html`, else JSON `{ error: 'maintenance', message }`). |
| `BodyLimit` | off | `Content-Length` over the cap → `413`. |
| `Timeout` | off | No response started within `ms` → `503`. Never cuts a response already started. Exempt: `/tvine/channel`, `/tvine/tab`, `/mcp`, the media route. |
| `AccessLog` | off | One `info` line per request on `tvine.request`: method, path (never the query), status, ms, ip, `aborted`. |
| `Locale` | off | `Accept-Language` → `request.locale` (one of `languages`); `Content-Language` + `Vary: Accept-Language` out. |
| `ServerTiming` | off | `Server-Timing: app;dur=<ms>`, only when `settings.debug`. |
| `Shield` | off | `tvine.shield` bot protection (needs `'tvine.shield'` in `installedApps`). Options are Shield's; see its docs. |
| `BotGuard` | off | Known scanner user agents → `403`. Never on the agent surface (`/mcp`, `/tvine/*`, `/.well-known/*`, `/llms.txt`, `*/agent.json|txt`). |

### Options

| Middleware | Option | Type | Default | Meaning |
|---|---|---|---|---|
| `AllowedHosts` | `hosts` | `string[]` | `settings.allowedHosts` | Replaces the host list. `'*'`, `'.example.com'` (with subdomains), `'*.example.com'`, exact, `[ipv6]`. |
| `SslRedirect` | `exempt` | `string[]` | — | Path prefixes not redirected. |
| | `host` | `string` | the request host | Redirect target host. |
| `RateLimit` | `limit` | `number` | `5 × settings.limits.rate.limit` (300) | Requests per window per IP. |
| | `windowMs` | `number` | `settings.limits.rate.windowMs` (60 000) | Window. |
| | `exempt` | `string[]` | — | Path prefixes not counted. |
| `IpFilter` | `allow` | `string[]` | unset (everyone) | Only these addresses / CIDRs pass. |
| | `deny` | `string[]` | `[]` | These are refused. |
| | `paths` | `string[]` | unset (every path) | Only apply under these prefixes. List the middleware twice for two rules. |
| `Maintenance` | `enabled` | `boolean` | `false` | On. |
| | `file` | `string` | — | On while this file exists. |
| | `retryAfter` | `number` (s) | `300` | `Retry-After`. |
| | `allowIps` | `string[]` | `[]` | Pass through. |
| | `allowPaths` | `string[]` | — | Path prefixes that pass. |
| | `allowStaff` | `boolean` | `false` | A signed-in staff user (session cookie) passes. |
| | `message` | `string` | `'Down for maintenance; back soon.'` | Body text. |
| `BodyLimit` | `maxBytes` | `number` | `settings.limits.bodyBytes` | Cap. |
| | `paths` | `Record<string, number>` | `{}` | Per-prefix caps; the longest matching prefix wins. |
| `Timeout` | `ms` | `number` | `settings.limits.handlerMs + 5000` | Limit. |
| | `exempt` | `string[]` | — | More exempt prefixes. |
| `Locale` | `languages` | `string[]` | `['en']` | Supported tags. |
| | `default` | `string` | first of `languages` | Fallback. |
| `BotGuard` | `block` | `RegExp` | sqlmap, nikto, masscan, nmap, nuclei, wpscan, gobuster, ffuf, … | User-agent pattern. |

Path prefixes match the exact path or anything under `prefix/`. Paths are normalized first (decoded, `\` → `/`,
dot segments and duplicate slashes collapsed), so `/x/../admin` cannot step around a rule.

## Writing HTTP middleware

```ts
interface HttpMiddleware {
  name: string
  process?(req: MwRequest, res: ServerResponse, next: () => Promise<void>): void | Promise<void>
  processRequest?(req: MwRequest, res: ServerResponse): void | Promise<void>
  processResponse?(req: MwRequest, res: ServerResponse): void
  processException?(req: MwRequest, res: ServerResponse, err: unknown): boolean | void | Promise<boolean | void>
}
const defineMiddleware: (m: HttpMiddleware) => HttpMiddleware
```

| Method | When | Notes |
|---|---|---|
| `process(req, res, next)` | around (Koa style) | `await next()` resolves when the response finished or the client left. `next()` twice throws. Not together with `processRequest`. |
| `processRequest(req, res)` | on the way in | End the response (`res.writeHead(...).end()`) to stop: inner middleware and transports never run. |
| `processResponse(req, res)` | right before the status line and headers go out, innermost first | Sync. Set or remove headers here. |
| `processException(req, res, err)` | an error thrown by this or an inner middleware | Return `true` if you answered; else the next outer one tries; then `500`. |

`defineMiddleware` throws without a `name` or without at least one method, or with both `process` and `processRequest`.

### `req.tvine` (`RequestState`)

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Normalized path, no query. |
| `ip` | `string` | Client IP per `settings.trustProxy`. |
| `https` | `boolean` | Per `trustProxy` (`X-Forwarded-Proto`). |
| `host` | `string?` | The validated host (set by `AllowedHosts`), lowercase, no port. |
| `id` | `string?` | Request id (set by `RequestId`). |
| `locale` | `string?` | Set by `Locale`. |
| `start` | `number` | `performance.now()` at arrival. |
| `ours` | `boolean` | `false` in embedded mode for paths the host app answers (middleware is skipped there). |
| `compression` | settings or `false` | Set by `GZip`. |
| `onHeaders(fn)` | function | Run `fn` right before headers are sent. |
| `log` | `Logger` | `tvine.request`, bound to the request id. |
| `verifiedAgent` | `{ directory, keyid }?` | Set by `Shield` for a valid Web Bot Auth signature. |
| `cspNonce` | `string?` | Set by `Security`. |
| `shield` | `unknown` | Shield's signals and decision. |

### `BuildCtx` (class constructors get it as the 2nd argument)

`{ settings, debug, production, sec, cors, userOf? }`: `userOf(req)` resolves the session user from the cookie.

WebSocket upgrades (Next HMR) pass through `AllowedHosts` and `IpFilter` only.

## Action middleware

```ts
type Middleware = (cmd: Command, ctx: ActionCtx, next: () => AsyncIterable<Event>) => AsyncIterable<Event>
```

| Where | Scope |
|---|---|
| `settings.actionMiddleware: Middleware[]` | every action, runs first (outermost) |
| `apps/<app>/middleware.ts` with `export default [fn, ...]` | only that app's actions; default export must be an array of functions (boot error otherwise) |

| Point | Detail |
|---|---|
| Position | After origin check, rate limits, session, `humanOnly`, permissions, bind, rev. Before param validation, `confirm`, the handler and the commit. |
| `cmd` | `{ action, params, sid?, bind?, cmdId?, rev?, agentCmd? }`, deep-frozen (params cannot drift from the idempotency hash). |
| Stop | `yield` an `err` event (`{ kind: 'err', code: 'domain', message, reason? }`) and return without `next()`. |
| Continue | `yield* next()`. Events: `ok`, `snapshot`, `goto`, `err`. |
| Time | Capped at `settings.limits.handlerMs` (the clock pauses while the handler runs). Over it → `internal` "middleware timeout". |
| After commit | Throwing after a committed result, or dropping it, is logged and the committed result is returned anyway. Writes to `ctx` after `next()` are outside the transaction. |

## Hooks (observe only)

`apps/<app>/hooks.ts`: each exported function named after a hook is registered at boot. Any other exported
function name is a boot error.

| Name | Payload | When |
|---|---|---|
| `command` | `{ cmd, action, status, sid, events, ms }` | every action call, after it settled (params redacted, `secretResult` blanked, frozen) |
| `error` | `{ cmd, code, message }` | additionally, on an err outcome |
| `session` | `{ sid, kind: 'created' \| 'expired' }` | session lifecycle |
| `read` | `{ page, via: 'http' \| 'mcp', sid, rev, ms }` | an agent read a page snapshot |
| `ready(server)` | the `ServerCtx` | at boot, awaited, before serving |
| `postMigrate(e)` | `{ app, models, applied }` | after `tvine migrate` |

Also `server.ctx.hooks.on(name, fn)` at run time. Hooks are fire-and-forget; a throw is logged.

## Examples

### 1. Turn on extra built-ins

```ts
// config/settings/base.ts
middleware: [
  'tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Security',
  'tvine.middleware.Cors', 'tvine.middleware.GZip',
  ['tvine.middleware.RateLimit', { limit: 600, exempt: ['/_next/'] }],
  ['tvine.middleware.IpFilter', { allow: ['10.0.0.0/8'], paths: ['/admin'] }],
  ['tvine.middleware.Maintenance', { file: './MAINTENANCE', allowStaff: true }],
  'tvine.middleware.AccessLog',
],
```

### 2. Project middleware by dotted path

```ts
// config/middleware/timing.ts
import { defineMiddleware } from 'tvine'

export default defineMiddleware({
  name: 'timing',
  async process(req, res, next) {
    req.tvine.onHeaders(() => res.setHeader('x-took-ms', (performance.now() - req.tvine.start).toFixed(1)))
    await next()
  },
})
// settings: middleware: [...defaults, 'config.middleware.timing']
```

### 3. A partners-only path with processRequest

```ts
export default defineMiddleware({
  name: 'wholesaleOnly',
  processRequest(req, res) {
    if (req.tvine.path.startsWith('/wholesale') && !req.headers['x-partner-key']) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('partners only')
    }
  },
})
```

### 4. Action middleware: "shop closed" switch

```ts
// apps/orders/middleware.ts
import type { Middleware } from 'tvine'

const shopClosed: Middleware = async function* (cmd, ctx, next) {
  if (cmd.action === 'orders.place' && ctx.settings.site.name.endsWith('(closed)')) {
    yield { kind: 'err', code: 'domain', reason: 'closed', message: 'The shop is closed today' }
    return
  }
  yield* next()
}
export default [shopClosed]
```

### 5. A hook that logs slow actions

```ts
// apps/orders/hooks.ts
import { getLogger } from 'tvine'
const log = getLogger('orders')
export function command(e: { action: string; status: string; ms: number }) {
  if (e.ms > 1000) log.warn('slow action', { action: e.action, status: e.status, ms: e.ms })
}
```

## Gotchas

- Only listed HTTP middleware runs. Setting `middleware` replaces the defaults: copy the five you want to keep.
- `AllowedHosts` always runs first, whatever its position.
- In production with `AllowedHosts` on and `allowedHosts` empty, boot fails.
- `tvine.middleware.Shield` without `'tvine.shield'` installed fails settings validation.
- Action middleware cannot skip permissions or `humanOnly`: they ran before it.
- `processResponse` is sync and runs at header time; do not await in it.
- A dotted path is resolved from the current working directory (the project root), not from the settings file.

## See also

[settings.md](./settings.md) · [actions.md](./actions.md) · [request.md](./request.md) · [errors.md](./errors.md) ·
[overview.md](./overview.md)
