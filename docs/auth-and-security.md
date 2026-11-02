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

## Custom user model

Like Django's `AUTH_USER_MODEL`. Pick it **before the first `tvine migrate`**: tvine.auth's tables point at it.
Changing it later makes `tvine check` and `tvine migrate` fail with "settings.auth.userModel changed after
tvine.auth was migrated"; start from a fresh database, or move the users with a hand-written data migration.

```ts
// apps/accounts/models.ts — AbstractUser: every built-in field (username, email, password, firstName, lastName,
// isActive, isStaff, isSuperuser, lastLogin, dateJoined) plus yours
import { field } from 'tvine'
import { extendUser } from 'tvine/auth'
export const User = extendUser({ phone: field.phone({ optional: true }) }, { requiredFields: ['email', 'phone'] })
```

```ts
// config/settings/base.ts
auth: { userModel: 'accounts.User' },   // 'app.Model'; the default is 'auth.User'
```

The table is `accounts_user` (Django's default name). `auth_user` is never created. Fully custom
(AbstractBaseUser), e.g. sign-in by email with no username:

```ts
export const User = defineUserModel(
  { email: field.email({ unique: true }), fullName: field.text({ default: '' }) },
  { usernameField: 'email', requiredFields: ['fullName'] },   // id, password, isActive, isStaff, isSuperuser, lastLogin are added
)
```

Everything that touches users reads `getUserModel()`: sessions, tokens, groups and permissions, TOTP, password reset
(by the model's `email` field), privacy export/erase, the admin's history and `UserAdmin` (your extra fields go into
an "Additional info" fieldset), `auth.me` (your non-hidden extra fields are included), and `createsuperuser`. That
command asks for the `usernameField` and each `requiredFields` entry. With `--noinput` it reads
`TVINE_SUPERUSER_USERNAME`, `TVINE_SUPERUSER_<FIELD>` (e.g. `TVINE_SUPERUSER_PHONE`) and `TVINE_SUPERUSER_PASSWORD`.
To point your own models at the user, use `field.fk(getUserModel)`.

## Authentication backends

Like Django's `AUTHENTICATION_BACKENDS`. They're tried in order, and the first one that returns a user wins:

```ts
auth: { backends: ['tvine.auth.ModelBackend', 'tvine.auth.EmailBackend', 'accounts.backends.LdapBackend'] }
```

- `tvine.auth.ModelBackend` (the default): the `usernameField` (or `username`) plus the password.
- `tvine.auth.EmailBackend`: `email` (any case) plus the password.
- A dotted path is a named export of `apps/accounts/backends.ts` (or `<project>/accounts/backends.ts`), resolved at
  boot like middleware. You can also pass the object or class itself.

`authenticate(ctx, credentials)` returns the user row or `null`. It never throws for bad credentials. Unknown and
inactive users cost the same hashing as a real check. Failures are throttled, and a locked account throws `locked`.
`auth.login` takes `{ username | email, password, otp? }` and runs `authenticate()` and then `login()`.

The shape of an OAuth or LDAP backend:

```ts
// apps/accounts/backends.ts
import { getUserModel } from 'tvine/auth'
export class LdapBackend {
  async authenticate(ctx, { username, password }) {
    if (!(await ldapBind(username, password))) return null      // your directory check
    const User = getUserModel()
    return (await User.objects.filter({ username }).first()) ?? null   // or create the row on first sign-in
  }
  async getUser(id) { return (await getUserModel().get(id)) ?? null }
}
```

An OAuth backend is the same shape: `authenticate(ctx, { provider, code })` exchanges the code, then finds or creates
the user.

## User methods

User-model rows from the ORM, and `ctx.request.user` for a signed-in user, have Django's methods:

```ts
const u = await getUserModel().objects.filter({ username: 'ann' }).first()
await u.checkPassword('…')          // true / false (rehashes on an older hasher)
await u.setPassword('…')            // hashes, saves, revokes the user's API tokens
await u.setUnusablePassword(); u.hasUsablePassword()
await u.hasPerm('notes.change_note'); await u.hasPerms(['a.x', 'a.y']); await u.hasModulePerms('notes')
await u.getAllPermissions(); await u.getGroupPermissions()
u.getFullName(); u.getUsername(); u.isAuthenticated; u.isAnonymous
```

The methods are not enumerable, so JSON, spreads and `Object.keys` still see a plain row. `ctx.request.user` is
always set. Signed out, it's `ANONYMOUS` (`isAuthenticated: false`, `isAnonymous: true`). Signed in, it's an
`AuthUser` with the same permission methods, `getFullName()`, your extra fields (`user.phone`), and
`checkPassword()` / `row()` (these read the row; the hash is never kept on the request).

## Protecting views

```ts
import { loginRequired, permissionRequired, staffMemberRequired, userPassesTest } from 'tvine'

export const notes = defineAction('notes', z.object({}), handler, { permissions: [loginRequired] })
export const edit = defineAction('edit', schema, handler, { permissions: [permissionRequired('notes.change_note')] })
export const report = defineAction('report', z.object({}), handler, { permissions: [staffMemberRequired] })
export const local = defineAction('local', z.object({}), handler, { permissions: [userPassesTest((u) => u.isAuthenticated && String(u.claims?.email).endsWith('@corp.com'))] })
```

These are permissions, so they also work in a view's `permissions` and on `@action`. They're built on
`isAuthenticated` / `hasPerm` / `isStaff`.

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

## Bot protection (tvine.shield)

Cloudflare-style protection built in: every request gets signals (IP range, country/ASN, datacenter, Tor, browser
header consistency, verified bots), a score from 1 (bot) to 99 (human), and your rules decide: pass, challenge,
block or rate-limit. Real people pass an invisible check once and get a signed pass cookie.

```ts
installedApps: [..., 'tvine.shield'],
middleware: ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Shield', ...],
shield: { mode: 'log' },   // 'log' (default) records what it would do; 'enforce' acts; 'off'
```

Then `tvine migrate`. Start in `log` mode and watch the `/shield` panel (superusers only by default), then switch to
`enforce`.

Out of the box (editable in /shield → Rules, "reset" restores them):

| Who | What happens |
|---|---|
| Spoofed bots (Googlebot UA that fails reverse DNS) | blocked |
| Verified search engines | allowed |
| AI agents acting for a user (Claude-User, ChatGPT-User…, Tvine API tokens, Web Bot Auth agents from `shield.webBotAuth.directories`) | allowed |
| Scanners (sqlmap, nikto…) | blocked |
| AI crawlers (GPTBot, ClaudeBot, CCBot…) | challenged |
| More than 300 requests a minute from one IP | 429 |
| Score below 30 on a page | challenged |

- Agent paths (`/mcp`, `/tvine/*`, `/.well-known/*`, `/llms.txt`) never get an HTML challenge: a JSON 403/429.
- Every response carries `tvine-ray` (look it up in /shield → Events), `tvine-shield` (`pass`, `challenge`, `block`, or
  `would-…` in log mode) and `Server-Timing: shield;dur=…`.
- Custom rules in code: `import { shield } from 'tvinejs/contrib/shield/index'` then
  `shield.registerRule('vip', (req, s) => s.country === 'IS' ? { type: 'allow' } : undefined)`; pick it in the panel.
- Country / ASN: run the `shield.ipdb_update` task (or "update now" in Settings) to download DB-IP Lite (monthly,
  CC BY 4.0). Without it those signals are empty. AI-crawler IP ranges and Tor exits: `shield.ranges_update` (daily).
- Locked out? `tvine shield mode off` or `tvine shield rules disable --all` (running servers pick it up within 3 s). The
  panel, the admin and sign-in are never challenged.
- Behind a proxy, set `trustProxy`; TLS fingerprints come only from `shield.tlsHeader` through a trusted proxy.
- Who may open /shield: Settings → Panel access, a condition on the user (`isStaff eq true`, `groups contains
  security`, any custom user field). Every shield.* action re-checks it, plus the admin hardening (allowIps, 2FA).
- What is stored: only blocks/challenges and a 1% sample of passes (or everything with `events.logAll`), no query
  strings, cookies, auth headers or bodies. Charts come from hourly rollups. Old data is pruned by the
  `shield.cleanup` task (needs `tvine.tasks` + a beat).

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
