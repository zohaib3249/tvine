# Settings and environment

One file, `settings.ts` at the app root, configures everything. It is zod-validated at
boot, with defaults for every key you leave out.

## Minimal

```ts
// settings.ts
import { defineSettings } from 'tvine'

export default defineSettings({
  site: { name: 'Notes', description: 'A tiny notes app built on Tvine.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin', 'notes'],   // users, background jobs, /admin, apps/notes
  mcp: { exclude: ['admin.*'] },   // keep the admin's actions out of the typed MCP tools
})
```

That is all of [examples/notes/settings.ts](../examples/notes/settings.ts). Everything else is a default:
SQLite at `./tvine.db`, jobs in `./tasks.db`, a random secret per boot in development.

Check it:

```bash
pnpm exec tvine check
# tvine: settings ok
# tvine: discovered 52 actions, 1 routes
# middleware: tvine.middleware.AllowedHosts > tvine.middleware.RequestId > tvine.middleware.Security > ...
# env set: DATABASE_URL
# backend session.backend = memory
```

`tvine check` prints the middleware order, which environment variables are set (names only, never values),
and which backend each subsystem uses.

## The main keys

| Key | What it does | Default |
|---|---|---|
| `site` | `{ name, description }`: shown to agents (`/llms.txt`, MCP) and in the admin | — |
| `installedApps` | built-in apps: `tvine.auth`, `tvine.tasks`, `tvine.admin`, `tvine.audit` | `[]` |
| `secret` | HMAC key, 32+ chars; an array (or `TVINE_SECRET=new,old`) rotates keys | dev: random; prod: required |
| `debug` | debug mode: dev CSP, inspector feed, helpful errors | on under `tvine dev` and `NODE_ENV=development` |
| `allowedHosts` | allowed `Host` names (`*`, `.example.com`); others get a 400 | dev: localhost; prod: required |
| `dev.allowedHosts` | dev only, added on top: port forwarding / tunnel hosts (`'*.ngrok-free.app'`, `'*.devtunnels.ms'`); also `TVINE_DEV_ALLOWED_HOSTS`. In dev a refused host's 400 names the line to add | `[]` |
| `db` | `{ url, pool: { max, acquireMs, idleMs }, atomicRequests, slowQueryMs }` | `file:./tvine.db`, one transaction per request |
| `session` | `{ ttlMs, maxAgeMs, cookieName, secure, sameSite, max, backend }` | 24 h idle, 14 days max, `lax` |
| `limits` | `{ bodyBytes, handlerMs, rate: { limit, windowMs, by }, sseConnPerIp, backend }` (`rate.by: 'shield'` lets Shield's rules be the only general rate limit, see [shield.md](shield.md#rate-limits-shield-and-the-framework)) | 64 KB, 10 s, 60/min, `'framework'` |
| `trustProxy` | how many `X-Forwarded-For` hops to trust (drives `request.ip`) | `0` |
| `middleware` / `actionMiddleware` | HTTP middleware / around each action | RequestId, AllowedHosts, Security, Cors, GZip |
| `security.headers` | HSTS, CSP, COOP, CORP, Referrer-Policy, Permissions-Policy | on |
| `cors` | `{ origins, methods, credentials, maxAge, routes }` | closed |
| `compression` | gzip / brotli | on, 1 KB threshold |
| `mcp` | `{ tools: 'both', exclude, maxTools }` | 40 typed tools |
| `agent` | `{ shape, budget, rowsL1, inTab }`: the agent snapshot and tab control | `inTab: 'on'` |
| `logging` | `'json' \| 'pretty' \| 'none'` or a logging config object | pretty in dev, json in prod |
| `tasks` | worker lease, poll, grace, result TTL | see [tasks-cache-email.md](tasks-cache-email.md) |
| `caches`, `email` | named caches, mail backend and addresses | memory cache, console mail in dev |
| `redis`, `channels` | shared backends for multi-process deploys | memory |
| `media` | `{ dir, route }` for uploads | `./media`, `/media` |
| `metrics` | Prometheus text at `/tvine/metrics` | off |
| `shield` | bot protection, see [shield.md](shield.md) | `mode: 'log'` |
| `guards`, `health`, `siteUrl`, `encryption`, `header`, `formats` | see [every key](#reference-every-key) | |
| `robots` | the generated `/robots.txt` | allows agent paths |
| `audit` | durable audit trail | off |
| `admin` | `allowIps`, `require2fa`, `idleMs` for staff | off |
| `frontend.boundary` | `tvine check` fails (`'error'`) or warns when a page imports a model | `'error'` |

Backends (memory vs redis) for production: [deploy.md](deploy.md).

## Middleware

`settings.middleware` is the HTTP middleware list. Leave it out and you get the safe default list (the first five
below). Only listed entries run; `middleware: []` turns every one off, security headers included.

```ts
middleware: [
  'tvine.middleware.RequestId',
  'tvine.middleware.AllowedHosts',
  'tvine.middleware.Security',
  'tvine.middleware.Cors',
  'tvine.middleware.GZip',
  ['tvine.middleware.RateLimit', { limit: 300, windowMs: 60_000 }],          // [name, options]
  ['tvine.middleware.IpFilter', { allow: ['10.0.0.0/8'], paths: ['/admin'] }],
  timing,                                                                   // your own, below
],
```

A new project lists the whole set in `config/settings/base.ts`: the five defaults on, every other built-in
commented out with a one-line note. Turn one on or off by (un)commenting its line; `dev.ts` / `prod.ts` can replace
the list (`prod.ts` adds `SslRedirect`: `middleware: [...base.middleware, 'tvine.middleware.SslRedirect']`).

Your own middleware lives in `config/middleware/` (startproject writes `index.ts` and an `example.ts` that is off).
List it by dotted path: `'config.middleware.example'` loads the default export of `config/middleware/example.ts`
(from the project root). A path with no file fails at boot, naming the file it expected. Importing the object and
listing it directly works too.

Order is the list order (outermost first), except `AllowedHosts`, which always runs first. `tvine check` prints
the order it will use.

| Name | Default | What it does | Options |
|---|---|---|---|
| `RequestId` | on | `x-request-id` on every request and response, in logs and audit | — |
| `AllowedHosts` | on | unknown `Host` → 400 | `hosts` |
| `Security` | on | security headers from `settings.security.headers` (CSP with nonce, HSTS on https, …) | — |
| `Cors` | on | applies `settings.cors` | — |
| `GZip` | on | gzip / brotli from `settings.compression` | — |
| `SslRedirect` | off | http → 301 https (set `trustProxy` behind a proxy) | `exempt`, `host` |
| `ConditionalGet` | off | `ETag` → 304 | — |
| `RateLimit` | off | per-IP limit on every path → 429 + `Retry-After` | `limit`, `windowMs`, `exempt` |
| `IpFilter` | off | allow / deny by address or CIDR → 403 | `allow`, `deny`, `paths` |
| `Shield` | off | bot protection: score, rules, challenges, the /shield panel; needs `tvine.shield` installed. See [shield.md](shield.md) | `prefix` |
| `Maintenance` | off | 503 while `enabled` or while `file` exists | `enabled`, `file`, `retryAfter`, `allowIps`, `allowPaths`, `allowStaff`, `message` |
| `BodyLimit` | off | body over the cap → 413 | `maxBytes`, `paths: { '/upload': n }` |
| `Timeout` | off | no response in `ms` → 503 (streams are never cut) | `ms`, `exempt` |
| `AccessLog` | off | one log line per request (never the query string) | — |
| `Locale` | off | `Accept-Language` → `request.locale` | `languages`, `default` |
| `ServerTiming` | off | `Server-Timing` header, debug only | — |
| `BotGuard` | off | known scanner user agents → 403 (agent paths never) | `block` (RegExp) |

Your own middleware:

```ts
import { defineMiddleware } from 'tvine'

export const timing = defineMiddleware({
  name: 'Timing',
  async process(req, res, next) {
    req.tvine.onHeaders(() => res.setHeader('x-took', String(performance.now() - req.tvine.start)))
    await next()
  },
})
// or hooks: processRequest(req, res), processResponse(req, res), processException(req, res, err)
```

`req.tvine` has `path`, `ip`, `https`, `host`, `id`, `locale`, `log`.

Project middleware file (`config/middleware/example.ts`):

```ts
import { defineMiddleware } from 'tvine'

export default defineMiddleware({
  name: 'example',
  processRequest(req) { /* runs before the view; end the response to stop the request */ },
})
```

**Action middleware** wraps each backend action instead of each HTTP request: `settings.actionMiddleware` (global)
or `apps/<app>/middleware.ts` with `export default [...]` (that app only). It runs after permission checks, so it
cannot skip them. Use it for things like a "shop closed" switch.

## Logging

```ts
logging: 'json'          // or 'pretty' | 'none'. Default: pretty in dev, json in production
logging: {               // or a config object
  level: 'info',
  handlers: [
    { type: 'console' },
    { type: 'file', path: './log/app.log', level: 'warn', maxBytes: 10_000_000, daily: true, keep: 7 },
    { type: 'custom', level: 'error', write: (record) => sentry.capture(record) },
  ],
  loggers: { 'tvine.request': 'info', 'tvine.db': 'warn', myapp: 'debug', noisy: 'off' },
  redact: ['iban'],      // extra field names to blank
}
```

```ts
import { getLogger } from 'tvine'
const log = getLogger('myapp.orders')
log.info('order placed', { orderId, total })     // debug / info / warn / error
```

Passwords, tokens, cookies, keys and similar fields are replaced with `[redacted]` before any handler sees them.
Built-in loggers: `tvine` (runtime errors), `tvine.request`, `tvine.security` (logins, refused hosts, …),
`tvine.db` (queries slower than `db.slowQueryMs`, default 500 ms), `tvine.tasks` (the worker).

## Environment variables

Read typed values with `env`:

```ts
import { defineSettings, env } from 'tvine'

export default defineSettings({
  trustProxy: env.int('TVINE_TRUST_PROXY', 0),
  allowedHosts: env.list('ALLOWED_HOSTS', []),          // "a.com, .b.com" → ['a.com', '.b.com']
  socket: env.bool('SOCKET', true),                     // 1/0, true/false, yes/no, on/off
  email: { password: env.required('SMTP_PASSWORD') },  // unset → boot error naming the variable
})
```

Also `env.str`, `env.url`, `env.json`, `env.has`. An empty value counts as unset. The same readers have `get*`
names: `env.get(key, default?)` (string), `env.getInt`, `env.getBool`, `env.getList` (comma list, trimmed),
`env.getUrl`, `env.getJson`.

### Variables the framework reads

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `production` turns on the production rules. `tvine start` defaults to production |
| `TVINE_SECRET` | the secret (32+ chars); a comma list rotates keys, newest first |
| `TVINE_ALLOWED_HOSTS` | comma list of hosts |
| `DATABASE_URL` | `file:./x.db`, `postgres://…`, `mysql://…` |
| `REDIS_URL` | the default redis connection |
| `TVINE_SESSION_SECURE` | `1` / `0`: Secure `__Host-` session cookie (on in production) |
| `TVINE_DEBUG` | `1` = debug mode and CLI stack traces |
| `TVINE_LOAD_DOTENV` | `1`: load `.env` files in production too |
| `PORT`, `HOST` | listen port (3000) and address; `--port` / `--host` win |
| `TVINE_SUPERUSER_USERNAME` / `_EMAIL` / `_PASSWORD` | for `createsuperuser --noinput` |
| `TVINE_SETTINGS` | which settings module runs, e.g. `config/settings/prod` (same as `--settings`) |
| `TVINE_DEV_ALLOWED_HOSTS` | dev only: comma list of extra hosts (tunnels, port forwarding), on top of `dev.allowedHosts` |
| `TVINE_ENCRYPTION_KEYS` | comma list for `encryption.keys` (newest first) when settings leave it out |
| `WEB_CONCURRENCY`, `NODE_APP_INSTANCE`, `pm_id` | read only to warn at boot that memory backends are per process |

Split mode (Next runs separately and calls a `tvine start --api-only` server): the Next process has no
settings, so it reads these instead.

| Variable | Meaning |
|---|---|
| `TVINE_API_URL` | the API server's URL; pages' `api.*` calls go there |
| `TVINE_SECRET` | must match the API server (it signs the forwarded call) |
| `TVINE_TRUST_PROXY` | `X-Forwarded-For` hops to trust for the caller's IP (default 0) |
| `TVINE_HEADER` | the API server's `settings.header` (default `x-tvine`) |
| `TVINE_COOKIE_NAME` | the API server's session cookie name |
| `TVINE_SESSION_SECURE`, `TVINE_SESSION_SAMESITE`, `TVINE_SESSION_TTL_S` | the session cookie's Secure flag, SameSite (`lax`) and max age in seconds (86400) |

### `.env` files

Loaded by every `tvine` command when present, first match wins per variable, and a variable already set in the
real environment is never overridden:

1. `.env.<NODE_ENV>.local`
2. `.env.local` (skipped under `NODE_ENV=test`)
3. `.env.<NODE_ENV>`
4. `.env`

`TVINE_ENV_FILES=.env.shared,.env.ci` (a real environment variable) adds files read after those four; a later
file beats an earlier one.

In production they load only with `TVINE_LOAD_DOTENV=1`.

### Loading .env files yourself

`loadEnv(files, { dir?, required? })` loads files in the order given, at the top of `config/settings/base.ts`
(before any `env.*` read):

```ts
import { loadEnv } from 'tvine'
loadEnv(['.env.shared', `.env.${process.env.TENANT}`])   // returns the files it loaded
```

The rules:

1. Files load in order; when two define the same key, **the later file wins**.
2. They also beat the automatic `.env` files above.
3. A variable set by the **real environment** is never overridden.
4. A missing file is skipped; with `required: true` it is a boot error naming the file.
5. Production: off unless `TVINE_LOAD_DOTENV=1` (same rule as the automatic files; `required` is not checked then).

Same syntax as the automatic files (Node's `.env` parser: `#` comments, quotes, `export KEY=`, multi-line quoted values).

## Your own settings

Any top-level key the framework does not know is kept as is: your app's own settings. Put them in
`config/settings/base.ts`, override them in `dev.ts` / `local.ts` (objects deep-merge, arrays replace):

```ts
export const base = {
  // ...framework keys...
  PAYMENT_PROVIDER: env.get('PAYMENT_PROVIDER', 'stripe'),
  shop: { currency: 'EUR', freeShippingOver: 50 },
} satisfies SettingsInput
```

Read them with `ctx.settings.shop` in an action, or anywhere at runtime with `settings()` (throws before boot):

```ts
import { settings } from 'tvine'
const { currency } = settings().shop
```

Type them once (anywhere in the project, e.g. `config/settings/types.ts`):

```ts
declare module 'tvine' {
  interface Settings { PAYMENT_PROVIDER: string; shop: { currency: string; freeShippingOver: number } }
}
```

Custom keys are not validated. Framework keys still are, and a custom key one or two letters away from a
framework key (any case) is reported at boot and by `tvine check`:
`settings: unknown key 'allowedHost' — did you mean 'allowedHosts'? (kept as a custom setting)`.

## Gotchas

- **Production refuses to boot** without a secret and allowed hosts. Running `tvine start` with neither prints
  the fix:
  ```bash
  pnpm exec tvine start --port 4610
  # tvine start: TVINE_SECRET must be a random string of at least 32 chars; ... (fix: export TVINE_SECRET=$(openssl rand -hex 32))
  ```
  A production-like local run that works:
  ```bash
  TVINE_SECRET=$(openssl rand -hex 32) TVINE_ALLOWED_HOSTS=localhost,127.0.0.1 TVINE_SESSION_SECURE=0 \
    pnpm exec tvine start --port 4610
  ```
- **MCP tool cap.** `mcp.maxTools` is 40. With `tvine.admin` installed you have more actions than that, so
  `tvine check` warns that typed tools were trimmed. Trimmed actions still work through the `do` tool. Raise
  `mcp.maxTools` or add ids to `mcp.exclude` if you want specific ones typed.
- **Pages must not read settings for runtime values.** Pages call the backend through `api.*`.
- A page that reads the session must be dynamic (`await connection()` or `export const dynamic = 'force-dynamic'`).
- Memory backends are per process. With more than one process (`WEB_CONCURRENCY`, pm2) boot warns; use redis.

## Reference: every key

Every key `defineSettings` accepts, with its default. Unknown keys inside strict groups (`shield`, `email`, `metrics`,
`robots`, `encryption`, `auth`, each cache) are a boot error. Objects merge deeply; arrays and functions replace.

### Core

| Key | Default | Meaning |
|---|---|---|
| `site.name` / `site.description` | `'tvine app'` / `''` | shown to agents (`/llms.txt`, MCP) and in the admin |
| `siteUrl` | unset (the request's Host) | public origin like `https://shop.example` for links the server builds (approve links, sitemap) |
| `secret` | dev: random per boot; prod: `TVINE_SECRET`, required | HMAC key, 32+ chars; an array rotates (newest first) |
| `debug` | on under `tvine dev` / `NODE_ENV=development` or `test` | dev CSP, inspector feed, `ServerTiming` |
| `installedApps` | `[]` | project apps by folder (`'blog'`) and built-ins `'tvine.auth'`, `'tvine.tasks'`, `'tvine.admin'`, `'tvine.audit'`, `'tvine.shield'` |
| `rootUrlconf` | `config/urls`, else `urls` | the root URL table, a path from the project root without extension |
| `tasksModule` | `config/tasks` | where `tvine worker` finds queues and `beatSchedule` |
| `allowedHosts` | dev: localhost, LAN IPs, hostname; prod: required | `'shop.example'`, `'.example.com'` (with subdomains), `'[::1]'`, `'*'` |
| `dev.allowedHosts` | `[]` | dev only, extra hosts such as `'*.ngrok-free.app'` |
| `trustProxy` | `0` | `X-Forwarded-For` hops to trust (drives `request.ip`, https detection) |
| `health.token` | unset | 16+ chars: `/tvine/health` gives details to `Authorization: Bearer <token>`; others get `{ ok }` ([deploy.md](deploy.md)) |
| `frontend.boundary` | `'error'` | a page importing a model fails `tvine check` (`'error'`) or warns (`'warn'`) |
| `encryption.keys` | `[]` (derived from `secret`) | AES-256-GCM keys for encrypted fields, 32+ chars each, newest first ([models-and-orm.md](models-and-orm.md)) |

### Agents and formats

| Key | Default | Meaning |
|---|---|---|
| `header` | `'x-tvine'` | the agent request header name; `<header>-view`, `-expand`, `-offset`, `-limit`, `-sid` follow it |
| `formats.default` | `'json'` | what an agent request gets with no `Accept` choice: `'json'` or `'notation'` |
| `formats.notationPath` | `true` | serve `<page>/agent.txt` (the page in line notation); `<page>/agent.json` is always served |
| `mcp.tools` | `'both'` | `'both'` (six generic + typed), `'generic'`, `'typed'` ([agents-and-mcp.md](agents-and-mcp.md#which-tools-are-exposed)) |
| `mcp.exclude` | `[]` | globs on action ids kept out of typed tools (`'admin.**'`) |
| `mcp.maxTools` | `40` | typed tools above this are trimmed (still reachable through `do`) |
| `agent.shape` | `'v2'` | snapshot format; `'v1'` is the old one, kept for one release |
| `agent.budget` | `1500` | token budget for `view=auto` |
| `agent.rowsL1` | `10` | list rows shown at `view=L1` |
| `agent.inTab` | `'on'` | `'off'` disables tab control and in-tab WebMCP |
| `snapshotCache.ttlMs` / `backend` / `redis` | `60000` / `'memory'` / `'default'` | shared agent snapshots of public, non-live pages; `0` = off; any write clears it |
| `guards` | `[]` | `[{ path: '/admin/**', permissions: [...] }]`: permission checks on page paths for HTTP, MCP and forms |
| `robots.allow` / `disallow` / `extra` / `sitemap` | `[]` / `[]` / `[]` / unset | the generated `/robots.txt` (only when the app ships none) |
| `socket` | `true` | accepted; not read by the current release |
| `data.defaultPageSize` / `maxPageSize` | `25` / `100` | accepted; generic views use their own `pageSize` / `maxPageSize` (25 / 100) |

### Requests and limits

| Key | Default | Meaning |
|---|---|---|
| `limits.bodyBytes` | `65536` | max request body (64 KB) |
| `limits.handlerMs` | `10000` | max time per action |
| `limits.rate.limit` / `windowMs` / `by` | `60` / `60000` / `'framework'` | action calls per IP + session per window; `by: 'shield'` lets Shield's rules be the only general limit ([shield.md](shield.md#rate-limits-shield-and-the-framework)) |
| `limits.sseConnPerIp` | `20` | open event streams per IP |
| `limits.backend` / `redis` | `'memory'` / `'default'` | where rate limits, idempotency and login throttles live |
| `middleware` | RequestId, AllowedHosts, Security, Cors, GZip | HTTP middleware (see [Middleware](#middleware)) |
| `actionMiddleware` | `[]` | functions around every action |
| `media.dir` / `route` / `auditAccess` | `'./media'` / `'/media'` / unset | uploads; `auditAccess: true` writes an audit row per private-file read |

### Database, sessions, backends

| Key | Default | Meaning |
|---|---|---|
| `db.url` | `DATABASE_URL`, else `file:./tvine.db` | `file:`, `postgres://`, `mysql://` |
| `db.pool.max` / `acquireMs` / `idleMs` | `10` / `5000` / `30000` | connection pool (Postgres / MySQL) |
| `db.atomicRequests` | `true` | each non-read-only action is one transaction |
| `db.slowQueryMs` | `500` | slower statements are logged on `tvine.db`; `0` = off |
| `session.ttlMs` / `maxAgeMs` | 24 h / 14 days | idle timeout / absolute lifetime (`0` = none) |
| `session.cookieName` | `'tvine_s'` | gets the `__Host-` prefix when `secure` |
| `session.secure` | on in production (`TVINE_SESSION_SECURE`) | the cookie's Secure flag |
| `session.sameSite` | `'lax'` | `'none'` needs `secure` |
| `session.max` | `100000` | live sessions kept; the least recently used is dropped past it |
| `session.backend` / `redis` | `'memory'` / `'default'` | session store |
| `channels.backend` / `redis` | `'memory'` / `'default'` | pub/sub for live updates across processes |
| `redis.<alias>.url` / `tls` / `prefix` / `connectTimeoutMs` | `default` from `REDIS_URL` | named Redis connections; every `redis:` key above names one ([deploy.md](deploy.md)) |
| `caches.<alias>` | `default`: memory, timeout 300 s | `backend` (`memory`, `redis`, `file`, `dummy`), `redis`, `location` (file dir), `timeout` (s, `null` = forever), `keyPrefix`, `version`, `maxEntries` (300) ([tasks-cache-email.md](tasks-cache-email.md)) |
| `tasks.broker` | `'file'` | job store: `'db'`, `'file'`, `'memory'`, `'redis'` |
| `tasks.leaseMs` / `pollMs` / `relayMs` / `graceMs` | `30000` / `500` / `250` / `30000` | lease, claim poll, progress relay poll, SIGTERM grace |
| `tasks.resultTtlMs` | 24 h | how long finished job rows are kept |
| `tasks.file` / `durable` / `claimBatch` / `redis` | `'./tasks.db'` / `false` / `10` / `'default'` | file broker path, power-cut durability, jobs per claim, Redis alias |

### Security

| Key | Default | Meaning |
|---|---|---|
| `security.headers.enabled` | `true` | the `Security` middleware sends headers |
| `security.headers.hsts` | 1 year, subdomains, no preload | `false` turns it off; sent on https only |
| `security.headers.csp` | `{ reportOnly: false, directives: {}, reportUri: '/tvine/csp-report', staticPages: 'relaxed' }` | CSP with nonce; `directives` add sources; `false` turns it off |
| `security.headers.referrerPolicy` | `'strict-origin-when-cross-origin'` | `Referrer-Policy` |
| `security.headers.coop` / `corp` | `'same-origin'` / `'same-origin'` | `false` turns either off |
| `security.headers.coep` | unset | `'require-corp'` or `'credentialless'` |
| `security.headers.trustedTypes` | unset | `'report-only'` reports Trusted Types violations |
| `security.headers.permissionsPolicy` | camera, microphone, geolocation, payment, usb, display-capture, browsing-topics, clipboard-read: all off | `Permissions-Policy` |
| `cors.origins` / `methods` / `credentials` / `maxAge` | `[]` / GET, POST / `false` / `600` | closed by default |
| `cors.allowHeaders` | content-type, authorization, the `x-tvine*` headers, MCP headers | headers a cross-origin caller may send |
| `cors.exposeHeaders` | x-request-id, etag, retry-after, mcp-session-id | headers it may read |
| `cors.routes` | `[]` | per-path overrides: `[{ path: '/api/', origins: [...] }]` |
| `compression.enabled` / `threshold` / `brotli` / `gzipLevel` / `brotliQuality` | `true` / `1024` / `true` / `6` / `4` | response compression |
| `audit.enabled` / `actions` / `retentionDays` / `redact` | `false` / `'writes'` / `90` / `[]` | needs `'tvine.audit'` installed ([auth-and-security.md](auth-and-security.md)) |
| `metrics.enabled` / `path` / `token` / `allowIps` | `false` / `'/tvine/metrics'` / unset / `[]` | Prometheus text; neither token nor IPs = loopback only |
| `shield.*` | `mode: 'log'` | bot protection (needs `'tvine.shield'` installed and `tvine.middleware.Shield` listed); every key in [shield.md](shield.md#settings-reference). Also `shield.prefix` (`'/tvine/shield'`, challenge routes), `shield.ipdb.source` / `update` (`'dbip-lite'` / `'monthly'`), `shield.sensor` (`'challenge'`, or `'all-pages'`), `shield.events.maxPerMinute` (600) / `hardCapPerMinute` (20000) |

### Auth (`tvine.auth`)

| Key | Default | Meaning |
|---|---|---|
| `auth.userModel` | `'auth.User'` | the user model; set before the first migrate |
| `auth.backends` | `['tvine.auth.ModelBackend']` | tried in order; also `'tvine.auth.EmailBackend'` or a dotted path |
| `auth.user` | unset | your own `(req) => user \| null` resolver; overrides everything |
| `auth.hashers` / `validators` | built-in | password hashers (first = preferred) and validators |
| `auth.login.maxFailures` / `accountMaxFailures` / `ipMaxFailures` / `windowMs` / `lockoutMs` | `5` / `50` / `100` / 15 min / 15 min | login throttling |
| `auth.resetTimeoutMs` / `resetUrl` / `sendPasswordReset` | 1 h / built-in / built-in | password reset |
| `auth.objectPermission` | unset | `(user, perm, obj) => boolean` for object permissions |
| `auth.tokens.defaultDays` / `maxDays` | `90` / `365` | API token lifetime |
| `auth.totp.issuer` | `site.name` | name shown in authenticator apps |
| `auth.breachCheck` | `false` | check new passwords against Have I Been Pwned |
| `auth.notify.newLogin` / `passwordChanged` / `twoFactorDisabled` / `tokenCreated` / `emailChanged` | on when mail is set up | security mails |

### Admin, email, logging

| Key | Default | Meaning |
|---|---|---|
| `admin.path` / `title` | `'/admin'` / `'Administration'` | where the panel mounts ([admin.md](admin.md)) |
| `admin.theme.brand` / `radius` / `dark` | unset / unset / `'auto'` | colors; `dark`: `'auto'`, `'on'`, `'off'` |
| `admin.allowIps` / `require2fa` / `idleMs` | unset | staff IP allow-list (adds an `IpFilter`), TOTP for staff, staff idle timeout |
| `admin.dashboard.widgets` / `autoCharts` | `[]` / `true` | widget order; automatic per-model charts |
| `admin.stats.enabled` / `retentionDays` / `flushMs` | `true` / `30` / `60000` | the System pages' rollups |
| `admin.stats.searches.enabled` / `minCount` | `true` / `3` | search terms shown once seen this often |
| `admin.stats.pages.enabled` / `keepParams` | `true` / `[]` | page stats; query params kept in the path |
| `email.backend` | console (dev), memory (tests), smtp (prod) | also `'file'`, `'dummy'` ([tasks-cache-email.md](tasks-cache-email.md)) |
| `email.host` / `port` / `user` / `password` / `useTls` / `useSsl` / `allowPlainAuth` / `timeoutMs` | `localhost` / `25` / `''` / `''` / `false` / `false` / `false` / `10000` | SMTP |
| `email.defaultFrom` / `serverEmail` / `admins` / `subjectPrefix` / `filePath` | `webmaster@localhost` / `root@localhost` / `[]` / `'[Tvine] '` / `'./mail'` | sender addresses, admin list, subject prefix, file backend folder |
| `logging` | pretty (dev), json (prod) | string or `{ level, format, handlers, loggers, redact }`; handler types `console` (`stream`), `file` (`path`, `maxBytes`, `daily`, `keep`), `custom` (`write`), `memory` (`size`) |
