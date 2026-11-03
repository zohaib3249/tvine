# Email

## What it is

Tvine's mail module: `sendMail`, `sendMassMail`, `mailAdmins`, the `EmailMessage`
/ `EmailMultiAlternatives` classes, and backends picked by `settings.email.backend` (console, SMTP, file, memory,
dummy). It has its own small SMTP client (STARTTLS or implicit TLS, AUTH PLAIN / LOGIN). Messages are built
7-bit clean; any CR or LF in a header or address is refused (`BadHeaderError`). There is no template engine: you
pass the text (and optional HTML) yourself. Source: `packages/tvine/warp/src/mail/`.

## Install / enable

Nothing to install. The default backend is `'console'` in development, `'memory'` under tests
(`NODE_ENV=test` or vitest), and `'smtp'` when `NODE_ENV=production`.

```ts
// config/settings.ts
import { defineSettings, env } from 'tvine'

export default defineSettings({
  email: {
    host: 'smtp.example.com', port: 587, useTls: true,
    user: 'shop@example.com', password: env.str('SMTP_PASSWORD'),
    defaultFrom: 'Demo Shop <shop@example.com>', admins: ['ops@example.com'],
  },
})
```

Install `tvine.tasks` if you want `{ background: true }` sends to be queued and retried.

## Import

```ts
import { sendMail, sendMassMail, sendMessages, mailAdmins, mail, EmailMessage, EmailMultiAlternatives, BadHeaderError, SmtpError } from 'tvine'
```

## `sendMail`

```ts
sendMail(o: SendMailOpts): Promise<number>                                // sent now; resolves to the number sent
sendMail(o: SendMailOpts, { background: true }): Promise<{ pending: true; jobId?: string }>
```

| `SendMailOpts` | Type | Default | Meaning |
|---|---|---|---|
| `subject` | `string` | — | required |
| `message` | `string` | — | plain-text body, required |
| `to` | `string \| string[]` | — | `'a@b.c'` or `'Name <a@b.c>'` |
| `from` | `string` | `email.defaultFrom` | |
| `cc`, `bcc`, `replyTo` | `string \| string[]` | — | Bcc is never written into the message |
| `html` | `string` | — | added as a `text/html` alternative |
| `attachments` | `{ filename, content: string \| Uint8Array, mimetype? }[]` | — | mimetype guessed from the extension |
| `headers` | `Record<string, string>` | — | extra headers (override built-in ones of the same name) |
| `failSilently` | `boolean` | `false` | a failed send resolves `0` instead of throwing |

`{ background: true }`: the message is checked now (a bad header throws in the caller), then sent through the
`tasks.sendMail` task when `tvine.tasks` is installed (queued after commit, 3 retries, 30 s backoff, args never
logged); without `tvine.tasks` it is sent after commit in this process and a failure is only logged.

## Other functions

| Function | Meaning |
|---|---|
| `sendMassMail([[subject, message, from \| undefined, to[]], …], failSilently?)` | many messages over one connection; returns the count |
| `sendMessages(messages: EmailMessage[], failSilently?)` | send built messages over one connection |
| `mailAdmins(subject, message, { html?, failSilently? })` | to `email.admins`, from `email.serverEmail`, subject prefixed with `email.subjectPrefix`; returns `0` when `admins` is empty |
| `mail.outbox` | messages the `memory` backend "sent" (tests: `mail.outbox.length = 0` to empty it) |
| `mail.settings` | the active `settings.email` |
| `configureMail(settings)` | set the mail settings by hand (scripts) |

## `EmailMessage` / `EmailMultiAlternatives`

```ts
new EmailMessage({ subject?, body?, from?, to?, cc?, bcc?, replyTo?, headers?, attachments? })
```

| Member | Meaning |
|---|---|
| `attach(filename, content, mimetype?)` | add an attachment; returns `this` |
| `attachFile(path, mimetype?)` | read a file from disk and attach it |
| `recipients()` | to + cc + bcc addresses |
| `message()` | the RFC 5322 text (throws `BadHeaderError` on a bad header) |
| `send(failSilently = false)` | `Promise<number>`; `0` when there are no recipients |
| `toJSON()` / `EmailMessage.fromJSON(j)` | what the background task carries (attachments base64) |
| `EmailMultiAlternatives#attachAlternative(content, mimetype)` | e.g. an HTML part |

## Backends

| `email.backend` | Does |
|---|---|
| `'console'` | prints each message to stdout |
| `'smtp'` | sends through `host:port`; one connection per batch |
| `'file'` | appends to a new `.log` file per send under `email.filePath` |
| `'memory'` | pushes to `mail.outbox` |
| `'dummy'` | drops everything (and turns off tvine.auth's account alerts) |

SMTP: `useTls` = STARTTLS, `useSsl` = TLS from the first byte (port 465); not both. Credentials are only sent over
TLS; `allowPlainAuth: true` allows AUTH without TLS only to a local relay. Every wait is capped by `timeoutMs`.
Errors from the server are `SmtpError` (with `code`).

## Settings: `settings.email.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `backend` | `'console' \| 'smtp' \| 'file' \| 'memory' \| 'dummy'` | by environment (see above) | |
| `host` | `string` | `'localhost'` | SMTP host |
| `port` | `number` | `25` | |
| `user` / `password` | `string` | `''` | AUTH; empty user = no AUTH |
| `useTls` | `boolean` | `false` | STARTTLS |
| `useSsl` | `boolean` | `false` | implicit TLS |
| `allowPlainAuth` | `boolean` | `false` | AUTH without TLS to localhost only |
| `timeoutMs` | `number` | `10_000` | per SMTP wait |
| `defaultFrom` | `string` | `'webmaster@localhost'` | `from` when none is given |
| `serverEmail` | `string` | `'root@localhost'` | `from` of `mailAdmins` |
| `admins` | `string[]` | `[]` | `mailAdmins` recipients |
| `subjectPrefix` | `string` | `'[Tvine] '` | `mailAdmins` subject prefix |
| `filePath` | `string` | `'./mail'` | `file` backend directory |

## Examples

### 1. Order confirmation with HTML, sent in the background

```ts
await sendMail({
  subject: `Order #${order.id} confirmed`,
  message: `Thanks for your order. Total: ${order.total}`,
  html: `<p>Thanks for your order.</p><p>Total: <b>${escapeHtml(String(order.total))}</b></p>`,
  to: `${user.getFullName()} <${user.email}>`,
}, { background: true })
```

(`escapeHtml` is yours: Tvine does not escape `html`.)

### 2. Invoice PDF attachment

```ts
const m = new EmailMessage({ subject: 'Your invoice', body: 'Invoice attached.', to: order.email })
m.attach(`invoice-${order.id}.pdf`, pdfBytes, 'application/pdf')
await m.send()
```

### 3. Alert the team

```ts
await mailAdmins('Low stock', `${product.name} has ${product.stock} left`)
```

### 4. Assert mail in a test

```ts
import { mail } from 'tvine'
mail.outbox.length = 0
await placeOrder()
expect(mail.outbox[0]!.subject).toContain('confirmed')
```

## Gotchas

- In production with no `email` settings the backend is `smtp` to `localhost:25`.
- `sendMail` without `background` waits for the SMTP server inside your request.
- `html` is sent as you give it; escape user data yourself.
- Inside a transaction, a background send happens only after commit; a rollback sends nothing.

## See also

- [tasks.md](tasks.md): `tasks.sendMail`, retries
- [auth.md](auth.md): password reset mail and account alerts
- [../../../settings-and-env.md](../../../settings-and-env.md): `env` helpers
