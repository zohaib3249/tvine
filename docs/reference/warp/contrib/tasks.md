# tvine.tasks

## What it is

`tvine.tasks` runs work outside the request: background jobs, retries, timeouts, periodic (cron) jobs, and job
chains. You define tasks with `defineTask` in `apps/<app>/tasks.ts`, enqueue them from
actions with `.delay(args)`, and run them in job workers (`tvine worker`). Jobs are stored by a broker: a local SQLite file by
default, Redis for several hosts, your app's database, or memory for tests. Source:
`packages/tvine/warp/src/contrib/tasks/`.

## Install / enable

```ts
// config/settings.ts
export default defineSettings({
  installedApps: ['tvine.auth', 'tvine.tasks', 'catalog', 'orders'],
  tasks: { broker: 'file' },   // the default; 'redis' for several hosts
})
```

Run `tvine migrate` (job tables and the outbox), then start a worker next to the web server:

```bash
tvine worker                 # every queue, 10 at a time
tvine worker --beat          # also fire scheduled tasks (several --beat processes are safe: one leads)
```

No middleware is needed. The web server discovers tasks at boot (so actions can enqueue them) and relays job
progress to the browser; it does **not** run jobs or schedules, except with `broker: 'memory'` (jobs only) or
`tvine start --with-worker [--beat]`. With only `tvine start`, queued jobs wait and schedules never fire; about 30 s
after start it prints once:

```
tvine start: background jobs are queued but no job worker is running. Start one: tvine worker --beat   (see docs/deploy.md#background-jobs)
```

(not in `tvine dev`, not with broker `memory`, not with `--with-worker`; it reads the broker's worker heartbeats).
How to run both in production: [deploy.md](../../../deploy.md#how-a-tvine-app-runs-in-production).

### Job workers

| | |
|---|---|
| Claiming | a worker claims up to `claimBatch` jobs with a lease (`leaseMs`, 30 s) and renews it every `leaseMs / 3` while they run |
| Run once | only the lease holder may finish a job (a token fences it); several workers never run the same attempt |
| A worker dies | its lease expires, the reaper puts the job back, another worker runs it (counted as an attempt) |
| How many | any number of processes and machines that reach the broker; `--concurrency` jobs at once each (default 10) |
| Who is alive | each worker registers in the broker and heartbeats; one silent longer than `leaseMs` is stale. `tvine check`, `/tvine/health` (`workers`, `staleWorkers`) and the admin's Job workers tile read this |
| Stop | SIGTERM: stop claiming, finish within `--grace` (`graceMs`), put the rest back (attempt not spent); a second signal exits now |
| In the web process | `tvine start --with-worker [--concurrency n] [--beat]`: one job worker (and scheduler) inside the web server; with `--workers` > 1 only web worker 1 runs it; stop waits up to `graceMs` for running jobs |

## Import

```ts
import { defineTask, chain, group, chord, jobResult, revoke, Retry, JobFailed, SoftTimeLimit, HardTimeLimit } from 'tvine/tasks'
```

Also exported: `Worker`, `Beat`, `parseCron`, `nextFire`, `broker`, `setBroker`, `dbBroker`, `discoverTasks`,
`configureTasks`, `tasks`, `taskById`, `backoff`, `STATUSES`, `FINAL`, `OutboxRelay`, `ProgressRelay`.

## `defineTask`

```ts
defineTask<S extends ZodType, R>(name: string, fn: (args: z.infer<S>, ctx: TaskCtx) => R | Promise<R>, opts?: TaskOpts<S>): Task<S, R>
```

Export the task from `apps/<app>/tasks.ts`. Its id is `<app>.<name>` (`orders.sendReceipt`). `name` must match
`/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Using a task that was not discovered throws "task … was not discovered".

### `TaskOpts`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `args` | zod schema | `z.unknown()` | args are validated when enqueued (bad args throw `invalid_param` in the caller) and again before running |
| `queue` | `string` | `'default'` | `/^[a-z0-9_-]{1,64}$/i` |
| `priority` | integer -100..100 | `0` | higher runs first, then older `runAt` |
| `maxRetries` | integer ≥ 0 | `3` | retries after the first attempt |
| `retryBackoff` | `false \| number \| { baseMs?, maxMs?, jitter? }` | `{ baseMs: 1000, maxMs: 600_000, jitter: true }` | wait before a retry: `false` = none, a number = fixed ms, an object = `min(maxMs, baseMs · 2^(attempt-1))`, jitter picks between half and all of it |
| `retryOn` | `(ErrorClass \| (e) => boolean)[]` | every error | only these errors retry |
| `dontRetryOn` | same | — | these never retry (wins over `retryOn`) |
| `timeoutMs` | `number \| { soft?, hard? }` | hard 300 000 | a number = hard limit. Soft: `ctx.signal` aborts with `SoftTimeLimit`. Hard: the attempt fails with `HardTimeLimit`. `soft` must be below `hard`. |
| `rateLimit` | `'<n>/s' \| '<n>/m' \| '<n>/h' \| { limit, windowMs }` | — | at most this many starts per window, per worker process |
| `unique` | `{ windowMs, key?: (args) => string }` | — | a second enqueue with the same key (default: the args) inside the window does not run; its job is `deduped` and follows the first |
| `expires` | ms | — | a job not started this long after enqueue becomes `expired` |
| `acks` | `'late' \| 'early'` | `'late'` | `late`: a job whose worker died is run again; `early`: it is marked `dead` instead |
| `durable` | `boolean` | `false` | enqueued inside a transaction → an outbox row in the same transaction (never lost); see Gotchas |
| `schedule` | `{ cron } \| { every }` + `{ args?, misfire?, graceMs? }` | — | periodic job, fired by the beat |
| `resultTtlMs` | ms | `settings.tasks.resultTtlMs` | how long a finished job (and its result) is kept |
| `logArgs` | `boolean` | `false` | log the (redacted) args at `job.start` |

### `TaskCtx`

| Member | Type | Meaning |
|---|---|---|
| `jobId` | `string` | uuid |
| `task` | `string` | task id |
| `attempt` | `number` | 1-based |
| `queue` | `string` | |
| `signal` | `AbortSignal` | aborts on soft timeout, revoke, lost lease, shutdown. Pass it to `fetch`, check it in loops. |
| `parent` | `{ jobId, result }` | in a chain: the previous link |
| `progress(pct, message?)` | `Promise<void>` | 0–100; written at most every 250 ms (the last value always lands); sent live to the session that enqueued the job |
| `retry({ inMs? })` | `Retry` | `throw ctx.retry({ inMs: 5000 })` |
| `log(msg, data?)` | `void` | logs on `tvine.tasks` with the job's ids |

The handler's return value must be JSON (it is stored as the result); `undefined` is stored as `null`.

### A job's life

Statuses: `queued`, `running`, `success`, `dead`, `expired`, `cancelled`, `deduped`. Final ones: all but `queued`
and `running`. A failed attempt retries while `attempts <= maxRetries` and the error is retryable; then it is
`dead`. Throwing `Retry` (or `ctx.retry()`) always retries (still bounded by `maxRetries`). A job of an
unregistered task retries after 30 s. Args the schema refuses at run time → `dead`.

## Enqueueing

```ts
task.delay(args): Promise<{ pending: true; jobId }>
task.apply({ args, countdown?, eta?, priority?, queue?, expires?, owner? }): Promise<{ pending: true; jobId }>
```

| `apply` option | Type | Meaning |
|---|---|---|
| `countdown` | ms | run no earlier than now + this |
| `eta` | `Date \| number` | run no earlier than this moment |
| `priority`, `queue` | | override the task's |
| `expires` | ms after enqueue, or a `Date` | override the task's |
| `owner` | `null` | a system job: no session / user, no progress events |

Inside a transaction (an action, `atomic()`), the job is pushed **after commit**: a rollback never enqueues. Outside
one it is pushed at once. The job remembers the session and user that enqueued it.

### Canvas: chain, group, chord

```ts
task.s(args?, { countdown?, priority?, queue? })   // a signature; in a chain it receives the previous result when args is omitted
task.si(args, opts?)                                 // immutable: always its own args
chain(sigA, sigB, sigC).delay()                      // one after another → { pending, jobId } of the first
group([sig1, sig2]).delay()                          // in parallel → { pending, groupId, jobIds }
chord([sig1, sig2], callbackSig).delay()             // callback gets the members' results in order, after ALL succeed
```

### Results and revoke

```ts
const r = jobResult(jobId)
await r.status()                          // JobStatus | undefined
await r.row()                             // the stored job row
await r.get({ timeoutMs: 30_000, pollMs: 200 })   // the result; throws JobFailed(jobId, status, reason) for a final non-success
await revoke(jobId)                       // queued → cancelled now; running → its signal aborts at the next heartbeat
```

Built-in actions (also MCP tools): `tasks.status({ jobId })` → `{ jobId, task, status, attempts, queue, progress,
message, result?, error?, createdAt, finishedAt? }` and `tasks.revoke({ jobId })` → `{ jobId, status }`. Only the
session or user that enqueued the job, or staff with `tasks.view_job` (status) / `tasks.change_job` (revoke), can see
a job; anyone else gets `not_found`. Args are never returned; non-staff see the error text only for `DomainError` /
`Retry`, otherwise `failed`. REST: `include('tvine.tasks.urls')` → `jobs/<uuid:jobId>/` and `jobs/<uuid:jobId>/revoke/`.

## Scheduled tasks (beat)

```ts
schedule: { cron: '0 3 * * *' }                 // 5 fields, UTC: min hour day-of-month month day-of-week
schedule: { every: 15 * 60_000, args: { full: false } }   // every n ms (>= 1000)
```

| Key | Default | Meaning |
|---|---|---|
| `cron` | — | `*`, `a-b`, `*/n`, `a-b/n`, lists, `jan`–`dec`, `sun`–`sat`, `7` = Sunday, `@yearly @annually @monthly @weekly @daily @midnight @hourly` |
| `every` | — | interval in ms |
| `args` | — | must pass the task's `args` schema (checked at boot) |
| `misfire` | `'once'` | after downtime longer than `graceMs`: `'once'` = run one catch-up, `'skip'` = none, `'all'` = every missed run (max 100) |
| `graceMs` | `60_000` | lateness that still counts as on time |

Run the scheduler with `tvine worker --beat` (or `tvine start --with-worker --beat`). Several `--beat` workers are
safe and recommended for failover: one holds the scheduler lock (renewed every 10 s, 30 s lease), the others stand
by and take over within ~30 s when it dies (at once after a clean stop), and a fire time is never sent twice (a
compare-and-set in the broker). `tvine check` and the admin show the leader's name, or `scheduler off`. Schedules can also live in `config/tasks.ts` (or `settings.tasksModule`):

```ts
// config/tasks.ts
export const queues = ['default', 'mail']                     // the worker's default --queues
export const beatSchedule = { 'orders.closeStaleCarts': { cron: '*/30 * * * *' } }
```

`tvine.audit` ships `audit.prune` (daily 03:00) when installed.

## Commands

Every flag with its default: [cli.md](../../../cli.md#jobs) (or `tvine worker --help`).

| Command | Meaning |
|---|---|
| `tvine worker [--queues a,b] [--concurrency 10] [--beat] [--name x] [--grace ms]` | a job worker; `--queues '*'` (default, or `queues` in `config/tasks.ts`) = all; `--beat` = also the scheduler |
| `tvine start --with-worker [--concurrency 10] [--beat]` | a job worker inside the web process (small sites) |
| `tvine tasks list [--status s] [--queue q] [--limit 50]` | list jobs |
| `tvine tasks inspect <jobId>` | one job as JSON |
| `tvine tasks retry <jobId>` | requeue a `dead`, `expired` or `cancelled` job |
| `tvine tasks purge --dead` | delete dead jobs |
| `tvine tasks compact` | shrink the `file` broker's file |
| `tvine tasks bench [--jobs 5000] [--workers 4] [--batch 10]` | raw jobs/s of the configured broker |
| `tvine check` | `tasks: N job worker(s) running · M job(s) waiting · scheduler on (leader)\|off`; warns when jobs wait and no worker runs |

## Brokers

| `settings.tasks.broker` | Store | Use |
|---|---|---|
| `'file'` (default) | its own SQLite WAL file, `settings.tasks.file` | one host, any number of processes (start them from the same folder: the path is relative) |
| `'redis'` | `settings.redis.<tasks.redis>` | several hosts |
| `'db'` | the `tasks_*` tables of the app's database, polled every `pollMs` | several hosts that share the database |
| `'memory'` | this process | dev / tests: the web server runs the jobs itself and they are lost on restart; `tvine worker` refuses to start |

## Settings: `settings.tasks.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `broker` | `'file' \| 'redis' \| 'db' \| 'memory'` | `'file'` | job store |
| `file` | `string` | `'./tasks.db'` | the file broker's path |
| `durable` | `boolean` | `false` | file broker: every commit synced to disk (survives a power cut, ~4.5 ms each) |
| `redis` | alias | `'default'` | which `settings.redis` connection |
| `leaseMs` | ms ≥ 1000 | `30_000` | a running job's lease; a job whose worker stops renewing is reclaimed |
| `pollMs` | ms ≥ 10 | `500` | worker poll interval |
| `relayMs` | ms ≥ 10 | `250` | progress relay interval in the web server |
| `graceMs` | ms | `30_000` | shutdown grace |
| `resultTtlMs` | ms | `86_400_000` | finished jobs kept this long |
| `claimBatch` | 1–100 | `10` | jobs claimed per round trip |

`settings.tasksModule` (string, default `'config/tasks'`): the module with `queues` / `beatSchedule`.

## Examples

### 1. A receipt mail after an order

```ts
// apps/orders/tasks.ts
import { z } from 'zod'
import { defineTask } from 'tvine/tasks'
import { sendMail } from 'tvine'
import { Order } from './models.ts'

export const sendReceipt = defineTask('sendReceipt', async ({ orderId }) => {
  const o = await Order.get(orderId)
  if (!o) return { sent: false }
  await sendMail({ subject: `Order #${o.id}`, message: `Thanks! Total: ${o.total}`, to: o.email })
  return { sent: true }
}, { args: z.object({ orderId: z.number().int() }), queue: 'mail', maxRetries: 5, retryBackoff: { baseMs: 30_000 } })
```

```ts
// apps/orders/views.ts
export const place = defineAction('place', placeParams, async (p, ctx) => {
  const order = await Order.create({ /* ... */ })
  const job = await sendReceipt.delay({ orderId: order.id })   // pushed after this action commits
  return { order, job }
})
```

### 2. Import with progress and a timeout

```ts
import { safeFetch } from 'tvine'
import { Product } from '../catalog/models.ts'

export const importCatalog = defineTask('importCatalog', async ({ url }, ctx) => {
  const res = await safeFetch(url, { timeoutMs: 20_000 })
  const rows = (await res.json()) as { sku: string; name: string }[]
  for (const [i, r] of rows.entries()) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    await Product.objects.updateOrCreate({ sku: r.sku }, { name: r.name })
    await ctx.progress((100 * (i + 1)) / rows.length, `${i + 1}/${rows.length}`)
  }
  return { imported: rows.length }
}, { args: z.object({ url: z.string().url() }), timeoutMs: { soft: 60_000, hard: 90_000 }, unique: { windowMs: 600_000 } })
```

### 3. Nightly cleanup

```ts
export const closeStaleCarts = defineTask('closeStaleCarts', async () => ({
  closed: await Cart.objects.filter({ updatedAt__lt: new Date(Date.now() - 7 * 86_400_000) }).delete(),
}), { schedule: { cron: '30 2 * * *', misfire: 'skip' } })
```

### 4. Chain and chord

```ts
await chain(reserveStock.s({ orderId }), chargeCard.s(), sendReceipt.si({ orderId })).delay()
await chord(ids.map((id) => resizeImage.s({ id })), publishGallery.s()).delay()
```

### 5. Wait for a result in a script

```ts
const { jobId } = await importCatalog.delay({ url })
console.log(await jobResult(jobId).get({ timeoutMs: 120_000 }))
```

## Gotchas

- Without `durable: true` on the task, a crash between commit and push loses the job (the push is after commit).
  `durable` on a task (outbox) is not the same as `settings.tasks.durable` (disk sync of the file broker).
- `broker: 'memory'` jobs run inside the web server and die with it; a separate worker cannot see them. Its
  schedules fire only with `tvine start --with-worker --beat`.
- Only `tvine start` and no job worker: jobs wait forever, schedules never fire (the start warning above).
- A handler that ignores `ctx.signal` keeps its worker slot after a timeout or revoke until it settles (JS cannot
  kill a promise).
- `rateLimit` is per worker process, not global.
- Cron is UTC.
- Results must be JSON; Dates become strings.
- Job progress reaches the browser only for jobs enqueued by a session (not `owner: null`, not beat jobs).
- `ctx.retry()` returns the `Retry`; you must `throw` it.

## See also

- [email.md](email.md): `sendMail(..., { background: true })` uses the built-in `tasks.sendMail` task
- [audit.md](audit.md): a job that ends `success` or `dead` writes an audit row (`via: 'job'`) when audit is on
- [admin.md](admin.md): the Job admin (retry, revoke) and System → Jobs
- [../actions.md](../actions.md): enqueue from actions
