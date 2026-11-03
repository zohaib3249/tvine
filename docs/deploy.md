# Deploying Tvine

A Tvine app in production is two kinds of processes started from the same code, settings and environment:
**web workers** (`tvine start`) answer HTTP, **job workers** (`tvine worker`) run background jobs and schedules.
This page shows what runs where, typical setups, and process-manager files that start both.

Related guides: [cli.md](cli.md) (every command and flag), [tasks-cache-email.md](tasks-cache-email.md) (jobs, Redis
cache, SMTP), [reference/warp/contrib/tasks.md](reference/warp/contrib/tasks.md) (jobs reference),
[auth-and-security.md](auth-and-security.md) (hosts, CSP, CORS, secrets), [admin.md](admin.md) (System pages).

Commands below were run against an example store app built on Tvine unless marked otherwise.

## How a Tvine app runs in production

### Two kinds of workers

| | Web workers | Job workers |
|---|---|---|
| Command | `tvine start [--workers n\|auto]` | `tvine worker [--queues a,b] [--concurrency 10] [--beat]` |
| What they do | pages (Next), the API, `/mcp`, `/admin`, `/media`, the tab socket | the jobs `.delay()` queued; with `--beat` also the schedules (`cron` / `every`) |
| How many | 1 by default; `--workers n` / `auto` on one port; more than 1 needs every backend on Redis | any number, on any machine that reaches the broker; each runs `--concurrency` jobs at once (default 10) |
| Safe with several? | yes, once state is in Redis ([Scaling](#scaling)) | yes: a job is claimed with a lease, so it runs once; a dead worker's lease expires (30 s) and another worker takes the job |
| Schedules (`--beat`) | never | several `--beat` workers are safe: one holds the scheduler lock, the others stand by and take over within ~30 s (at once after a clean stop); each tick fires once |
| Stop (SIGTERM) | finish in-flight requests, exit (hard exit at 5 s) | stop claiming, let running jobs finish for `settings.tasks.graceMs` (30 s), put the rest back in the queue |

### What runs where

What happens to a job queued with `.delay()` and to a `schedule`, by what you start:

| You run | Queued jobs | Schedules (`cron` / `every`) |
|---|---|---|
| only `tvine start` (broker `file`, `db` or `redis`) | **wait forever**: the web server never runs jobs. About 30 s after start it prints once: `tvine start: background jobs are queued but no job worker is running. Start one: tvine worker --beat   (see docs/deploy.md#background-jobs)` | **never fire** |
| `tvine start` + `tvine worker` | run | never fire |
| `tvine start` + `tvine worker --beat` | run | fire, once per tick |
| `tvine start --with-worker [--beat]` | run inside the web process | fire with `--beat` |
| `tvine dev` or `tvine start` with broker `memory` (dev / tests) | run inside the web server (embedded worker), lost on restart; `tvine worker` refuses this broker | never fire, unless `tvine start --with-worker --beat` |

Check it any time: `tvine check` prints `tasks: 1 job worker(s) running · 0 job(s) waiting · scheduler on (…)` and
warns when jobs wait with no worker; the admin's System → Health shows a **Job workers** tile, red in that case.

### Typical setups

| Setup | Processes | Settings |
|---|---|---|
| One small server, one process | `tvine start --with-worker --beat` | defaults (SQLite, broker `file`); no Redis |
| One small server, two processes | `tvine start` + `tvine worker --beat` | defaults; no Redis |
| One 8-core server | `tvine start --workers 6` + `tvine worker --beat` + `tvine worker` (leave cores for the job workers) | Redis for the web backends ([Scaling](#scaling)); broker `file` is fine on one machine |
| Several servers + a load balancer | on each web server `tvine start [--workers auto]`; job workers on any servers (`tvine worker --beat` on two of them for a standby scheduler) | Redis for everything incl. `tasks: { broker: 'redis' }`; Postgres / MySQL |
| Containers | one container per process: `web` (`tvine start`), `worker` (`tvine worker --beat`), scale either | Redis + a real database ([Docker Compose](#docker-compose)) |

```bash
# one 8-core server
tvine start --workers 6          # web: 6 processes on :3000
tvine worker --beat              # jobs + the scheduler
tvine worker                     # more jobs (another 10 at a time)
```

`--with-worker` runs a job worker (and with `--beat` the scheduler) inside the web process: one process for a small
site. With `--workers` > 1 only web worker 1 runs it (it prints which). Jobs then share the CPU with requests, so a
busy site moves them to `tvine worker`. Stopping lets running jobs finish within the grace, like `tvine worker`.

### Brokers

Where queued jobs live (`settings.tasks.broker`, [reference](reference/warp/contrib/tasks.md#brokers)):

Tvine keeps **three stores** for background work: the **app database** (ORM models), **`settings.tasks.file`** (the default file broker's SQLite), and **Redis** (when `broker: 'redis'`). `tvine migrate` creates the `tasks_*` tables in the app database: Job ORM tables used by `broker: 'db'`, and `tasks_outbox` used when `durable: true` on any broker (web/worker relay drains it into the broker).

| Broker | Store | Web and job workers on | Notes |
|---|---|---|---|
| `file` (default) | its own SQLite file, `./tasks.db` (`settings.tasks.file`) | **one machine**: start every process from the same folder (the path is relative) | fastest; any number of processes |
| `db` | the `tasks_*` tables of the app's database | several machines that share the database | polled every `pollMs`; run `tvine migrate` |
| `redis` | `settings.redis.<tasks.redis>` | **several machines** | pushes wake-ups; needed with web workers on several servers |
| `memory` | inside one web process | dev / tests only | jobs lost on restart; refused with `--workers` > 1 |

### Process managers

Each example runs `tvine start` and `tvine worker --beat` from the app folder `/srv/shop` with the same environment.
In production `.env` files are not read (unless `TVINE_LOAD_DOTENV=1`): give the variables through the process
manager. (These files follow each tool's documented format; the two commands they run were run here, the
managers themselves were not.)

#### systemd

`/etc/systemd/system/shop-web.service`:

```ini
[Unit]
Description=shop web (tvine start)
After=network.target

[Service]
User=shop
WorkingDirectory=/srv/shop
EnvironmentFile=/srv/shop/production.env
ExecStartPre=/srv/shop/node_modules/.bin/tvine migrate
ExecStart=/srv/shop/node_modules/.bin/tvine start --workers auto
Restart=always
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/shop-worker.service`:

```ini
[Unit]
Description=shop job worker (tvine worker --beat)
After=network.target shop-web.service

[Service]
User=shop
WorkingDirectory=/srv/shop
EnvironmentFile=/srv/shop/production.env
ExecStart=/srv/shop/node_modules/.bin/tvine worker --beat
Restart=always
# running jobs get settings.tasks.graceMs (30 s) to finish
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

`production.env` holds `NODE_ENV=production`, `TVINE_SECRET=…`, `TVINE_ALLOWED_HOSTS=shop.example.com`,
`DATABASE_URL=…` (and `REDIS_URL=…` when used). `node` must be on systemd's `PATH` (`/usr/bin` or `/usr/local/bin`).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shop-web shop-worker
journalctl -u shop-worker -f          # worker <host>:<pid>:<id>: 3 task(s), broker file, queues *, concurrency 10, beat
```

#### Docker Compose

A Dockerfile is not shipped yet; a simple one for a project made with `tvine startproject`:

```dockerfile
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec tvine build && chown -R node:node /app
ENV NODE_ENV=production
USER node
CMD ["node_modules/.bin/tvine", "start"]
```

`compose.yaml`:

```yaml
services:
  web:
    build: .
    command: sh -c "node_modules/.bin/tvine migrate && exec node_modules/.bin/tvine start"
    ports: ["3000:3000"]
    env_file: production.env           # TVINE_SECRET, TVINE_ALLOWED_HOSTS, DATABASE_URL
    environment:
      REDIS_URL: redis://redis:6379
    depends_on: [redis]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/tvine/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 10s
    restart: unless-stopped
  worker:
    build: .
    command: ["node_modules/.bin/tvine", "worker", "--beat"]
    env_file: production.env
    environment:
      REDIS_URL: redis://redis:6379
    depends_on: [redis, web]
    stop_grace_period: 45s             # running jobs get settings.tasks.graceMs (30 s)
    restart: unless-stopped
  redis:
    image: redis:7
    restart: unless-stopped
```

Separate containers do not share a disk, so this uses `tasks: { broker: 'redis' }` (plus the Redis backends of
[Scaling](#scaling)) and a database server for `DATABASE_URL`. More job workers: `docker compose up -d --scale worker=3`
(several `--beat` are fine). `migrate` runs from `web` only. Keep `media/` (`settings.media.dir`) on a volume.

#### PM2

`ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    { name: 'web', cwd: '/srv/shop', script: 'node_modules/tvine/warp/bin/tvine.js', args: 'start --workers auto',
      env: { NODE_ENV: 'production' }, kill_timeout: 15000 },
    { name: 'worker', cwd: '/srv/shop', script: 'node_modules/tvine/warp/bin/tvine.js', args: 'worker --beat',
      env: { NODE_ENV: 'production' }, kill_timeout: 45000 },   // running jobs get 30 s to finish
  ],
}
```

```bash
pnpm exec tvine migrate
pm2 start ecosystem.config.cjs && pm2 save
```

Let `tvine start --workers` make the web processes (one PM2 app, fork mode) rather than PM2 `instances`: Tvine then
checks the shared state and restarts crashed web workers itself. Put the secrets in `env` or the shell PM2 starts from.

#### Procfile (Heroku, Dokku, foreman, honcho, …)

```
web: tvine migrate && tvine start
worker: tvine worker --beat
```

Run `migrate` from one place only (the web entry, or a release step) when several web copies start together.

## Production checklist

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

## Scaling

Web workers only; background jobs scale on their own ([Background jobs](#background-jobs)).

**One process (default).** `tvine start` runs one web worker. Sessions, the tab socket, rate limits and the snapshot
cache live in memory. Nothing else to run for the web side. Restarting logs everyone out of anonymous sessions (carts in the demo).
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

**Containers.** Often one web worker per container (the default) and you scale the number of containers; Redis is
still shared by all of them. Job workers are their own containers ([Docker Compose](#docker-compose)).

**Memory.** Each worker loads its own copy of the app (and of Next.js), so memory is about N × one worker
(backlog #46 is about lighter workers).

**Tab control works on every worker too.** With `channels: { backend: 'redis' }` the tab hub keeps its tabs,
approvals and control in Redis: the tab's event stream, its posts and the agent's calls may each reach a different
worker or server. An agent's command goes to whichever worker holds the tab's stream, and the tab's answer goes
back to the worker the agent is waiting on. No sticky sessions needed.

Split mode (Next on one server, `tvine start --api-only` on another) exists but is not recommended yet; don't
start there.

## Background jobs

Jobs (`tvine.tasks`) run in **job workers**, never in `tvine start` (except `--with-worker`, or broker `memory`).
Same code, same settings, same environment:

```bash
pnpm exec tvine worker                     # every queue, 10 at a time
pnpm exec tvine worker --queues mail --concurrency 4
pnpm exec tvine worker --beat              # also runs the schedules; several --beat workers are safe (one leads)
pnpm exec tvine tasks list --status dead   # ops: list / inspect <id> / retry <id> / purge --dead
```

| Safety check | What you see |
|---|---|
| `tvine start` with no job worker | ~30 s after start, once: `tvine start: background jobs are queued but no job worker is running. Start one: tvine worker --beat   (see docs/deploy.md#background-jobs)` (not in `tvine dev`, not with broker `memory` or `--with-worker`) |
| `tvine check` | `tasks: 2 job worker(s) running · 0 job(s) waiting · scheduler on (beat:host:pid:id)`; with 0 workers and jobs waiting: `tvine check: warning: N background job(s) are waiting and no job worker is running: start one with tvine worker --beat (see docs/deploy.md#background-jobs)` |
| Admin → System → Health | **Job workers** tile: `2 running · 0 waiting · scheduler: on (beat:…)`, red when jobs wait and no worker runs |
| `/tvine/health` | `tasks.workers`, `tasks.staleWorkers`, `tasks.queued` (alert on workers = 0 while queued grows) |

A job worker counts as running while it heartbeats (every 10 s with the default 30 s lease); a killed one turns
stale after the lease and its jobs go to another worker.

Default job store: `./tasks.db` (SQLite WAL, its own file, never the main database). Any number of processes on the
same machine share it; job workers on other machines need `tasks: { broker: 'redis' }` (or `'db'`)
([Brokers](#brokers)).

SIGTERM: the worker stops claiming, waits up to 30 s (`--grace`, `settings.tasks.graceMs`) for running jobs, then
puts unfinished ones back in the queue — no job is lost or run twice by a restart. A second signal exits at once.

## SQLite in production

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

## Postgres or MySQL

Set `DATABASE_URL` (or `settings.db.url`) and install the driver in the app:

```bash
pnpm add pg          # postgres://user:pass@host:5432/db   (or postgresql://)
pnpm add mysql2      # mysql://user:pass@host:3306/db      (or mariadb://)
DATABASE_URL='postgres://app:secret@db.internal:5432/shop' pnpm exec tvine migrate
```

Migrations are the same files on every engine. Pool: `settings.db.pool` (`max: 10` by default). Engines and
URLs: [models-and-orm.md](models-and-orm.md).

## Email

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
through a job worker with retries. See [tasks-cache-email.md](tasks-cache-email.md).

## Metrics

Prometheus text at `/tvine/metrics`, off by default:

```ts
metrics: { enabled: true, path: '/tvine/metrics', token: process.env.METRICS_TOKEN, allowIps: [] },
```

Scrape with `Authorization: Bearer <token>`, or from an address in `allowIps`. In production one of the two is
required (boot error otherwise); in dev, loopback requests are allowed. Anyone else gets a 404. The admin's
System → Metrics and Traffic pages show the same numbers without a scraper ([admin.md](admin.md)).

## Health and restarts

**Health:** `GET /tvine/health` → `200` JSON, `no-store`:

```json
{"tasks":{"queued":0,"scheduled":0,"running":0,"dead":0,"workers":1,"staleWorkers":0,"ageMs":139},
 "backends":{"session":"memory","channels":"memory",…},"ok":true,"uptime":3,"actions":57,"sessions":0}
```

Anyone else gets only `{"ok":true}`. The details above go to: `Authorization: Bearer <settings.health.token>`
(16+ characters), a signed-in staff session, or a direct request from 127.0.0.1/::1 with no `Forwarded` /
`X-Forwarded-*` / `X-Real-IP` header (a proxy on the same box does not count as local).

It says the process is up and serving. It does not ping the database; alert on `tasks.dead` and
`tasks.staleWorkers` growing, and on `tasks.workers` = 0 while `tasks.queued` grows (nobody runs the jobs).

**Zero-downtime restart.** On SIGTERM (or Ctrl-C) `tvine start` stops accepting connections, closes the event
streams and timers, and exits 0; if closing takes over 5 s it exits 1. So:

- one machine, several copies: restart them one at a time behind the load balancer (take one out, SIGTERM, start
  the new one, wait for `/tvine/health`, put it back);
- one process: there is a short gap while the new one boots; let the proxy retry;
- containers: `docker stop` sends SIGTERM (the image runs `tvine start` with `exec`, so it gets it directly);
- job workers: SIGTERM lets running jobs finish for up to `settings.tasks.graceMs` (30 s), so give them that long
  before a hard kill (systemd `TimeoutStopSec=45`, Compose `stop_grace_period: 45s`, PM2 `kill_timeout: 45000`).

