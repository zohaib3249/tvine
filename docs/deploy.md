# Deploying Tvine

One Node process serves everything: the Next.js pages, `/tvine/*` (agent API, tab socket), `/mcp`, `/admin` and
`/media`. Run one process by default; add workers plus Redis when one is not enough ([Scaling](#2-scaling)). A separate `tvine worker`
runs background jobs.

Commands below were run against an example store app built on Tvine unless marked otherwise.

Related guides: [auth-and-security.md](auth-and-security.md) (hosts, CSP, CORS, secrets),
[tasks-cache-email.md](tasks-cache-email.md) (worker, Redis cache, SMTP), [admin.md](admin.md) (System pages).

## 1. Production checklist

| Item | What to do |
|---|---|
| `TVINE_SECRET` | Required. 32+ random chars: `export TVINE_SECRET=$(openssl rand -hex 32)`. Without it `tvine start` and `NODE_ENV=production tvine check` exit 1 with this exact hint. It signs session-bound tokens (binds, confirm tokens). |
| `TVINE_ALLOWED_HOSTS` | Required in production (or `settings.allowedHosts`): your domains, comma-separated (`shop.example.com,.example.com`). Unset, boot exits 1; an unknown `Host` gets a 400 (DNS rebinding, poisoned links). |
| Secret rotation | Pass a list in `settings.ts`: the first key signs, every key verifies. `secret: [process.env.TVINE_SECRET!, process.env.TVINE_SECRET_OLD!].filter(Boolean)`. Deploy with the new key first, drop the old one after the longest token lifetime (bind expiry; confirm tokens live 2 min). |
| `NODE_ENV` | `tvine start` sets `production` when unset (like `next start`). `tvine dev` refuses to run under `production`. |
| Build | `pnpm build` (`next build`) before `tvine start`; without `.next/` the server runs API-only. |
| `trustProxy` | `settings.trustProxy` = how many proxies sit in front (1 behind one load balancer/CDN). It decides `request.ip` (rate limits), https detection, the `Secure` cookie flag and HSTS. Leave `0` when clients reach Node directly — a client can then not fake `X-Forwarded-*`. |
| HTTPS | Terminate TLS at the proxy and set `trustProxy`. HSTS is sent only on https requests (checked: with `TVINE_TRUST_PROXY=1` and `X-Forwarded-Proto: https` the demo answers `strict-transport-security: max-age=31536000; includeSubDomains`; on plain http it does not). |
| CSP / headers | On by default: nonce CSP with `strict-dynamic`, `X-Content-Type-Options`, `Referrer-Policy`, COOP/CORP, `Permissions-Policy`, `X-Frame-Options`. Tune under `settings.security.headers` ([auth-and-security.md](auth-and-security.md#allowed_hosts-csp-cors)). CORS is closed by default (`settings.cors`). |
| Compression | Warp compresses (gzip/br, with its BREACH rule). Set `compress: false` in `next.config.ts` (boot warns otherwise). |
| Email | Set `settings.email` (below). Boot warns while `defaultFrom` is still `webmaster@localhost`. |
| Gate | `NODE_ENV=production pnpm exec tvine check` in CI: settings, secret, every backend + Redis ping, pending migrations, frontend-imports-models boundary. Exit 1 on any problem. |

```bash
export TVINE_SECRET=$(openssl rand -hex 32)
export TVINE_ALLOWED_HOSTS=shop.example.com
NODE_ENV=production pnpm exec tvine check     # … ok: 57 actions (the demo)
pnpm build
pnpm start                                      # = tvine migrate && tvine start  (PORT or --port, default 3000)
```

## 2. Scaling

**One process (default).** `tvine start` runs one worker. Sessions, the tab socket, rate limits and the snapshot
cache live in memory. Nothing else to run. Restarting logs everyone out of anonymous sessions (carts in the demo).
On a machine with more than one CPU core it says so once at start:

```
tvine start: using 1 of 8 CPU cores. To use all of them: set up Redis (REDIS_URL + the backends) and run: tvine start --workers auto
```

**More copies need Redis.** Every copy must see the same sessions, limits and caches, so point every subsystem at
one shared Redis in `config/settings/prod.ts` — one connection, named once, used by name:

```ts
redis: { default: { url: env.get('REDIS_URL') } },    // or just set REDIS_URL
session:       { backend: 'redis' },
channels:      { backend: 'redis' },
limits:        { backend: 'redis' },                   // also Shield's limiter and claims, login throttle, idempotency
snapshotCache: { backend: 'redis' },
caches:        { default: { backend: 'redis' } },
tasks:         { broker: 'redis' },                    // or keep 'file' while everything runs on one machine
```

`npm i redis@6` in the app. `tvine check` prints every backend and pings Redis (exit 1 if it is down). Use a
real database (Postgres/MySQL) too — several machines cannot share one SQLite file over the network.

**One server: `tvine start --workers auto`.** One process starts one worker per CPU core (`--workers 4` for a fixed
number, or `WEB_CONCURRENCY=auto|4`; the flag wins). All workers listen on the same port — the operating system
hands each new connection to one of them, so no load balancer is needed. It prints one line,
`tvine start: 8 workers on :3000`. A worker that crashes is restarted after a short pause; one that crashes more
than 5 times in a minute stays down (logged in capitals) while the others keep serving. SIGTERM / SIGINT stop every
worker gracefully (in-flight requests finish), then the main process exits.

With more than one worker, start refuses (exit 1, nothing started) while anything is still in memory, and lists what
to change:

```
tvine start: 8 workers need shared state, but these are in memory:
  session.backend = memory        → session: { backend: 'redis' }
  channels.backend = memory       → channels: { backend: 'redis' }
  limits.backend = memory         → limits: { backend: 'redis' }
  snapshotCache.backend = memory  → snapshotCache: { backend: 'redis' }
  caches.default = memory         → caches: { default: { backend: 'redis' } }
Add to config/settings/prod.ts:  redis: { default: { url: env.get('REDIS_URL') } }  and the lines above (REDIS_URL alone also fills settings.redis.default)
(one worker keeps working without Redis: tvine start)
```

It also pings Redis once before starting any worker and exits 1 with the address if Redis does not answer.

**Several servers.** Run `tvine start` (with or without `--workers`) on each, all pointing at one shared Redis and
one database, and put any load balancer in front (nginx, Cloudflare, a cloud load balancer) with plain round-robin.
Logins, carts, rate limits and caches work whichever server answers: no sticky sessions needed for them.

**Containers.** Often one worker per container (the default) and you scale the number of containers; Redis is
still shared by all of them.

**Memory.** Each worker loads its own copy of the app (and of Next.js), so memory is about N × one worker
(backlog #46 is about lighter workers).

**Tab control is still pinned to one process.** A browser tab's agent connection lives on the worker/server that
holds its event stream. `/tvine/channel`, `/tvine/tab/*`, `/tvine/agent/*` and `/mcp` (for `request_control`) must
reach that same process; behind a load balancer route them by session (cookie `tvine_s`, or header
`x-tvine-sid`). With `--workers` on one server the OS cannot route by cookie, so tab control is only reliable with
one worker per server for now. Everything else can go anywhere.

Split mode (Next on one server, `tvine start --api-only` on another) exists but is not recommended yet; don't
start there.

## 3. SQLite in production

The default database (`file:./tvine.db`) is fine for one machine. It already runs in WAL mode
(`sqlite3 tvine.db 'PRAGMA journal_mode;'` → `wal`). Keep `tvine.db`, its `-wal`/`-shm` files, `tasks.db` and
`media/` on one local disk (not NFS/SMB).

**Backups, simple: `sqlite3 .backup`** — a consistent copy while the app runs:

```bash
sqlite3 tvine.db ".backup '/backups/tvine-$(date +%F).db'"
sqlite3 /backups/tvine-$(date +%F).db 'PRAGMA integrity_check;'    # → ok
```

Cron, nightly at 03:00:

```cron
0 3 * * * cd /srv/shop && sqlite3 tvine.db ".backup '/backups/tvine-$(date +\%F).db'" && find /backups -name 'tvine-*.db' -mtime +14 -delete
```

**Backups, continuous: Litestream** streams the WAL to S3 (seconds of loss at most). `/etc/litestream.yml`:

```yaml
dbs:
  - path: /srv/shop/tvine.db
    replicas:
      - type: s3
        bucket: my-shop-backups
        path: tvine
        region: eu-west-1
        retention: 168h
```

```bash
litestream replicate -config /etc/litestream.yml                                  # run next to the app
litestream restore -config /etc/litestream.yml -o /srv/shop/tvine.db /srv/shop/tvine.db   # disaster recovery
```

(Litestream was not installed on the machine these docs were checked on: the config follows its documented
format but was not run.)

`tasks.db` holds queued jobs only; back it up the same way if losing queued jobs on a disk failure matters.
Media files: copy `media/` with your usual file backup.

## 4. Postgres or MySQL

Set `DATABASE_URL` (or `settings.db.url`) and install the driver in the app:

```bash
pnpm add pg          # postgres://user:pass@host:5432/db   (or postgresql://)
pnpm add mysql2      # mysql://user:pass@host:3306/db      (or mariadb://)
DATABASE_URL='postgres://app:secret@db.internal:5432/shop' pnpm exec tvine migrate
```

Migrations are the same files on every engine. Pool: `settings.db.pool` (`max: 10` by default). Engines and
URLs: [models-and-orm.md](models-and-orm.md).

## 5. The worker

Background jobs (`tvine.tasks`) run in a separate process. Same code, same `settings.ts`, same env:

```bash
pnpm exec tvine worker                     # every queue, 10 at a time
pnpm exec tvine worker --queues mail --concurrency 4
pnpm exec tvine worker --beat              # also runs periodic (cron) tasks — run beat in ONE worker
pnpm exec tvine tasks list --status dead   # ops: list / inspect <id> / retry <id> / purge --dead
```

Default job store: `./tasks.db` (SQLite WAL, its own file, never the main database). Any number of worker
processes on the same machine can share it. Workers on other machines need `tasks: { broker: 'redis' }`.

SIGTERM: the worker stops claiming, waits up to 30 s (`--grace`, `settings.tasks.graceMs`) for running jobs, then
puts unfinished ones back in the queue — no job is lost or run twice by a restart.

**Procfile** (Heroku, Dokku, foreman, honcho, …):

```
web: tvine migrate && tvine start
worker: tvine worker --beat
```

Run `migrate` from one place only (the web entry, or a release step) when several web copies start together.

## 6. Email

Production default backend is `smtp`. In `settings.ts`:

```ts
email: {
  host: 'smtp.example.com', port: 587, useTls: true,               // STARTTLS; or port 465 + useSsl
  user: process.env.SMTP_USER!, password: process.env.SMTP_PASSWORD!,
  defaultFrom: 'Shop <shop@example.com>', serverEmail: 'alerts@example.com',
  admins: ['Ops <ops@example.com>'],
},
```

Credentials are only sent over TLS. With `tvine.tasks` installed, `sendMail(…, { background: true })` goes
through the worker with retries. See [tasks-cache-email.md](tasks-cache-email.md).

## 7. Metrics

Prometheus text at `/tvine/metrics`, off by default:

```ts
metrics: { enabled: true, path: '/tvine/metrics', token: process.env.METRICS_TOKEN, allowIps: [] },
```

Scrape with `Authorization: Bearer <token>`, or from an address in `allowIps`. In production one of the two is
required (boot error otherwise); in dev, loopback requests are allowed. Anyone else gets a 404. The admin's
System → Metrics and Traffic pages show the same numbers without a scraper ([admin.md](admin.md)).

## 8. Health and restarts

**Health:** `GET /tvine/health` → `200` JSON, `no-store`:

```json
{"tasks":{"queued":0,"scheduled":0,"running":0,"dead":0,"workers":1,"staleWorkers":0,"ageMs":139},
 "backends":{"session":"memory","channels":"memory",…},"ok":true,"uptime":3,"actions":57,"sessions":0}
```

Anyone else gets only `{"ok":true}`. The details above go to: `Authorization: Bearer <settings.health.token>`
(16+ characters), a signed-in staff session, or a direct request from 127.0.0.1/::1 with no `Forwarded` /
`X-Forwarded-*` / `X-Real-IP` header (a proxy on the same box does not count as local).

It says the process is up and serving. It does not ping the database; alert on `tasks.dead` and
`tasks.staleWorkers` growing.

**Zero-downtime restart.** On SIGTERM (or Ctrl-C) `tvine start` stops accepting connections, closes the event
streams and timers, and exits 0; if closing takes over 5 s it exits 1. So:

- one machine, several copies: restart them one at a time behind the load balancer (take one out, SIGTERM, start
  the new one, wait for `/tvine/health`, put it back);
- one process: there is a short gap while the new one boots; let the proxy retry;
- containers: `docker stop` sends SIGTERM (the image runs `tvine start` with `exec`, so it gets it directly).

## 9. Docker

A Dockerfile is not shipped yet. The steps a multi-stage image needs (each was run by hand, Docker itself was not):
`pnpm install --frozen-lockfile`, `pnpm --filter "<your-app>..." build`, `pnpm --filter <your-app> deploy --prod <dir>`,
then in `<dir>` with `NODE_ENV=production`: `tvine migrate && tvine start`. Mount a volume for `tvine.db` (+ WAL),
`tasks.db` and `media/` (env `DATABASE_URL`, `TASKS_DB`, `MEDIA_DIR`), run as a non-root user, and use
`/tvine/health` as the healthcheck. Run the worker as a second container: `tvine worker`.
