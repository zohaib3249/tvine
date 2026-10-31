# Settings and environment

One file, `settings.ts` at the app root, configures everything. It is Django's `settings.py`: zod-validated at
boot, with defaults for every key you leave out.

## Minimal

```ts
// settings.ts
import { defineSettings } from '@tvine/warp'

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

Every key, with its exact shape: [design/conventions/settings.md](design/conventions/settings.md).
Backends (memory vs redis): [design/conventions/backends.md](design/conventions/backends.md).

## Environment variables

Read typed values with `env`, like django-environ:

```ts
import { defineSettings, env } from '@tvine/warp'

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

The full table: [design/conventions/env.md](design/conventions/env.md).

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
