# Settings

Settings are Django's `settings.py`: one object built with `defineSettings({...})`, validated by a zod schema at
boot, with a default for every key you leave out. Objects merge deeply over the defaults; arrays, functions and
plain values replace. Which file is loaded is chosen by `TVINE_SETTINGS` (Django `DJANGO_SETTINGS_MODULE`) or
the `config/settings/{base,dev,prod,local}.ts` layout. A handful of environment variables feed keys directly.
Actions read the result as `ctx.settings`.

**Import:** `import { defineSettings, env, type SettingsInput, type Settings } from 'tvine'`

## Signature

```ts
function defineSettings(input: SettingsInput & { secret?: string | string[] }): Settings
```

`SettingsInput` is a deep-partial `Settings`. Unknown keys inside strict groups (`health`, `redis.<alias>`,
`shield` and its sub-objects, `email`, `metrics`, `robots`, `encryption`, `auth`, `caches.<alias>`, and the
`logging` object form) are a boot error; elsewhere they are ignored by zod. Every named cache is completed from the
cache defaults.

## Which file is loaded

| Situation | Files merged (in order) |
|---|---|
| `TVINE_SETTINGS=config/settings/prod` (or `tvine --settings …`) | that module only (path from cwd, no extension; `.ts`/`.js`/`.mjs`) |
| `config/settings/` exists, `NODE_ENV=production` | `config/settings/prod` |
| `config/settings/` exists, otherwise | `config/settings/dev`, then `config/settings/local` if present (git-ignored) |
| no `config/settings/` | `./settings` (or none) |

Each file's default export is merged over the previous one, then `createAgentServer({ settings })` overrides on
top. `base.ts` is a convention: `dev.ts` / `prod.ts` import it and spread it (`defineSettings({ ...base, debug: true })`).
`.env` files load before settings are read (below).

## Environment variables that feed settings

| Variable | Feeds | Rule |
|---|---|---|
| `TVINE_SECRET` | `secret` | Used when `secret` is not given. Comma list = rotation, newest first. Each ≥ 32 chars, no duplicates. Missing in production → boot fails (at server start, not at import). Dev without it: a random key per boot. |
| `DATABASE_URL` | `db.url` | When `db.url` is not given. Set but blank → error. Default `file:./tvine.db`. |
| `REDIS_URL` | `redis.default.url` | When `redis` is not given. Set but blank → error. |
| `TVINE_ALLOWED_HOSTS` | `allowedHosts` | Comma list, when `allowedHosts` is not given. |
| `TVINE_DEV_ALLOWED_HOSTS` | extra dev hosts | Added by `AllowedHosts` in debug, never in production. |
| `TVINE_DEBUG` | `debug` | When `debug` is not given. Ignored in production if it came from a `.env` file. Unset: `debug` is on for `NODE_ENV` `development` or `test`. |
| `TVINE_SESSION_SECURE` | `session.secure` default | Default: on when `NODE_ENV=production`. |
| `TVINE_ENCRYPTION_KEYS` | `encryption.keys` | Comma list, when `encryption.keys` is not given. |
| `NODE_ENV` | many defaults | `production`: secure cookie, json logging, smtp mail, required secret + hosts, `.env` skipped. `test` / `VITEST`: memory mail. `tvine start` defaults it to `production`. |
| `TVINE_SETTINGS` | which file | See above. |
| `TVINE_LOAD_DOTENV` | `.env` in production | `1` loads `.env` files in production too. |
| `PORT`, `HOST` | listen address (CLI) | Default 3000; `--port` / `--host` win. |
| `TVINE_SUPERUSER_USERNAME` / `_EMAIL` / `_PASSWORD` | `createsuperuser --noinput` | CLI only. |
| `WEB_CONCURRENCY`, `NODE_APP_INSTANCE`, `pm_id` | — | Only read to warn that `memory` backends are per process. |

Two-server mode (a Next server calling a `tvine start --api-only` server) has no settings in the Next process;
it reads `TVINE_API_URL`, `TVINE_SECRET`, `TVINE_TRUST_PROXY`, `TVINE_HEADER`, `TVINE_COOKIE_NAME`,
`TVINE_SESSION_SECURE`, `TVINE_SESSION_SAMESITE`, `TVINE_SESSION_TTL_S` (default 86400).

### `.env` files

Loaded by every `tvine` command, first match per variable wins, never over a variable already set:
`.env.<NODE_ENV>.local`, `.env.local` (skipped under `NODE_ENV=test`), `.env.<NODE_ENV>`, `.env`. Not in
production unless `TVINE_LOAD_DOTENV=1`.

### `env` helpers

`env.str(name, d?)`, `env.int`, `env.bool` (`1/0`, `true/false`, `yes/no`, `on/off`), `env.list` (comma list),
`env.url`, `env.json`, `env.required(name)`, `env.has(name)`. An empty value counts as unset; a missing one without
a default throws naming the variable.

## Every key

### Site and apps

| Key | Type | Default | Meaning |
|---|---|---|---|
| `site.name` | `string` | `'tvine app'` | Shown to agents (`/llms.txt`, MCP server name) and in the admin. |
| `site.description` | `string` | `''` | Same. |
| `siteUrl` | `string?` | unset (the request's Host) | Public origin `https://shop.example` for links the server builds. |
| `installedApps` | `string[]` | `[]` | Project apps `'catalog'` (`apps/catalog/`) and built-ins `'tvine.auth'`, `'tvine.tasks'`, `'tvine.admin'`, `'tvine.audit'`, `'tvine.shield'`. |
| `rootUrlconf` | `string?` | `config/urls`, else `urls` | Root `urls.ts`; must exist when set. |
| `tasksModule` | `string?` | `config/tasks` | Queues / `beatSchedule` for `tvine worker`. |
| `secret` | `string \| string[]` | see `TVINE_SECRET` | HMAC key (binds, forwards, confirm tokens, signing); array = rotation. |
| `debug` | `boolean` | see `TVINE_DEBUG` | Django `DEBUG`: dev CSP, inspector feed, `ServerTiming`, dev hosts, helpful 400s. |
| `frontend.boundary` | `'error' \| 'warn'` | `'error'` | A page importing a model fails `tvine check`, or warns. |
| `encryption.keys` | `string[]` | `[]` (derived from `secret`) | AES-256-GCM keys for encrypted fields, newest first, each ≥ 32 chars, unique. |

### Hosts, proxy, HTTP

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowedHosts` | `string[]` | dev: `['localhost', '.localhost', '127.0.0.1', '[::1]']`; production: required | `'shop.example'`, `'.example.com'` (with subdomains), `'[::1]'`, `'*'`. Empty in production with `AllowedHosts` on → boot error. |
| `dev.allowedHosts` | `string[]` | `[]` | Debug only, on top: `'*.ngrok-free.app'`, `'*.devtunnels.ms'`. |
| `trustProxy` | `number` | `0` | Trusted proxy hops for `X-Forwarded-For` / `-Host` / `-Proto` (drives `request.ip`, https, host). |
| `middleware` | `unknown[]` | `RequestId, AllowedHosts, Security, Cors, GZip` | HTTP middleware; see [middleware.md](./middleware.md). |
| `actionMiddleware` | `Middleware[]` | `[]` | Around every action. |
| `guards` | `{ path, permissions }[]` | `[]` | Permission checks by page path for HTTP, MCP, forms and API calls (by calling page). Glob: `*` one segment, `**` any depth (`/admin/**` covers `/admin`). Denied → `forbidden`. |
| `health.token` | `string?` (≥ 16) | unset | `/tvine/health` details for `Authorization: Bearer <token>`; others get `{ ok }`. |
| `header` | `string` | `'x-tvine'` | The agent request header. |
| `formats.default` | `'json' \| 'notation'` | `'json'` | Agent reply format when `Accept` does not choose. |
| `formats.notationPath` | `boolean` | `true` | Serve `<page>/agent.txt`; `<page>/agent.json` is always served. |
| `socket` | `boolean` | `true` | Accepted; not read in this release. |

### Limits

| Key | Type | Default | Meaning |
|---|---|---|---|
| `limits.bodyBytes` | `number` | `65536` | Max JSON body (and multipart text fields). |
| `limits.handlerMs` | `number` | `10000` | Max time per action handler (and per middleware chain). |
| `limits.rate.limit` | `number` | `60` | Action calls per window per IP + session; also every action's default own rate. |
| `limits.rate.windowMs` | `number` | `60000` | Window. |
| `limits.rate.by` | `'framework' \| 'shield'` | `'framework'` | `'shield'`: requests Shield rate-checked skip the general bucket (needs `tvine.middleware.Shield`). |
| `limits.sseConnPerIp` | `number` | `20` | Open `/tvine/channel` streams per IP. |
| `limits.backend` / `limits.redis` | `'memory' \| 'redis'` / alias | `'memory'` / `'default'` | Rate limits, idempotency, login throttle, tab agent marks. |

### Agents and MCP

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mcp.tools` | `'both' \| 'generic' \| 'typed'` | `'both'` | Generic tools (`read_page`, `expand`, `ui`, `do`, `request_control`, `release`) and/or one typed tool per action. |
| `mcp.exclude` | `string[]` | `[]` | Action-id globs disabled over MCP (`'admin.**'`). A pattern matching nothing logs a warning. |
| `mcp.maxTools` | `number` | `40` | Typed tools above this are trimmed to `priority` actions (rest via `do`); not in `'typed'` mode. |
| `agent.shape` | `'v1' \| 'v2'` | `'v2'` | Snapshot format. |
| `agent.budget` | `number` | `1500` | Token budget for `view=auto`. |
| `agent.rowsL1` | `number` | `10` | List rows at `view=L1`. |
| `agent.inTab` | `'on' \| 'off'` | `'on'` | Agents may control a human's tab. |
| `snapshotCache.ttlMs` | `number` | `60000` | Shared snapshots of non-personal pages; `0` = off; any write clears it. |
| `snapshotCache.backend` / `.redis` | | `'memory'` / `'default'` | |
| `robots.allow` / `disallow` / `extra` | `string[]` | `[]` | Generated `/robots.txt` (only when the app ships none). |
| `robots.sitemap` | `string?` | unset (`/sitemap.xml` if the app has one) | Absolute URL. |

### Database

| Key | Type | Default | Meaning |
|---|---|---|---|
| `db.url` | `string` | `DATABASE_URL`, else `'file:./tvine.db'` | `file:`, `postgres://`, `mysql://`; relative to cwd. |
| `db.pool.max` / `acquireMs` / `idleMs` | `number` | `10` / `5000` / `30000` | Pool. |
| `db.atomicRequests` | `boolean` | `true` | Each non-`readOnly` action is one transaction (opt out per action: `rules.atomic: false`). |
| `db.slowQueryMs` | `number` | `500` | Slower statements logged on `tvine.db`; `0` = off. |
| `data.defaultPageSize` / `maxPageSize` | `number` | `25` / `100` | Accepted; not read in this release (views use their own `pageSize` / `maxPageSize`). |

### Sessions, channels, Redis

| Key | Type | Default | Meaning |
|---|---|---|---|
| `session.ttlMs` | `number` | `86400000` (24 h) | Idle timeout; also the cookie `Max-Age`. |
| `session.maxAgeMs` | `number` | `1209600000` (14 days) | Absolute lifetime; `0` = none. |
| `session.cookieName` | `string` | `'tvine_s'` | `__Host-` is prepended when `secure` (unless the name starts with `__`). |
| `session.secure` | `boolean` | production: `true` (`TVINE_SESSION_SECURE`) | Cookie `Secure`. |
| `session.sameSite` | `'lax' \| 'strict' \| 'none'` | `'lax'` | `'none'` needs `secure`. |
| `session.max` | `number` | `100000` | Live sessions per process (LRU). |
| `session.backend` / `.redis` | | `'memory'` / `'default'` | |
| `channels.backend` / `.redis` | | `'memory'` / `'default'` | Pub/sub fan-out and `Last-Event-ID` replay. |
| `redis.<alias>.url` | `string` | `default` from `REDIS_URL` | `redis://` or `rediss://`. |
| `redis.<alias>.tls` / `prefix` / `connectTimeoutMs` | | unset | TLS, key prefix (≤ 64, no spaces / globs), connect timeout. |

A `'redis'` backend whose alias is not configured fails at boot, naming the key.

### Media, caches, email, tasks

| Key | Type | Default | Meaning |
|---|---|---|---|
| `media.dir` / `route` | `string` | `'./media'` / `'/media'` | Upload storage and URL prefix. |
| `media.auditAccess` | `boolean?` | unset | Audit row per private-file read. |
| `caches.<alias>.backend` | `'memory' \| 'redis' \| 'file' \| 'dummy'` | `default`: `'memory'` | |
| `caches.<alias>.timeout` | `number \| null` (s) | `300` | `null` = forever. |
| `caches.<alias>.keyPrefix` / `version` / `maxEntries` | | `''` / `1` / `300` | |
| `caches.<alias>.redis` / `location` | | `'default'` / unset | `location` required for `'file'`. |
| `email.backend` | `'console' \| 'smtp' \| 'file' \| 'memory' \| 'dummy'` | dev `'console'`, tests `'memory'`, production `'smtp'` | |
| `email.host` / `port` / `user` / `password` | | `'localhost'` / `25` / `''` / `''` | SMTP. |
| `email.useTls` / `useSsl` / `allowPlainAuth` / `timeoutMs` | | `false` / `false` / `false` / `10000` | `useTls` and `useSsl` exclusive. |
| `email.defaultFrom` / `serverEmail` / `admins` / `subjectPrefix` / `filePath` | | `'webmaster@localhost'` / `'root@localhost'` / `[]` / `'[Tvine] '` / `'./mail'` | |
| `tasks.broker` | `'db' \| 'file' \| 'memory' \| 'redis'` | unset (`'file'`) | Job store. |
| `tasks.leaseMs` / `pollMs` / `relayMs` / `graceMs` / `resultTtlMs` | `number` | `30000` / `500` / `250` / `30000` / `86400000` | |
| `tasks.file` / `durable` / `claimBatch` / `redis` | | `'./tasks.db'` / `false` / `10` / `'default'` | |

### Security

| Key | Type | Default | Meaning |
|---|---|---|---|
| `security.headers.enabled` | `boolean` | `true` | |
| `security.headers.hsts` | `false \| { maxAge, includeSubDomains, preload }` | `{ 31536000, true, false }` | https only; `preload` needs maxAge ≥ 1 year and subdomains. |
| `security.headers.csp` | `false \| { reportOnly, directives, reportUri, staticPages }` | `{ false, {}, '/tvine/csp-report', 'relaxed' }` | `directives` add over built-ins (`false` drops one). |
| `security.headers.referrerPolicy` | enum | `'strict-origin-when-cross-origin'` | |
| `security.headers.coop` / `corp` | enum or `false` | `'same-origin'` / `'same-origin'` | |
| `security.headers.coep` | `false \| 'require-corp' \| 'credentialless'` | unset | |
| `security.headers.trustedTypes` | `false \| 'report-only'` | unset | |
| `security.headers.permissionsPolicy` | `Record<feature, string[] \| false>` | camera, microphone, geolocation, payment, usb, display-capture, browsing-topics, clipboard-read: `[]` | |
| `cors.origins` | `(string \| RegExp)[]` | `[]` (closed) | Exact origin, `'*'` (not with credentials), anchored RegExp. |
| `cors.methods` | `string[]` | `['GET', 'POST']` | |
| `cors.allowHeaders` | `string[]` | content-type, authorization, x-tvine, x-tvine-sid, x-tvine-view, x-tvine-expand, x-tvine-offset, x-tvine-limit, mcp-protocol-version, mcp-session-id, last-event-id | |
| `cors.exposeHeaders` | `string[]` | x-request-id, etag, retry-after, mcp-session-id | |
| `cors.credentials` / `maxAge` | | `false` / `600` | |
| `cors.routes` | `({ path } & Partial<policy>)[]` | `[]` | Per-path overrides. |
| `compression.enabled` / `threshold` / `brotli` / `gzipLevel` / `brotliQuality` | | `true` / `1024` / `true` / `6` / `4` | |
| `audit.enabled` / `actions` / `retentionDays` / `redact` | | `false` / `'writes'` / `90` / `[]` | Needs `'tvine.audit'` installed. |
| `metrics.enabled` / `path` / `token` / `allowIps` | | `false` / `'/tvine/metrics'` / unset / `[]` | Neither token nor IPs = loopback only. |
| `shield.*` | object | `mode: 'log'`, `prefix: '/tvine/shield'`, `clearance.ttl: '30m'`, … | Bot protection; needs `'tvine.shield'` and the `Shield` middleware. Full list in the Shield docs. |

### Admin, logging, auth

| Key | Type | Default | Meaning |
|---|---|---|---|
| `admin.path` | `string` | `'/admin'` | |
| `admin.title` | `string?` | unset (the admin site's title) | |
| `admin.theme` | `{ brand?, radius?, dark }` | `{ dark: 'auto' }` | |
| `admin.allowIps` / `require2fa` / `idleMs` | | unset | IP allow-list (adds an `IpFilter`), TOTP for staff, staff idle timeout. |
| `admin.dashboard` | `{ widgets, autoCharts }` | `{ [], true }` | |
| `admin.stats` | object | `{ enabled: true, retentionDays: 30, flushMs: 60000, searches: { enabled: true, minCount: 3 }, pages: { enabled: true, keepParams: [] } }` | |
| `logging` | `'json' \| 'pretty' \| 'none' \| { level, format, handlers, loggers, redact }` | dev `'pretty'`, production `'json'` | Handler types `console`, `file`, `custom`, `memory`. |
| `auth.user` | `(req) => Promise<TvineUser \| null>` | unset | BYO resolver, overrides everything. |
| `auth.userModel` | `'app.Model'` | `'auth.User'` | |
| `auth.backends` | `unknown[]` | `['tvine.auth.ModelBackend']` | |
| `auth.hashers` / `validators` | | built-in | |
| `auth.login` | `{ maxFailures, accountMaxFailures, ipMaxFailures, windowMs, lockoutMs }` | `5` / `50` / `100` / 15 min / 15 min | |
| `auth.resetTimeoutMs` / `resetUrl` / `sendPasswordReset` | | 1 h / built-in / built-in | |
| `auth.objectPermission` | function | unset | |
| `auth.tokens` | `{ defaultDays, maxDays }` | `90` / `365` | |
| `auth.totp.issuer` / `breachCheck` / `notify.*` | | — / `false` / on when mail is configured | See [contrib/auth.md](./contrib/auth.md). |

## Cross-key checks (boot errors)

| Check | Message gist |
|---|---|
| `audit.enabled` without `'tvine.audit'` in `installedApps` | needs `tvine.audit` |
| `tvine.middleware.Shield` listed without `'tvine.shield'` installed | needs `tvine.shield` |
| `limits.rate.by: 'shield'` without the Shield middleware | needs `tvine.middleware.Shield` |
| `session.sameSite: 'none'` without `session.secure` | needs secure |
| `email.useTls` and `email.useSsl` both on | mutually exclusive |
| a `'file'` cache without `location` | needs location |
| a `'redis'` backend whose `redis` alias is missing | names the key |
| production, `AllowedHosts` on, `allowedHosts` empty | list your domains |

`tvine check` also warns when Shield's rules and `limits.rate` are both general rate limits.

## Examples

### 1. Layout: base + dev + prod

```ts
// config/settings/base.ts
import type { SettingsInput } from 'tvine'
export const base = {
  site: { name: 'Hat Shop', description: 'Hats, scarves and gloves.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin', 'catalog', 'cart', 'orders'],
  mcp: { exclude: ['admin.**'] },
} satisfies SettingsInput

// config/settings/dev.ts
import { defineSettings } from 'tvine'
import { base } from './base.ts'
export default defineSettings({ ...base, debug: true, dev: { allowedHosts: ['*.ngrok-free.app'] } })

// config/settings/prod.ts
import { defineSettings, env } from 'tvine'
import { base } from './base.ts'
export default defineSettings({
  ...base,
  trustProxy: 1,
  session: { backend: 'redis' }, limits: { backend: 'redis' }, channels: { backend: 'redis' },
  middleware: ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Security',
    'tvine.middleware.Cors', 'tvine.middleware.GZip', 'tvine.middleware.SslRedirect'],   // arrays replace: list all
  email: { host: env.str('SMTP_HOST'), password: env.required('SMTP_PASSWORD') },
})
```

### 2. Run with a specific module

```bash
TVINE_SETTINGS=config/settings/prod TVINE_SECRET=$(openssl rand -hex 32) \
  TVINE_ALLOWED_HOSTS=shop.example.com DATABASE_URL=postgres://… REDIS_URL=redis://… pnpm exec tvine start
```

### 3. Reading settings in an action

```ts
export const shopInfo = defineAction('shopInfo', z.object({}),
  async (_p, ctx) => ({ name: ctx.settings.site.name, pageSize: 24 }), { readOnly: true })
```

## Gotchas

- Arrays replace, they do not merge: setting `middleware` drops the defaults you do not list again.
- `secret` problems surface at server start (`loadSettings`), not when `settings.ts` is imported (so `next build`
  can import it without a secret).
- `TVINE_DEBUG` from a `.env` file is ignored in production; set it in the real environment.
- `allowedHosts` defaults to localhost only outside production; in production you must set it.
- `session.cookieName` changes to `__Host-…` when `secure` is on; clients reading the cookie by name must use that.
- `data.*` and `socket` are accepted but unused.

## See also

[middleware.md](./middleware.md) · [request.md](./request.md) · [actions.md](./actions.md) · [urls.md](./urls.md) ·
[contrib/auth.md](./contrib/auth.md) · [overview.md](./overview.md)
