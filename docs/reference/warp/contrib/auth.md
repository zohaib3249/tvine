# tvine.auth

## What it is

`tvine.auth` is the built-in users app. It gives you a `User` model,
password hashing and validation, sign-in through session cookies or Bearer API tokens, groups and permissions,
two-factor sign-in (TOTP plus recovery codes), a list of signed-in sessions, mail alerts about account security, and
a data export and erase flow for privacy requests. Every flow is an ordinary action (`auth.login`, `auth.me`…), so
the same code serves pages, `/tvine/api`, MCP tools and agents. Source: `packages/tvine/warp/src/contrib/auth/`.

## Install / enable

```ts
// config/settings.ts
import { defineSettings } from 'tvine'

export default defineSettings({
  installedApps: ['tvine.auth', 'catalog', 'orders'],
})
```

Then run `tvine migrate`. You do not add any middleware: once the app is installed, `request.user` is resolved for
every request (Bearer token first, then the session cookie). The migrate step also creates the
`add / change / delete / view` permission rows for every model of every installed app.

Optional REST paths (every action also answers at `POST /tvine/api/auth.<name>`):

```ts
// config/urls.ts
import { include, path } from 'tvine'
export const urlpatterns = [path('api/auth/', include('tvine.auth.urls'))]
```

## Import

```ts
import { User, getUserModel, extendUser, defineUserModel, createUser, createSuperuser, setPassword, addToGroup, grant,
  authenticate, login, logout, ModelBackend, EmailBackend, AuthUser, privacy } from 'tvine/auth'
import { isAuthenticated, isStaff, isSuperuser, hasPerm, modelPermissions, denyAgents, allOf, anyOf } from 'tvine'
```

The permission helpers (`isAuthenticated`, `isStaff`, `isSuperuser`, `hasPerm`, `modelPermissions`,
`loginRequired`, `permissionRequired`, `userPassesTest`, `staffMemberRequired`) are exported from both `tvine` and
`tvine/auth`.

## The User model

`User` is the model `auth_user`. Its fields are exported as `USER_FIELDS`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `field.id()` | auto | primary key |
| `password` | `field.text({ hidden: true })` | — | encoded hash, `<algorithm>$…`. A value starting with `!` never matches (unusable password). Never sent out. |
| `isActive` | `field.bool` | `true` | inactive users cannot sign in, and have no permissions |
| `isStaff` | `field.bool` | `false` | may use the admin |
| `isSuperuser` | `field.bool` | `false` | has every permission |
| `lastLogin` | `field.datetime({ optional: true })` | `null` | stamped by `login()` |
| `username` | `field.text({ unique: true, searchable: true })` | — | the sign-in name (`usernameField`) |
| `email` | `field.text({ optional: true, index: true })` | `null` | the address for resets and alerts (`emailField`) |
| `firstName` | `field.text` | `''` | |
| `lastName` | `field.text` | `''` | |
| `dateJoined` | `field.datetime({ auto: true })` | now | |

Other tables of the app: `auth_group` (`Group`: `id`, `name` unique), `auth_permission` (`Permission`: `codename`
unique, `app`, `model`, `name`), the join tables `auth_user_groups` (`UserGroup`), `auth_user_permissions`
(`UserPermission`), `auth_group_permissions` (`GroupPermission`), `auth_token` (`Token`), `auth_totp` (`Totp`),
`auth_recovery_code` (`RecoveryCode`), `auth_session` (`UserSession`), `auth_known_device` (`KnownDevice`).

### Methods on a user row

Every row read from the user model has these methods (they are not columns: JSON and `Object.keys` do not see them).

| Method | Returns | Meaning |
|---|---|---|
| `isAuthenticated` / `isAnonymous` | `true` / `false` | getters |
| `getUsername()` | `string` | value of the model's `usernameField` |
| `getFullName()` | `string` | `firstName lastName`, trimmed |
| `getShortName()` | `string` | `firstName` |
| `hasUsablePassword()` | `boolean` | false for `!…` hashes |
| `checkPassword(raw)` | `Promise<boolean>` | re-hashes with the preferred hasher when the stored hash is old |
| `setPassword(raw)` | `Promise<void>` | hashes, saves, revokes the user's API tokens. No validators run. |
| `setUnusablePassword()` | `Promise<void>` | saves `!<uuid>`; revokes tokens |
| `getAllPermissions()` | `Promise<Set<string>>` | codenames from the user and its groups (cached per row) |
| `getGroupPermissions()` | `Promise<Set<string>>` | from groups only |
| `getUserPermissions()` | `Promise<Set<string>>` | same as `getAllPermissions()` |
| `hasPerm(perm, obj?)` | `Promise<boolean>` | see [Permissions](#permissions-and-groups) |
| `hasPerms(perms[], obj?)` | `Promise<boolean>` | all of them |
| `hasModulePerms(app)` | `Promise<boolean>` | any permission starting with `<app>.` |

### `request.user` (`AuthUser`)

In an action, `ctx.request.user` is an `AuthUser` for a signed-in user and `ANONYMOUS` otherwise. It never holds
the password hash.

| Member | Type | Meaning |
|---|---|---|
| `id` | `string` | the user id **as a string** |
| `username`, `name` | `string` | the `usernameField` value |
| `email` | `string \| null` | the `emailField` value |
| `isActive`, `isStaff`, `isSuperuser` | `boolean` | |
| `firstName`, `lastName` | `string` | |
| `extra` | `Record<string, unknown>` | a custom user model's own non-hidden fields; also copied onto the object (`user.phone`) |
| `via` | `'session' \| 'token'` | how the request signed in |
| `scopes` | `string[]` | only on token users |
| `tokenKey` | `string` | only on token users: the token's public key |
| `groups()` | `Promise<string[]>` | group names, sorted |
| `allPermissions()` / `getAllPermissions()` / `getGroupPermissions()` | `Promise<Set<string>>` | |
| `hasPerm` / `hasPerms` / `hasModulePerms` | as on the row | |
| `getUsername()`, `getFullName()` | `string` | |
| `checkPassword(raw)`, `hasUsablePassword()` | `Promise<boolean>` | read the row |
| `row()` | `Promise<row \| undefined>` | the full ORM row, with its methods |
| `claims` | object | `{ username, email, isStaff, isSuperuser, isActive }` |
| `toJSON()` | `SafeUser` | `{ id, username, email, isStaff, isSuperuser, ...extra }` (also `safeUser(u)`) |

## Custom user model (swappable)

Set `settings.auth.userModel` to `'app.Model'` **before the first migrate**. The table is `<app>_<model>`
(`'accounts.User'` → `accounts_user`). Code that needs the user model calls `getUserModel()`, never `User`.

```ts
// config/settings.ts
auth: { userModel: 'accounts.User' }

// apps/accounts/models.ts — keep every built-in field, add your own
import { field } from 'tvine'
import { extendUser } from 'tvine/auth'
export const User = extendUser({ phone: field.text({ optional: true }), marketingOptIn: field.bool({ default: false }) })
```

```ts
// a fully custom model: only the base fields (id, password, isActive, isStaff, isSuperuser, lastLogin) are added
import { defineUserModel } from 'tvine/auth'
export const User = defineUserModel(
  { email: field.text({ unique: true }), displayName: field.text({ default: '' }) },
  { usernameField: 'email', requiredFields: ['displayName'], emailField: 'email' },
)
```

`UserOptions` (second argument of `extendUser` / `defineUserModel`):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | the table from `settings.auth.userModel` | table name; required when `userModel` is not set |
| `usernameField` | `string` | `'username'` | the sign-in field; must be `unique: true` |
| `requiredFields` | `string[]` | `extendUser`: `['email']`; `defineUserModel`: `[]` | asked by `createsuperuser`; must not contain `usernameField` |
| `emailField` | `string \| null` | `'email'` when such a field exists, else `null` | used by resets, alerts, `EmailBackend` |
| `meta` | `ModelMeta` | — | passed to `defineModel` |

`userMeta(model?)` returns `{ usernameField, requiredFields, emailField }` of a user model. The admin registers a
matching `UserAdmin` for a custom model (its own fields go in an "Additional info" fieldset) unless your app's
`admin.ts` registers the model first.

## Creating users (server side)

```ts
createUser(u: NewUser, o?: { settings?: Settings; validate?: boolean }): Promise<UserRow>
createSuperuser(u, o?)                       // createUser with isStaff + isSuperuser true
setPassword(userId: number, raw: string, o?: { settings?; validate?; ctx? }): Promise<void>
addToGroup(userId: number, group: string): Promise<void>          // creates the group if needed
grant(to: { user: number } | { group: string }, codename: string): Promise<void>
```

- `NewUser`: the `usernameField`, `email`, `password`, `isStaff`, `isSuperuser`, `isActive`, plus any field of the
  model. The username is NFKC-normalized and trimmed; a blank email becomes `null`.
- No `password` (or `null`) → an unusable password: the account can only get one through a reset.
- Validators run unless `validate: false`. `settings` picks hashers and validators (defaults without it).
- `setPassword` revokes all API tokens. With `ctx` (the current request) every other session is signed out, the
  current one stays signed in when it is that user's, and a `passwordChanged` mail goes out.
- `grant` throws `not_found` when the codename does not exist (run `tvine migrate` first).

Commands: `tvine createsuperuser [--username u] [--email e] [--noinput]` (with `--noinput` it reads
`TVINE_SUPERUSER_USERNAME`, `TVINE_SUPERUSER_EMAIL`, `TVINE_SUPERUSER_<FIELD>` for other required fields, and
`TVINE_SUPERUSER_PASSWORD`), `tvine changepassword <username>`, `tvine privacy export|erase <user>`.

There is **no built-in sign-up action**. Write your own action that calls `createUser` (and `login` if it should
sign the user in), as in the example below.

## Built-in actions

All ids are `auth.<name>`. "Session only" means a Bearer-token user is refused (`forbidden: sign in with a password
for this`). "Sudo" means: a password typed in this session in the last 10 minutes, or send `password` now.

| Action | Params | Returns | Rules |
|---|---|---|---|
| `auth.login` | `username?` or `email?` (one is required), `password`, `otp?` | `SafeUser` | 10 / min; refused for an agent driving the human's tab |
| `auth.logout` | — | `null` | refused for an agent driving the human's tab |
| `auth.me` | — | `SafeUser \| null` | read only |
| `auth.changePassword` | `oldPassword`, `newPassword` | `null` | signed in, no agents, session only |
| `auth.requestPasswordReset` | `email` | always `null` | 5 / min; never says whether the email exists |
| `auth.resetPassword` | `uid`, `token`, `newPassword` | `null` | 10 / min |
| `auth.sessions` | — | `[{ id, createdAt, lastSeen, ip, device, current }]` | signed in, read only |
| `auth.revokeSession` | `id` (64 hex) | `null` | signed in, session only |
| `auth.logoutOthers` | — | `{ revoked }` | signed in, session only |
| `auth.totpBegin` | `password?` | `{ secret, uri }` (shown once) | signed in, no agents, session only, sudo |
| `auth.totpConfirm` | `otp` | `{ recoveryCodes }` (10, shown once) | signed in, no agents, session only |
| `auth.totpDisable` | `password`, `otp` | `null` | signed in, no agents, session only |
| `auth.createToken` | `name`, `scopes[]`, `expiresInDays?`, `password?` | `{ token, key, name, scopes, expiresAt }` (token shown once) | signed in, no agents, session only, sudo |
| `auth.listTokens` | — | `[{ key, name, scopes, createdAt, expiresAt, lastUsed }]` | signed in, read only |
| `auth.revokeToken` | `key` | `null` | signed in, session only |
| `auth.exportMyData` | — | `{ url }` | signed in, no agents, 2 / hour, a human must confirm |

Error codes you will meet: `invalid_credentials` (wrong user, password or code; never says which), `otp_required`
(2FA is on: send `otp`), `locked` (too many failures), `reauth_required` (sudo: send `password`), `invalid_token`
(bad or expired reset link), `totp_enabled`, `totp_not_pending`, `forbidden`, `human_only`.

`include('tvine.auth.urls')` maps them to: `login/`, `logout/`, `me/`, `password/change/`, `password/reset/`,
`password/reset/confirm/`, `totp/begin/`, `totp/confirm/`, `totp/disable/`, `tokens/` (list + create),
`tokens/<key>/` (DELETE: revoke), `export/`, `sessions/`, `sessions/others/` (DELETE), `sessions/<id>/` (DELETE).

### Login and sessions

`auth.login` runs `authenticate()` over `settings.auth.backends`, then the second factor, then `login()`.
`login(ctx, row)` binds the user id and a hash tied to the password hash to the session, gives the session a new id
(after commit), records a `UserSession` row, stamps `lastLogin` and sets `ctx.request.user`. If a different user was
signed in on this session, its session data is cleared first. `logout(ctx)` clears the session data and rotates its id.

A password change signs out every other session (they are bound to the old hash). Deleting a `UserSession` row
signs that session out on its next request. Session cookie options live in `settings.session` (see the settings
reference).

### Login throttling

Failures are counted in a window, in three tiers. Keys use the lower-cased name as typed (unknown names lock too) and
the IP (IPv6 by /64).

| Tier | Setting | Default | Effect |
|---|---|---|---|
| name + IP | `auth.login.maxFailures` | `5` | that pair is locked |
| IP | `auth.login.ipMaxFailures` | `100` | that IP is locked for every name |
| name, any IP | `auth.login.accountMaxFailures` | `50` | every pair that already failed is refused; a pair with no failures still gets its try |
| window | `auth.login.windowMs` | 15 min | |
| lock time | `auth.login.lockoutMs` | 15 min | |

The counters are per process with `settings.limits.backend: 'memory'` and shared with `'redis'`.

### Password reset

1. `auth.requestPasswordReset({ email })` finds active users with that email (case-insensitive) and a usable
   password. Capped silently at 3 / hour per email + client and 10 / hour per email.
2. After commit it calls `settings.auth.sendPasswordReset(e)` if set, else mails a link: `settings.auth.resetUrl`
   with `{uid}` and `{token}` filled in, or the raw uid and token when `resetUrl` is not set.
3. `auth.resetPassword({ uid, token, newPassword })`. The token is valid for `auth.resetTimeoutMs` (default 1 h) and
   works once (it is bound to the password hash, `lastLogin` and email). All tokens are revoked and all sessions
   signed out.

`makeResetToken(settings, row)` / `checkResetToken(settings, row, token)` are exported for custom flows.

### Two-factor (TOTP)

`auth.totpBegin` → show `uri` as a QR code (or `secret`) → `auth.totpConfirm({ otp })` turns it on and returns 10
recovery codes (`XXXXX-XXXXX`, each works once). From then on `auth.login` answers `otp_required` until `otp` is
sent (a 6-digit code or a recovery code). Codes are RFC 6238 (SHA1, 6 digits, 30 s, ±1 step); a code is accepted once.
The issuer is `auth.totp.issuer`, default `settings.site.name`. The secret is stored AES-256-GCM encrypted under a
key derived from `settings.secret`.

## Authentication backends

```ts
authenticate(ctx: { settings; request?; sid? }, credentials: Record<string, unknown> & { password?: string }): Promise<row | null>
```

Tries each backend of `settings.auth.backends` in order; the first user wins. Bad credentials → `null`; a locked
name/IP throws `DomainError('locked')`. Failures count toward login throttling.

| Entry | Meaning |
|---|---|
| `'tvine.auth.ModelBackend'` (default) | `credentials[usernameField]` (or `username`) + `password` |
| `'tvine.auth.EmailBackend'` | `email` + `password`, case-insensitive; two accounts with one address → no match |
| `'accounts.backends.LdapBackend'` | the `LdapBackend` export of `apps/accounts/backends.ts` |
| an object or class | `{ authenticate(ctx, credentials), getUser?(id) }` (a class is instantiated) |

Unknown or inactive users cost the same hashing time as a real check.

## Bearer API tokens

A token looks like `tvp_<8 chars>_<32 chars>_<6-char checksum>`. Only its sha256 is stored. Send it as
`Authorization: Bearer tvp_…`. A token user is marked as an agent (`request.agent.is = true`), so `denyAgents`
actions refuse it.

| Scope | Allows |
|---|---|
| `'*'` | every action |
| `'read'` | every read-only action |
| `'<app>.*'` | every action of one app (`'orders.*'`) |
| `'<app>.<action>'` | one action (`'orders.place'`) |

Scopes are checked before the action's own permissions. `expiresInDays` defaults to `auth.tokens.defaultDays`
(90) and may not exceed `auth.tokens.maxDays` (365). A password change or reset revokes every token of the user.
An agent on a token sees and revokes only its own token. `tokenUser(settings, token)` resolves a token by hand.

## Permissions and groups

Codenames are `<app>.<action>_<model>`. The model part drops the `<app>_` table prefix: model `catalog_product`
→ `catalog.change_product`. `tvine migrate` creates `add`, `change`, `delete` and `view` for every model.

`hasPerm(perm)` rules: inactive → `false`; active superuser → `true`; otherwise the user's own codenames plus its
groups' codenames. With an object (`hasPerm(perm, obj)`), only `settings.auth.objectPermission(user, perm, obj)`
decides (superusers still pass).

### Guards (permission functions)

Put them in an action's `permissions: [...]`, on a view, or in `settings.guards` (`[{ path, permissions }]`). They
run in order; the first `false` (or throw) refuses with `forbidden`.

| Guard | Passes when |
|---|---|
| `allowAny` | always |
| `isAuthenticated` / `loginRequired` | signed in |
| `isStaff` / `staffMemberRequired` | signed in, active, `isStaff` |
| `isSuperuser` | signed in, active, `isSuperuser` |
| `hasPerm(...codenames)` / `permissionRequired(...)` | active and holds every codename |
| `modelPermissions(Model, { map? })` | generic-view actions: `list`/`get` need only sign-in, `create` → `add`, `update` → `change`, `delete` → `delete`, anything else → `change`; `map` overrides per action name |
| `userPassesTest((user, ctx) => boolean)` | your test returns true |
| `denyAgents` | the request is not agent-marked (also hides the control from agents) |
| `allOf(...g)` / `anyOf(...g)` | all / any pass (short-circuit) |

`permCodename(app, action, modelName)` builds a codename.

## Account alerts (`settings.auth.notify`)

A short mail to the account's address, sent in the background (through `tasks.sendMail` when `tvine.tasks` is
installed). Each kind is on by default whenever `settings.email.backend` is not `'dummy'`.

| Kind | When |
|---|---|
| `newLogin` | sign-in from a browser + OS + network (/24 or /64) not seen before (never on the account's first sign-in) |
| `passwordChanged` | password change or reset |
| `twoFactorDisabled` | `auth.totpDisable` |
| `tokenCreated` | `auth.createToken` |
| `emailChanged` | the admin changed the email (sent to the **old** address) |

`securityNotice(settings, kind, { username, email }, request?)` sends one by hand.

## Privacy: export and erase

Models opt in through their `meta`: `personalData: ['field', …]` (what is exported and blanked) and `onErase:
'delete' | 'anonymize' | (userId) => Promise<void>` (default `'anonymize'`). Only rows with a foreign key to the
user model count.

```ts
privacy.export(userId)            // = exportData: { exportedAt, user, sessions, tokens, <model>: [...] }
privacy.erase(userId, { settings?, request? })   // = eraseData: one transaction
```

Erase anonymizes the user row (`usernameField` → `deleted-<id>`, email and names blanked, password `!`,
inactive, not staff) and deletes its sessions, devices, tokens and 2FA. The admin has an "Erase personal data"
action for users. `auth.exportMyData` writes the JSON as a private media file and returns a signed link valid 24 h
for that user only.

## Settings: `settings.auth.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `user` | `(req) => Promise<TvineUser \| null>` | — | your own resolver ("bring your own auth"); wins over tokens and sessions |
| `userModel` | `'app.Model'` | `'auth.User'` | swappable user model |
| `backends` | `unknown[]` (≥1) | `[ModelBackend]` | see [Authentication backends](#authentication-backends) |
| `hashers` | `PasswordHasher[]` (≥1) | `[scryptHasher()]` | first one hashes; the others still verify and are upgraded on sign-in |
| `validators` | `PasswordValidator[]` | `DEFAULT_VALIDATORS` | see below |
| `login.maxFailures` / `accountMaxFailures` / `ipMaxFailures` | number | `5` / `50` / `100` | throttling tiers |
| `login.windowMs` / `login.lockoutMs` | ms | 15 min / 15 min | |
| `resetTimeoutMs` | ms | `3_600_000` | reset link lifetime |
| `resetUrl` | string | — | `'https://shop.example/reset?uid={uid}&token={token}'` |
| `sendPasswordReset` | `(e: { user, email, uid, token, request }) => unknown` | built-in mail | send the reset yourself |
| `objectPermission` | `(user, perm, obj) => boolean \| Promise<boolean>` | — | per-object permissions |
| `tokens.defaultDays` / `tokens.maxDays` | number | `90` / `365` | API token lifetime |
| `totp.issuer` | string | `site.name` | name shown in authenticator apps |
| `breachCheck` | boolean | `false` | refuse new passwords found in Have I Been Pwned (only 5 hex chars of the SHA-1 leave the server; a network failure lets the password through) |
| `notify.newLogin` / `passwordChanged` / `twoFactorDisabled` / `tokenCreated` / `emailChanged` | boolean | `true` | account alerts |

### Hashers and validators

| Export | Meaning |
|---|---|
| `scryptHasher({ N?, r?, p? })` | default; `N = 2^15`, `r = 8`, `p = 1`; format `scrypt$N$r$p$salt$hash` |
| `pbkdf2Hasher({ iterations? })` | `pbkdf2_sha256$…` format (existing hashes in that format verify as-is); default 600 000, minimum 100 000 |
| `makePassword(raw, settings)` / `checkPassword(raw, encoded, settings)` | `checkPassword` returns `{ ok, upgrade }` |
| `minLength(n = 8)` | too short |
| `numericPassword()` | only digits |
| `commonPassword(list?)` | the built-in 20 000 common passwords, or your list |
| `userAttributeSimilarity(attrs = ['username', 'email'], max = 0.7)` | too close to a user attribute |
| `DEFAULT_VALIDATORS` | `[userAttributeSimilarity(), minLength(8), commonPassword(), numericPassword()]` |
| `validatePassword(raw, settings, user?)` | the list of problems (empty = ok) |

A validator is `(password, user?) => string[]`. Passwords longer than 4096 characters are refused.

## Examples

### 1. Sign-up action for a shop

```ts
// apps/accounts/views.ts
import { z } from 'zod'
import { defineAction, DomainError } from 'tvine'
import { createUser, getUserModel, login, safeUser } from 'tvine/auth'

export const register = defineAction('register', z.object({
  username: z.string().min(3).max(150), email: z.string().email(), password: z.string().min(1).max(4096),
}), async ({ username, email, password }, ctx) => {
  if (await getUserModel().objects.filter({ username }).first()) throw new DomainError('invalid_param', 'that username is taken', 'username')
  const row = await createUser({ username, email, password }, { settings: ctx.settings })   // validators run
  return safeUser(await login(ctx, row))
}, { rate: { limit: 5, windowMs: 60_000 } })
```

### 2. Sign in from a script, then call an action

```bash
curl -s -c jar -b jar -X POST http://localhost:3000/tvine/api/auth.login \
  -H 'content-type: application/json' -d '{"username":"ana","password":"correct horse battery"}'
curl -s -b jar -X POST http://localhost:3000/tvine/api/auth.me -H 'content-type: application/json' -d '{}'
```

### 3. Staff-only and permission-checked actions

```ts
import { z } from 'zod'
import { allOf, hasPerm, isStaff, defineAction } from 'tvine'

export const refund = defineAction('refund', z.object({ orderId: z.number().int() }), async ({ orderId }, ctx) => {
  /* ... */
}, { permissions: [allOf(isStaff, hasPerm('orders.change_order'))] })
```

```ts
// give the "support" group the right once (a script, a migration, a fixture loader)
import { addToGroup, grant } from 'tvine/auth'
await grant({ group: 'support' }, 'orders.change_order')
await addToGroup(userId, 'support')
```

### 4. Sign in by email and keep orders private per user

```ts
// config/settings.ts
auth: {
  backends: ['tvine.auth.EmailBackend', 'tvine.auth.ModelBackend'],
  resetUrl: 'https://shop.example/reset?uid={uid}&token={token}',
  objectPermission: (user, perm, order: any) => perm === 'orders.view_order' && String(order.customerId) === user.id,
}
```

### 5. A read-only API token for a reporting script

```bash
# signed in (cookie jar from example 2), password sent because the login was more than 10 minutes ago
curl -s -b jar -X POST http://localhost:3000/tvine/api/auth.createToken -H 'content-type: application/json' \
  -d '{"name":"reports","scopes":["read"],"expiresInDays":30,"password":"correct horse battery"}'
# then, from the script:
curl -s -X POST http://localhost:3000/tvine/api/orders.list -H 'authorization: Bearer tvp_…' -H 'content-type: application/json' -d '{}'
```

## Gotchas

- `request.user.id` is a **string**; model ids are numbers. Compare with `String(row.userId) === user.id`, or
  `Number(user.id)` for queries.
- Use `getUserModel()` for queries and foreign keys when a custom user model is possible. Pick `userModel` before
  the first migrate.
- `auth.login` with only `email` needs `EmailBackend` (the default `ModelBackend` reads the username field).
- `row.setPassword()` runs no validators and does not keep the current session signed in; use `setPassword(id, raw,
  { ctx })` from `tvine/auth` in actions.
- Token users are agents: `denyAgents` (and so `changePassword`, `createToken`, TOTP actions) refuse them.
- An agent driving a human's browser tab cannot sign that tab in or out (`human_only`); the human presses the button.
- Secrets (`createToken`'s `token`, `totpBegin`'s `secret`, recovery codes) are returned once and never again.
- `requestPasswordReset` always answers `null`, even when nothing was sent.
- With `settings.email.backend: 'dummy'` no alerts or reset mails go out.

## See also

- [../models.md](../models.md): fields, `meta`, foreign keys to the user model
- [../actions.md](../actions.md): `defineAction`, `permissions`, `rate`, `confirm`, `humanOnly`
- [admin.md](admin.md): `UserAdmin`, `GroupAdmin`, staff hardening
- [security.md](security.md): signing, encryption, rate limits
- [email.md](email.md): the mail settings alerts and resets use
- [../../../settings-and-env.md](../../../settings-and-env.md): `settings.session` and every other key
