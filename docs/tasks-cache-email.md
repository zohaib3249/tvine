# Background tasks, cache and email

Three built-in subsystems: `tvine.tasks` (background jobs), the cache and mail. None needs a third-party service to start; Redis is optional for several machines.

Settings keys: [settings-and-env.md](settings-and-env.md). Redis for several processes: [deploy.md](deploy.md).

## Background tasks

### Setup

```ts
// settings.ts
installedApps: ['tvine.tasks'],
```

Run `pnpm exec tvine migrate`. Jobs live in their own SQLite file, `./tasks.db`, never in your main database.

### Define and enqueue

```ts
// apps/notes/tasks.ts
import { z } from 'zod'
import { defineTask } from 'tvine/tasks'
import { Note } from './models.ts'

export const countWords = defineTask('countWords', async ({ id }) => {
  const note = await Note.get(id)
  if (!note) return { words: 0 }
  const words = note.body.split(/\s+/).filter(Boolean).length
  await Note.objects.filter({ id }).update({ words })
  return { words }
}, { args: z.object({ id: z.number().int() }) })
```

```ts
// in an action
return countWords.delay({ id: note.id })     // → { pending: true, jobId }
```

The task id is `<app>.<name>` (`notes.countWords`). Inside a request the job is pushed after the transaction
commits, so a rollback never enqueues. An agent that calls the action sees `{ pending: true, jobId }` and can poll
the built-in `tasks.status({ jobId })` tool; `tasks.revoke({ jobId })` cancels.

More ways to enqueue: `apply({ args, countdown, eta, priority, queue, expires })`, `chain(a, b)`, `group([...])`,
`chord(group, callback)`.

### Task options

| Option | Default | Meaning |
|---|---|---|
| `args` | any | zod schema, checked at enqueue and in the worker |
| `queue` / `priority` | `'default'` / `0` | which queue; higher priority first |
| `maxRetries` | `3` | then the job is `dead` |
| `retryBackoff` | 1 s doubling to 10 min, jitter | or `false`, or a fixed ms |
| `retryOn` / `dontRetryOn` | all / none | error classes or predicates |
| `timeoutMs` | `{ hard: 300_000 }` | `soft` aborts `ctx.signal`; `hard` fails the attempt |
| `rateLimit` | none | `'10/s'`, `'100/m'`, `'1000/h'`, per worker |
| `unique` | none | `{ windowMs, key? }`: one live job per key |
| `expires` | none | ms; not started by then → `expired` |
| `durable` | `false` | write an outbox row in your transaction, so the job is never lost |
| `acks` | `'late'` | `late` = at least once, `early` = at most once |
| `schedule` | none | `{ cron: '*/5 * * * *' }` or `{ every: ms }` (needs `--beat`) |
| `logArgs` | `false` | args never appear in logs unless true |

The handler's second argument `ctx` has `jobId, attempt, signal, progress(pct, msg), retry({ inMs }), log()`.
Progress is pushed live to the tab and the agent that started the job.

### Run a job worker

The web server (`tvine start` / `tvine dev`) does **not** run jobs: start a job worker next to it, or queued jobs
wait forever and schedules never fire (`tvine start` warns once after ~30 s when no job worker is running).

```bash
pnpm exec tvine worker
pnpm exec tvine worker --queues default --concurrency 2
# INFO  tvine.tasks worker.start worker=…:16247:bd5463 queues=["default"] concurrency=2
pnpm exec tvine worker --beat           # also runs scheduled (cron) tasks; several --beat workers are safe (one leads)
pnpm exec tvine start --with-worker --beat   # small site: jobs + schedules inside the one web process
```

Run as many job workers as you like: each job is claimed with a lease and runs once. Ctrl-C or SIGTERM: stop
claiming, wait up to 30 s (`--grace`) for running jobs, then put unfinished ones back in the queue. With
`broker: 'memory'` (dev and tests only) the web server runs jobs itself. Production setups, process-manager files
and the safety checks: [deploy.md](deploy.md#background-jobs).

### Ops

```bash
pnpm exec tvine tasks list                        # ID  TASK  STATUS  TRIES  QUEUE  CREATED
pnpm exec tvine tasks list --status dead --limit 5
pnpm exec tvine tasks purge --dead                # purged 0 dead job(s)
pnpm exec tvine tasks compact                     # VACUUM tasks.db
```

Also `tasks inspect <id>`, `tasks retry <id>`, and `tasks bench` ([cli.md](cli.md#tvine-tasks)). `tvine check` prints
`tasks: N job worker(s) running · M job(s) waiting · scheduler on|off`. The admin lists jobs under System → Jobs and
shows a **Job workers** tile under System → Health (red when jobs wait and no worker runs); `/tvine/health` reports
queue counts.

### Settings

```ts
tasks: {
  broker: 'file',          // 'file' (./tasks.db) | 'memory' (dev/tests) | 'redis' (several machines) | 'db'
  file: './tasks.db', redis: 'default',
  leaseMs: 30_000, graceMs: 30_000, resultTtlMs: 86_400_000, relayMs: 250, pollMs: 500, claimBatch: 10,
  durable: false,          // true: write tasks_outbox in the app db, then relay into the broker
}
```

Three stores: the **app database**, **`tasks.file`** (file broker), and **Redis**. `tvine migrate` creates `tasks_*` (Job ORM for `broker: 'db'`; `tasks_outbox` when durable on any broker).

### Gotchas

- A handler that ignores `ctx.signal` cannot be killed by a hard timeout; it keeps its slot until it settles.
- Cron is UTC only.
- `tasks.db` must be on a local disk (not NFS/SMB). Workers on other machines need `broker: 'redis'`.
- Without `durable: true`, a crash between commit and the push loses that job.
- `caches.*.timeout` is in **seconds** (unlike most other `*Ms` settings).

## Cache

```ts
import { cache, caches } from 'tvine'

await cache.set('greeting', 'hi', 60)                    // timeout in SECONDS; null = forever; 0 = do not store
await cache.get('greeting')                              // 'hi'
await cache.getOrSet('n', () => 42, 30)
await cache.tags(['product:12']).set('p12', row)
await cache.invalidateTags(['product:12'])
await caches.shared.incr('hits')                         // a named cache
```

Full API: `get, set, add, getOrSet, delete, has, touch, incr, decr, getMany, setMany, deleteMany, incrVersion,
decrVersion, clear, lookup, keyFor`.

```ts
// settings.ts
caches: {
  default: { backend: 'memory', timeout: 300, keyPrefix: '', version: 1, maxEntries: 300 },
  shared:  { backend: 'redis', redis: 'default' },
  disk:    { backend: 'file', location: './.cache' },
  off:     { backend: 'dummy' },
},
```

Cache an action's result, read-only actions only:

```ts
defineAction('list', schema, run, { readOnly: true, cache: { timeout: 60, varyOn: ['user', 'query'], tags: ['products'] } })
```

Gotchas:

- `varyOn` defaults to `['user']`: results are shared across users only when you leave `'user'` out.
- `rules.cache` on a non-readOnly action is a boot error.
- If the cache fails (Redis down), the handler runs anyway and the error is logged.
- `memory` is per process; use `redis` with several processes.

## Email

```ts
import { sendMail, mailAdmins, EmailMultiAlternatives } from 'tvine'

await sendMail({ subject: 'Hello', message: 'Body', to: ['a@example.com'] })     // → 1 (messages sent)
await sendMail({ subject, message, to, html }, { background: true })              // via tvine.tasks, 3 retries
await mailAdmins('Disk full', 'See the dashboard')
new EmailMultiAlternatives({ subject, body, to }).attachAlternative(html, 'text/html').attach('a.pdf', bytes).send()
```

In dev the `console` backend prints the message:

```
From: webmaster@localhost
To: a@example.com
Subject: Hello
…
Body
```

### Settings

```ts
email: {
  backend: 'smtp',          // 'console' (dev default) | 'smtp' (prod default) | 'file' | 'memory' (tests) | 'dummy'
  host: 'smtp.example.com', port: 587, useTls: true,           // STARTTLS; or port 465 + useSsl
  user: process.env.SMTP_USER!, password: process.env.SMTP_PASSWORD!,
  defaultFrom: 'Shop <shop@example.com>', serverEmail: 'alerts@example.com',
  admins: ['Ops <ops@example.com>'], subjectPrefix: '[Tvine] ',
  timeoutMs: 10_000, filePath: './mail', allowPlainAuth: false,
},
```

In tests, `mail.outbox` holds sent messages (`mail.outbox.length = 0` resets it).

### Gotchas

- Credentials are only sent over TLS (`useSsl`, or after STARTTLS).
- A newline in a subject or address throws `BadHeaderError` (header injection).
- With `background: true` the whole message (including reset links) sits in the job row until `resultTtlMs` purges it.
- Production warns at boot while `defaultFrom` is still `webmaster@localhost`.
- Security notifications (new login, password changed, …) are sent only when the backend is not `dummy`.
