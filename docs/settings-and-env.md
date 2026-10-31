# Settings and environment

One file, `settings.ts` at the app root, configures everything. It is Django's `settings.py`: zod-validated at
boot, with defaults for every key you leave out.

## Minimal

```ts
// settings.ts
import { defineSettings } from 'tvine'

export default defineSettings({
  site: { name: 'Notes', description: 'A tiny notes app built on Tvine.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin'],   // users, background jobs, /admin
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
| `debug` | Django `DEBUG` | on under `tvine dev` and `NODE_ENV=development` |
| `allowedHosts` | Django `ALLOWED_HOSTS` | dev: localhost; prod: required |
| `db` | `{ url, pool: { max, acquireMs, idleMs }, atomicRequests, slowQueryMs }` | `file:./tvine.db`, one transaction per request |
| `session` | `{ ttlMs, maxAgeMs, cookieName, secure, sameSite, max, backend }` | 24 h idle, 14 days max, `lax` |
| `limits` | `{ bodyBytes, handlerMs, rate: { limit, windowMs }, sseConnPerIp, backend }` | 64 KB, 10 s, 60/min |
| `trustProxy` | how many `X-Forwarded-For` hops to trust (drives `request.ip`) | `0` |
| `middleware` / `actionMiddleware` | HTTP middleware (Django `MIDDLEWARE`) / around each action | RequestId, AllowedHosts, Security, Cors, GZip |
| `security.headers` | HSTS, CSP, COOP, CORP, Referrer-Policy, Permissions-Policy | on |
| `cors` | `{ origins, methods, credentials, maxAge, routes }` | closed |
| `compression` | gzip / brotli | on, 1 KB threshold |
| `mcp` | `{ tools: 'both', exclude, maxTools }` | 40 typed tools |
| `agent` | `{ shape, budget, rowsL1, inTab }`: the agent snapshot and tab control | `inTab: 'on'` |
| `logging` | `'json' \| 'pretty' \| 'none'` or a Django `LOGGING` object | pretty in dev, json in prod |
| `tasks` | worker lease, poll, grace, result TTL | see [tasks-cache-email.md](tasks-cache-email.md) |
| `caches`, `email` | Django `CACHES`, `EMAIL_*` | memory cache, console mail in dev |
| `redis`, `channels` | shared backends for multi-process deploys | memory |
| `media` | `{ dir, route }` for uploads | `./media`, `/media` |
| `metrics` | Prometheus text at `/tvine/metrics` | off |
| `robots` | the generated `/robots.txt` | allows agent paths |
| `audit` | durable audit trail | off |
| `admin` | `allowIps`, `require2fa`, `idleMs` for staff | off |
| `frontend.boundary` | `tvine check` fails (`'error'`) or warns when a page imports a model | `'error'` |

Backends (memory vs redis) for production: [deploy.md](deploy.md).

## Middleware

`settings.middleware` is Django's `MIDDLEWARE`. Leave it out and you get the safe default list (the first five
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
// or Django-style hooks: processRequest(req, res), processResponse(req, res), processException(req, res, err)
```

`req.tvine` has `path`, `ip`, `https`, `host`, `id`, `locale`, `log`.

**Action middleware** wraps each backend action instead of each HTTP request: `settings.actionMiddleware` (global)
or `apps/<app>/middleware.ts` with `export default [...]` (that app only). It runs after permission checks, so it
cannot skip them. Use it for things like a "shop closed" switch.

## Logging

```ts
logging: 'json'          // or 'pretty' | 'none'. Default: pretty in dev, json in production
logging: {               // or Django LOGGING
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

Read typed values with `env`, like django-environ:

```ts
import { defineSettings, env } from 'tvine'

export default defineSettings({
  trustProxy: env.int('TVINE_TRUST_PROXY', 0),
  allowedHosts: env.list('ALLOWED_HOSTS', []),          // "a.com, .b.com" → ['a.com', '.b.com']
  socket: env.bool('SOCKET', true),                     // 1/0, true/false, yes/no, on/off
  email: { password: env.required('SMTP_PASSWORD') },  // unset → boot error naming the variable
})
```

Also `env.str`, `env.url`, `env.json`, `env.has`. An empty value counts as unset.

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

### `.env` files

Loaded by every `tvine` command when present, first match wins per variable, and a variable already set in the
real environment is never overridden:

1. `.env.<NODE_ENV>.local`
2. `.env.local` (skipped under `NODE_ENV=test`)
3. `.env.<NODE_ENV>`
4. `.env`

In production they load only with `TVINE_LOAD_DOTENV=1`.

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
