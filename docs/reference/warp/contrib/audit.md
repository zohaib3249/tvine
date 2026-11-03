# tvine.audit and securityEvent

## What it is

`tvine.audit` keeps an audit trail: one database row per audited action call (who, how — human, agent, API token,
job —, which action, outcome, redacted params, time taken), plus one row per security event (failed sign-in, lockout,
IP refused…). `securityEvent()` is the one function every security refusal goes through: it always logs on the
`tvine.security` logger and, with audit on, also writes a row. Source: `packages/tvine/warp/src/core/audit.ts`,
`packages/tvine/warp/src/contrib/audit/`.

## Install / enable

Both lines are needed (`audit.enabled` without the app is a boot error):

```ts
// config/settings.ts
export default defineSettings({
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin', 'tvine.audit', 'orders'],
  audit: { enabled: true, actions: 'writes', retentionDays: 180, redact: ['iban'] },
})
```

Run `tvine migrate` (table `audit_entry`). No middleware. Without `enabled: true` nothing is written (security events
are still logged).

## Import

```ts
import { securityEvent } from 'tvine'
import { AuditEntry, VIAS, pruneAudit } from 'tvine/contrib/audit/index'
```

The `tvine/contrib/*` export maps `tvine/contrib/<x>` to `contrib/<x>.js`, so the audit app needs the `/index`
suffix (the same form the repo uses for `contrib/shield/index`).

## What is logged

### Action calls

An action is audited when audit is enabled, the action does not set `audit: false`, and either `actions: 'all'` or
the action is not `readOnly`.

- A call that commits writes its row **inside** the action's transaction (rolled back with it).
- A call that fails with `domain`, `invalid_param`, `human_only`, `stale_bind` or `internal` gets its own row after
  the rollback, `outcome: 'error'`, `code` = the error code (`code:reason` when it has a reason).
- Not audited: rate-limited calls, calls without a session, other stale-state errors.

### Jobs

With `tvine.tasks`, a job that ends `success` or `dead` writes a row: `via: 'job'`, `action: 'task:<task id>'`,
`userId` = who enqueued it, `requestId` = the job id.

### Security events

`action: 'security.<event>'`, `code: <event>`, `outcome: 'ok'` for `info` level, else `'error'`. Written outside
the caller's transaction, so a refused command's rollback keeps it. Events raised by the framework:

| Event | Raised by |
|---|---|
| `login_ok` (info) | `auth.login` success |
| `login_failed` | bad password or 2FA code (`why`) |
| `lockout` | login throttling refused |
| `permission_denied` | a permission refused an action (logged only) |
| `human_only` | an agent called a `humanOnly` action (logged only) |
| `confirm_required` | a confirm was asked (logged only) |
| `rate_limited` | an action or HTTP rate limit hit (logged only) |
| `origin_refused` | a cross-origin command |
| `ip_refused` | `admin.allowIps` (a row each time) / the `IpFilter` middleware (at most one row a minute) |
| `host_refused` | `AllowedHosts` middleware (logged only) |
| `session_revoked`, `sessions_revoked` (info) | `auth.revokeSession`, `auth.logoutOthers` |
| `data_export`, `privacy_erase` (info) | privacy flows |
| `media_private_access` (info) | a private media read, with `settings.media.auditAccess` |
| `bot_refused`, `shield_limiter_error` | bot blocking / tvine.shield (logged only) |
| `shield_rule_saved` | a Shield rule was saved |

"Logged only" = sent to the `tvine.security` logger with `audit: false` (too frequent for rows).

## `AuditEntry` (table `audit_entry`)

| Field | Type | Meaning |
|---|---|---|
| `id` | id | |
| `at` | datetime (auto, indexed) | |
| `userId` | text, optional | user id as text; `null` = anonymous |
| `via` | `'human' \| 'agent' \| 'api-token' \| 'job' \| 'webmcp' \| 'tab'` | `api-token` = a Bearer token user; `tab` = an agent driving the human's tab; `webmcp` = WebMCP |
| `agent` | text, optional | the agent's own name (user agent / MCP client info): **not verified** |
| `agentVerified` | bool | |
| `action` | text (indexed) | action id, `task:<id>` or `security.<event>` |
| `outcome` | `'ok' \| 'error'` | |
| `code` | text, optional | error code / event |
| `params` | json, optional | redacted params |
| `ip` | text | |
| `sidHash` | text, optional | sha256 of the session id (first 32 hex), never the id |
| `ms` | int | duration |
| `requestId` | text | request id (job id for jobs) |
| `cmdId` | text, optional | the command's idempotency id |

Redaction: keys that look secret (`password`, `token`, `secret`, `otp`, `key`, `card`, `cvv`, `sid`, `$confirm`,
`…_url` reset / magic / invite links and more) are replaced, at any depth, plus every key in `audit.redact`
(case-insensitive).

The admin shows `AuditEntry` read-only (no add, change or delete), filterable by `via`, `action`, `outcome`, `at`.

## `securityEvent`

```ts
securityEvent(event: string, fields: Record<string, unknown>, o?: {
  settings?: Settings; request?: Request; sid?: string; level?: 'info' | 'warn'; audit?: boolean
}): void
```

| Option | Default | Meaning |
|---|---|---|
| `settings` | — | needed for the audit row (without it: log only) |
| `request` | — | adds `ip`, `requestId`, `path`, `userId`, `via` |
| `sid` | — | adds `sidHash` |
| `level` | `'info'` for `login_ok`, else `'warn'` | |
| `audit` | `true` | `false` = log only |

## Retention

| Way | Does |
|---|---|
| `tvine audit prune [--days n]` | deletes rows older than `n` days (default `audit.retentionDays`) |
| the `audit.prune` task | daily at 03:00 UTC when `tvine.tasks` is installed and a worker runs with `--beat` |
| `pruneAudit(days?, now?, batch = 5000)` | the same from code; deletes in batches; returns the count |

## Settings: `settings.audit.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | `boolean` | `false` | write rows (needs `'tvine.audit'` installed) |
| `actions` | `'writes' \| 'all'` | `'writes'` | `writes` skips `readOnly` actions |
| `retentionDays` | positive int | `90` | used by prune |
| `redact` | `string[]` | `[]` | extra param names to blank |

Per action: `audit: false` in its rules turns it off.

## Examples

### 1. Raise your own security event

```ts
import { securityEvent } from 'tvine'

if (coupon.usedBy !== null) {
  securityEvent('coupon_reuse', { code: coupon.code }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid })
  throw new DomainError('coupon_used', 'this coupon was already used')
}
```

### 2. Who refunded this order?

```ts
const rows = await AuditEntry.objects.filter({ action: 'orders.refund', outcome: 'ok' }).order('-at').all(20)
```

### 3. Keep a noisy write action out of the trail

```ts
export const recordView = defineAction('recordView', z.object({ id: z.number().int() }), handler, { audit: false })
```

## Gotchas

- `agent` is whatever the client says; trust `via` and `agentVerified`, not the name.
- A committed action's row is part of its transaction: if your handler throws after writing, there is no "ok" row.
- Audit rows are not the admin's `LogEntry` history: `LogEntry` (`admin_logentry`) records admin add / change /
  delete per object; `AuditEntry` records every audited call from any transport.
- With `actions: 'all'` every read is a row: size the table and the retention for it.

## See also

- [auth.md](auth.md): sign-in events and throttling
- [security.md](security.md): what raises the refusals
- [tasks.md](tasks.md): the prune task and job rows
- [../actions.md](../actions.md): `readOnly`, `audit: false`
