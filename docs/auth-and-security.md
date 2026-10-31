# Auth and security

`tvine.auth` is Django's `django.contrib.auth` for Tvine: users, groups, permissions, sessions, password reset,
TOTP 2FA and personal access tokens for agents. On top, Warp ships secure defaults for every request: host
allow-list, CSP and security headers, closed CORS, rate limits, session hardening and an audit trail.

Related: [settings-and-env.md](settings-and-env.md) (keys, middleware, logging), [deploy.md](deploy.md) (production checklist).

## Setup

```ts
// settings.ts
export default defineSettings({
  installedApps: ['tvine.auth'],      // + 'tvine.admin', 'tvine.audit' if you want them
})
```

```bash
pnpm exec tvine migrate
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com \
TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput
```

Run `pnpm exec tvine createsuperuser` without `--noinput` to be prompted. `tvine changepassword <username>`
prompts for a new password. Password validators always run.

## Sign in

Auth is a set of actions, so pages, agents and curl use the same thing. From a browser-style client
(`x-tvine-api: 1`; params go under `params`):

```bash
curl -s -c jar -b jar -X POST http://localhost:4631/tvine/api/auth.login \
  -H 'content-type: application/json' -H 'x-tvine-api: 1' \
  -d '{"params":{"username":"admin","password":"change-me-please-42"}}'
# {"ok":true,"data":{"id":"1","username":"admin","email":"admin@example.com","isStaff":true,"isSuperuser":true}}
```

In a page: `currentUser()` from `tvine/api` (server), `useUser()` (client), or `api.auth.login(...)`.

| Action | What it does |
|---|---|
| `auth.login` | username, password, `otp` when 2FA is on; rotates the session |
| `auth.logout` | clears and rotates the session |
| `auth.me` | the signed-in user, or null |
| `auth.changePassword` | signs out other sessions, revokes the user's tokens |
| `auth.requestPasswordReset` / `auth.resetPassword` | mail a link; always answers ok (no user enumeration) |
| `auth.totpBegin` / `auth.totpConfirm` / `auth.totpDisable` | TOTP 2FA with 10 recovery codes |
| `auth.createToken` / `auth.listTokens` / `auth.revokeToken` | personal access tokens |
| `auth.sessions` / `auth.revokeSession` / `auth.logoutOthers` | your signed-in devices |
| `auth.exportMyData` | a signed download link with your data |

`changePassword`, `totp*` and `createToken` refuse agents. `createToken` and `totpBegin` need "sudo": a sign-in in
the last 10 minutes, or the password again.

## Tokens for agents

A token lets an agent (Claude, a script) act as a user, limited by scopes: `*`, `read`, `<app>.*`, `<app>.<action>`.

```bash
curl -s -b jar -X POST http://localhost:4631/tvine/api/auth.createToken \
  -H 'content-type: application/json' -H 'x-tvine-api: 1' \
  -d '{"params":{"name":"cli","scopes":["read"]}}'
# {"ok":true,"data":{"token":"tvp_0U4Ys1EU_…","key":"0U4Ys1EU","name":"cli","scopes":["read"],"expiresAt":"2027-01-29T…"}}
curl -s -X POST http://localhost:4631/tvine/api/auth.me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'x-tvine-api: 1' -d '{}'
# {"ok":true,"data":{"id":"1","username":"admin",…}}
```

The token is shown once. It is stored hashed, expires after 90 days by default (max 365), and works on HTTP,
`/tvine/api` and `/mcp` (`Authorization: Bearer …`). A token user is always marked as an agent.

## Permissions

DRF-style classes from `tvine`: `allowAny`, `isAuthenticated`, `isStaff`, `isSuperuser`, `denyAgents`,
`hasPerm('app.change_x')`, `modelPermissions(Model)`, `allOf`, `anyOf`. Attach them at four levels (first deny wins):

```ts
// settings.ts — route guards
guards: [{ path: '/account/**', permissions: [isAuthenticated] }],
// apps/<app>/rules.ts — every action of the app
export const permissions = [isAuthenticated]
// a view class: static permissions = [...];   an action: defineAction(..., { permissions: [isStaff] })
```

Per-action rules beyond permissions: `humanOnly` (agents never), `denyAgents`, `confirm` (a signed one-time
confirm token, `by: 'human'` when only the user may say yes), `rate`. See
[frontend-weft.md](frontend-weft.md) for the matching `<HumanOnly>` UI.

`migrate` creates `add / change / delete / view` permission rows for every model, as Django does.

## Security features

Condensed; the full table with every setting is
[models-and-orm.md](models-and-orm.md).

| Area | Protection | Setting | Default |
|---|---|---|---|
| Secrets | `TVINE_SECRET` required in production (32+ chars, rotation list) | `secret` | prod: boot error if missing |
| | Secrets redacted in logs, hooks, audit, inspector | `logging.redact`, `audit.redact` | on |
| Requests | Host allow-list (`ALLOWED_HOSTS`) | `allowedHosts` / `TVINE_ALLOWED_HOSTS` | prod: boot error if empty |
| | HSTS, nonce CSP, COOP, CORP, Referrer-Policy, Permissions-Policy, nosniff | `security.headers.*` | on |
| | CORS | `cors.*` | closed |
| | Body size cap, handler timeout | `limits.bodyBytes`, `limits.handlerMs` | 64 KB, 10 s |
| | Rate limits per action and IP | `limits.rate`, `rules.rate` | 60/min |
| | IP allow / deny lists | `tvine.middleware.IpFilter` | off |
| | `request.ip` only from trusted proxies | `trustProxy` | 0 |
| Sessions | httpOnly cookie, `__Host-` when Secure, SameSite, rotation on login/logout | `session.*` | Secure in prod, Lax |
| | Idle TTL and absolute lifetime | `session.ttlMs`, `session.maxAgeMs` | 24 h, 14 days |
| Auth | scrypt hashing, rehash on login, Django validators + 20k common passwords | `auth.hashers`, `auth.validators` | on |
| | Breach check (Have I Been Pwned, k-anonymity) | `auth.breachCheck` | off |
| | Login throttling and lockout | `auth.login.*` | 5 per 15 min |
| | TOTP 2FA, recovery codes, sudo mode | `auth.totp*` | per user |
| | Mail on new device, password change, 2FA off, new token, email change | `auth.notify.*` | on when mail is set up |
| Admin | Staff IP allow-list, required 2FA, idle timeout | `admin.allowIps`, `admin.require2fa`, `admin.idleMs` | off |
| Actions | `humanOnly`, `denyAgents`, `confirm`, idempotency, atomic requests | `rules.*`, `db.atomicRequests` | per action / on |
| Data | Parameterized SQL only; hidden / writeOnly fields | built in | on |
| | Encrypted fields (AES-256-GCM, key rotation) | `field.encryptedText()`, `encryption.keys` | keys from `secret` |
| | Audit trail | `audit.enabled` + `tvine.audit` | off |
| Privacy | Export my data; erase (anonymize) a user | `Meta.personalData`, `Meta.onErase` | on with tvine.auth |
| Media | Magic-byte sniffing, size cap; private files behind signed links | `defineUpload({ private: true })` | on |
| Outbound | `safeFetch`: no private / loopback / metadata IPs, redirects re-checked | `safeFetch(url, opts)` | 10 s, 5 MB |
| Signing | `signing.dumps / loads`, `Signer`, `TimestampSigner` | `tvine` | — |

What the demo sends on a page (checked with `curl -sI http://localhost:4631/`):

```
referrer-policy: strict-origin-when-cross-origin
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
content-security-policy: default-src 'self'; script-src 'self' … 'nonce-…' 'strict-dynamic'; … object-src 'none'; …
```

## Middleware

`settings.middleware` is a list, like Django's `MIDDLEWARE`. Built-ins: `tvine.middleware.Security`,
`tvine.middleware.AllowedHosts`, `tvine.middleware.Cors`, `tvine.middleware.RequestId`,
`tvine.middleware.GZip`, `tvine.middleware.RateLimit`, `tvine.middleware.IpFilter`. Add your own per app.
The full catalog with options, and custom middleware: [settings-and-env.md](settings-and-env.md#middleware).

## ALLOWED_HOSTS, CSP, CORS

```ts
allowedHosts: ['shop.example.com', '.example.com'],    // or TVINE_ALLOWED_HOSTS=shop.example.com
security: { headers: { csp: { directives: { 'img-src': ["'self'", 'https://cdn.example.com'] } } } },
cors: { origins: ['https://app.example.com'], credentials: true },
trustProxy: 1,                                           // one load balancer in front
```

In development, localhost is allowed. In production an empty host list is a boot error, and an unknown `Host`
gets a 400.

## Audit

Add `tvine.audit` to `installedApps` and set `audit: { enabled: true }`. Writes and security events (logins
lockouts) get a row; secret-looking params are redacted. `actions: 'all'` logs reads too.
`tvine audit prune [--days n]` deletes rows older than `retentionDays` (90). Without the app installed the
command says so and exits.

## Privacy

```bash
pnpm exec tvine privacy export admin          # the user's data as JSON (--output file)
# { "exportedAt": "…", "user": { "id": 1, "username": "admin", … }, "sessions": [ … ] }
```

`tvine privacy erase <user> --yes` anonymizes a user (fields listed in `Meta.personalData`).

## Gotchas

- In dev, without `TVINE_SECRET`, a random secret is used per boot: sessions and encrypted dev data do not survive
  a restart. Put `TVINE_SECRET` in `.env`.
- `POST /tvine/api/<id>` is the frontend's API and counts as a human request. `humanOnly` does not stop it there;
  protect actions with permissions too.
- A token's first MCP call without a sid answers `expired_sid` with a new sid; that is normal, retry with it.
- Login throttling and sessions live in memory by default; with several processes, use Redis
  ([deploy.md](deploy.md)).
- The admin UI does not yet send staff to the 2FA setup page when `admin.require2fa` is on; the API answers
  `two_factor_required`.
