# Security features

## What it is

The security toolbox that ships in the `tvine` package: signed tokens (`signing`),
encrypted model fields with key rotation, `safeFetch` (outbound HTTP that cannot reach private networks), the
response headers and CSP, rate limits, and the agent controls `humanOnly`, `confirm` and `denyAgents`. Bot
protection is a separate app, Shield: see [../../../shield.md](../../../shield.md). Source:
`packages/tvine/warp/src/security/`, `src/core/confirm.ts`, `src/data/fields/encrypted.ts`.

## Install / enable

Nothing to install. You need a secret: `TVINE_SECRET` (at least 32 characters; production refuses to boot without
it). Headers come from `tvine.middleware.Security`, which is in the default `settings.middleware`.

```bash
export TVINE_SECRET=$(openssl rand -hex 32)
# rotation: new key first, old keys after; everything signed with the old keys still verifies
export TVINE_SECRET="$NEW_SECRET,$OLD_SECRET"
```

## Import

```ts
import { signing, dumps, loads, Signer, TimestampSigner, BadSignature, SignatureExpired, configureSigning,
  safeFetch, isPrivateAddress, SafeFetchError, field, denyAgents } from 'tvine'
```

## Signing

Signed values are tamper-proof, **not secret** (the payload is readable base64). They are signed with the first
`settings.secret` key and verified against every key, in constant time.

```ts
dumps(obj: unknown, { salt?, compress?, key? }): string
loads<T>(token: string, { salt?, maxAge?, key? }): T        // throws BadSignature / SignatureExpired
```

| Option | Default | Meaning |
|---|---|---|
| `salt` | `'tvine.signing'` | a purpose name: a token made with one salt never verifies under another |
| `compress` | `false` | deflate the JSON when that is shorter |
| `maxAge` | none | seconds; older → `SignatureExpired` |
| `key` | `settings.secret` | sign / verify with your own key or key list |

```ts
new Signer({ key?, salt = 'tvine.signing.Signer', sep = ':' })      // .sign(v) → 'v:sig'  .unsign(s) → v  .signature(v)
new TimestampSigner({ key?, salt = 'tvine.signing.TimestampSigner', sep? })   // .sign(v) → 'v:ts:sig'  .unsign(s, { maxAge? })
```

`sep` may not be a base64url character. `SignatureExpired` extends `BadSignature`. In scripts and tests without a
running server, call `configureSigning({ secret })` first (otherwise "settings are not loaded").

## Encrypted fields

```ts
field.encrypted({ of?: 'text' | 'json', deterministic?, context?, bindAs?, bindRow?, hidden?, optional? })
field.encryptedText(opts?)   // of: 'text'
field.encryptedJson(opts?)   // of: 'json'
```

| Option | Default | Meaning |
|---|---|---|
| `of` | `'text'` | `'text'` stores a string, `'json'` any JSON value |
| `deterministic` | `false` | adds a `<name>Hash` column (HMAC) so `eq`, `ne` and `in` filters work; no other lookups ever |
| `context` | `'default'` | key separation: different contexts derive different keys |
| `bindAs` | `'<model>.<field>'` | the name the ciphertext is bound to; set it to keep reading after renaming the model or field |
| `bindRow` | `false` | also bind to the row's pk (a copied value does not decrypt on another row); needs a uuid pk, and writes must name the row (`create`, `Model.update`, `filter({ pk }).update`) |
| `hidden` | `true` | left out of admin forms, generic views and agent output; `hidden: false` shows it |

Not allowed: `unique`, `index`, `searchable`, `default`. Values are AES-256-GCM with a random nonce
(`e2.<key id>.<data>`), bound to `model.field`.

Keys: `settings.encryption.keys` (newest first; each ≥ 32 chars; from `TVINE_ENCRYPTION_KEYS`, comma-separated,
when not set in code), then keys derived from every `settings.secret`. New values use the first key; reading
finds the key by its id. To rotate: put the new key first, keep the old ones, run `tvine encryption rotate`
(re-saves every encrypted field under the newest key, 100 rows per transaction, safe to re-run), then remove the
old key.

## `safeFetch`

For URLs that come from users (webhooks, link previews, image import). Returns a standard `Response`.

```ts
safeFetch(url: string | URL, opts?: SafeFetchOpts): Promise<Response>   // throws SafeFetchError
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `method` | `string` | `'GET'` | |
| `headers` | `Record<string, string>` | — | dropped on a redirect to another origin when they are `authorization`, `cookie` or secret-named |
| `body` | `string \| Buffer` | — | |
| `timeoutMs` | `number` | `10_000` | whole request including redirects |
| `maxBytes` | `number` | 5 MB | response body cap |
| `maxRedirects` | `number` | `3` | each redirect is checked again |
| `allowHosts` | `string[]` | any | only these hosts; `'.example.com'` = with subdomains |
| `allowPrivate` | `boolean` | `false` | skip the address check (tests, intranet); scheme, size and time limits stay |

Only `http:` / `https:`. The host is resolved once and the socket connects to that checked address. Refused:
loopback, private, link-local, cloud metadata (`169.254.169.254`), CGNAT, multicast, reserved, IPv6 ULA / link-local,
IPv4-mapped forms of those. `SafeFetchError.code`: `blocked_scheme`, `blocked_host`, `blocked_address`,
`too_many_redirects`, `timeout`, `too_large`, `network`. `isPrivateAddress(ip)` is the check on its own.

## Response headers and CSP (summary)

`tvine.middleware.Security` sets, on every response: `x-content-type-options: nosniff`, `referrer-policy`,
`cross-origin-opener-policy`, `cross-origin-resource-policy`, `origin-agent-cluster: ?1`,
`x-permitted-cross-domain-policies: none`, `x-xss-protection: 0`, `permissions-policy`, HSTS, `x-frame-options` (when
`frame-ancestors` is `'self'` or `'none'`), and a CSP: pages get a per-request nonce policy, JSON responses
`default-src 'none'; frame-ancestors 'none'`, media `default-src 'none'; sandbox`.

| `settings.security.headers.*` | Default | Meaning |
|---|---|---|
| `enabled` | `true` | |
| `hsts` | `{ maxAge: 31_536_000, includeSubDomains: true, preload: false }` or `false` | `preload` needs maxAge ≥ 1 year and includeSubDomains |
| `csp.directives` | `{}` | replace single directives (`{ 'img-src': ["'self'", 'https://cdn.shop.example'] }`); `false` drops one |
| `csp.reportOnly` | `false` | send `content-security-policy-report-only` |
| `csp.reportUri` | `'/tvine/csp-report'` or `false` | |
| `csp.staticPages` | `'relaxed'` | prerendered HTML has no nonce: `'relaxed'` allows inline scripts there, `'strict'` does not |
| `csp` | | `false` = no CSP |
| `referrerPolicy` | `'strict-origin-when-cross-origin'` | |
| `coop` / `corp` | `'same-origin'` / `'same-origin'` | `false` = not sent |
| `coep` | not sent | `'require-corp' \| 'credentialless'` |
| `permissionsPolicy` | camera, microphone, geolocation, payment, usb, display-capture, browsing-topics, clipboard-read all `[]` (off) | `{ feature: ['self' \| '*' \| origin] \| false }` |
| `trustedTypes` | not sent | `'report-only'` adds a Trusted Types report-only policy |

The default page policy: `default-src 'self'; script-src 'self' (+nonce); style-src 'self' 'unsafe-inline'; img-src
'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action
'self'; frame-ancestors 'self'`. The full settings list is in [../../../settings-and-env.md](../../../settings-and-env.md).

## Rate limiting

Token buckets, refilled on use. Every action call takes a token from:

1. the client IP's bucket: `limits.rate.limit` per **5 ×** `limits.rate.windowMs` (IPv6 grouped by /64);
2. the session's bucket: `limits.rate` — or, when the action has its own `rate`, a separate bucket per session +
   action with that rate.

A refused call answers `rate_limited` with a retry time (HTTP 429, `retry-after`).

| `settings.limits.*` | Default | Meaning |
|---|---|---|
| `rate.limit` | `60` | calls per window |
| `rate.windowMs` | `60_000` | |
| `rate.by` | `'framework'` | `'shield'`: a request Shield already rate-checked (enforce mode, a rate rule matched) skips this general bucket; actions' own `rate` still apply. Needs `tvine.middleware.Shield` in `settings.middleware` (boot error otherwise). |
| `backend` | `'memory'` | `'redis'` shares buckets (and login throttling) across servers |
| `redis` | `'default'` | connection alias |
| `bodyBytes` | `65_536` | request body cap (413 above) |
| `handlerMs` | `10_000` | action handler time limit |
| `sseConnPerIp` | `20` | open event streams per IP |

Per action: `defineAction(name, params, fn, { rate: { limit: 5, windowMs: 60_000 } })`. Uploads default to 5 / min.
With Shield's rate rules on and `by: 'framework'`, both limits apply and the lower one answers first (`tvine check`
warns).

## Agent controls

| Rule | Where | Effect |
|---|---|---|
| `humanOnly: true \| 'reason'` | action rules | every agent-marked request (MCP, agent HTTP, an agent in the tab, WebMCP, API tokens) gets `human_only`; checked before anything else; no typed MCP tool |
| `confirm: true \| { message?, by?: 'anyone' \| 'human' } \| (params, ctx) => rule \| undefined` | action rules | the first call runs nothing and answers `confirm_required` with a single-use token (bound to session, action and params, 120 s). The same call again with `params.$confirm = token` runs. `by: 'human'`: an agent gets no token; only the human can confirm. |
| `denyAgents` | `permissions` | agent-marked requests are `forbidden`; widgets bound to the action show no control to agents |
| `humanOnly` on a field | `field.text({ humanOnly: 'reason' })` | an agent request that **changes** that field (admin, generic views) gets `human_only` |
| `ModelAdmin.agents` | admin | `false` / `'confirm'`, see [admin.md](admin.md) |

## Examples

### 1. An unsubscribe link that cannot be forged

```ts
import { dumps, loads, BadSignature } from 'tvine'

const token = dumps({ userId: user.id, list: 'deals' }, { salt: 'shop.unsubscribe' })
const link = `https://shop.example/unsubscribe?t=${encodeURIComponent(token)}`

// in the unsubscribe action
try {
  const { userId, list } = loads<{ userId: string; list: string }>(t, { salt: 'shop.unsubscribe', maxAge: 30 * 86_400 })
} catch (e) {
  if (e instanceof BadSignature) throw new DomainError('invalid_token', 'this link is invalid or expired')
  throw e
}
```

### 2. Store a customer's tax id encrypted, still findable

```ts
export const Customer = defineModel('billing_customer', {
  id: field.id(),
  taxId: field.encryptedText({ deterministic: true, optional: true }),
  notes: field.encryptedJson({ optional: true }),
})
const c = await Customer.objects.filter({ taxId: 'DE123456789' }).first()   // eq works with deterministic
```

### 3. Fetch a supplier feed URL a staff member typed

```ts
try {
  const res = await safeFetch(feedUrl, { timeoutMs: 15_000, maxBytes: 2_000_000 })
  if (!res.ok) throw new DomainError('feed_failed', `feed answered ${res.status}`)
  return await res.json()
} catch (e) {
  if (e instanceof SafeFetchError) throw new DomainError('feed_blocked', e.message)
  throw e
}
```

### 4. Refunds: an agent may prepare, only the human confirms

```ts
export const refund = defineAction('refund', z.object({ orderId: z.number().int() }), handler, {
  permissions: [isStaff],
  confirm: { message: (p) => `Refund order #${p.orderId}?`, by: 'human' },
  rate: { limit: 10, windowMs: 3_600_000 },
})
export const deleteAccount = defineAction('deleteAccount', z.object({}), handler2, { humanOnly: 'only you can delete your account' })
```

### 5. Shield as the only general rate limit

```ts
// config/settings.ts (Shield set-up details: docs/shield.md)
installedApps: ['tvine.auth', 'tvine.shield', 'catalog'],
middleware: ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Shield',
  'tvine.middleware.Security', 'tvine.middleware.Cors', 'tvine.middleware.GZip'],
shield: { mode: 'enforce' },
limits: { rate: { by: 'shield' } },   // the login action's own 10 / min still applies
```

## Gotchas

- Signed is not encrypted: never put secrets in `dumps` payloads.
- Use a distinct `salt` per purpose, or a token for one feature works in another.
- Removing an old `TVINE_SECRET` / encryption key too early breaks old tokens, sessions, TOTP secrets and
  encrypted values; rotate first.
- An encrypted field cannot be sorted, searched or filtered with `contains`; without `deterministic` it cannot be
  filtered at all.
- `safeFetch` follows at most 3 redirects and re-checks each; plain `fetch` does none of this.
- The general limit counts every action call, reads included. Raise `limits.rate` for chatty pages instead of
  disabling it.

## See also

- [../../../shield.md](../../../shield.md): bot protection, challenges, rate rules (full guide)
- [auth.md](auth.md): passwords, throttling, tokens, 2FA
- [audit.md](audit.md): where refusals are recorded
- [media.md](media.md): signed private file links
- [../actions.md](../actions.md): action rules
- [../models.md](../models.md): field options
