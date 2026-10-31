# Deploying Tvine

One Node process serves everything: the Next.js pages, `/tvine/*` (agent API, tab socket), `/mcp`, `/admin` and
`/media`. Run one process by default; add copies plus Redis when one is not enough. A separate `tvine worker`
runs background jobs.

Commands below were run against `apps/demo-shop` unless marked otherwise.

## 1. Production checklist

| Item | What to do |
|---|---|
| `TVINE_SECRET` | Required. 32+ random chars: `export TVINE_SECRET=$(openssl rand -hex 32)`. Without it `tvine start` and `NODE_ENV=production tvine check` exit 1 with this exact hint. It signs session-bound tokens (binds, confirm tokens). |
| Secret rotation | Pass a list in `settings.ts`: the first key signs, every key verifies. `secret: [process.env.TVINE_SECRET!, process.env.TVINE_SECRET_OLD!].filter(Boolean)`. Deploy with the new key first, drop the old one after the longest token lifetime (bind expiry; confirm tokens live 2 min). |
| `NODE_ENV` | `tvine start` sets `production` when unset (like `next start`). `tvine dev` refuses to run under `production`. |
| Build | `pnpm build` (`next build`) before `tvine start`; without `.next/` the server runs API-only. |
| `trustProxy` | `settings.trustProxy` = how many proxies sit in front (1 behind one load balancer/CDN). It decides `request.ip` (rate limits), https detection, the `Secure` cookie flag and HSTS. Leave `0` when clients reach Node directly — a client can then not fake `X-Forwarded-*`. |
| HTTPS | Terminate TLS at the proxy and set `trustProxy`. HSTS is sent only on https requests (checked: with `TVINE_TRUST_PROXY=1` and `X-Forwarded-Proto: https` the demo answers `strict-transport-security: max-age=31536000; includeSubDomains`; on plain http it does not). |
| CSP / headers | On by default: nonce CSP with `strict-dynamic`, `X-Content-Type-Options`, `Referrer-Policy`, COOP/CORP, `Permissions-Policy`, `X-Frame-Options`. Tune under `settings.security.headers` ([security-headers.md](design/server/security-headers.md)). CORS is closed by default (`settings.cors`). |
| Compression | Warp compresses (gzip/br, with its BREACH rule). Set `compress: false` in `next.config.ts` (boot warns otherwise). |
| Email | Set `settings.email` (below). Boot warns while `defaultFrom` is still `webmaster@localhost`. |
| Gate | `NODE_ENV=production pnpm exec tvine check` in CI: settings, secret, every backend + Redis ping, pending migrations, frontend-imports-models boundary. Exit 1 on any problem. |

```bash
export TVINE_SECRET=$(openssl rand -hex 32)
NODE_ENV=production pnpm exec tvine check     # … ok: 40 actions
pnpm build
pnpm start                                      # = tvine migrate && tvine start  (PORT or --port, default 3000)
```

## 2. One process, or several copies

**One process (default).** Sessions, the tab socket, rate limits and the snapshot cache live in memory. Nothing
else to run. Restarting logs everyone out of anonymous sessions (carts in the demo).

**Several copies** (more CPU, rolling deploys, more than one machine): point every subsystem at a shared Redis in
`settings.ts` — one connection, named once, used by name:

```ts
redis: { default: { url: process.env.REDIS_URL! } },    // or just set REDIS_URL
session:       { backend: 'redis' },
channels:      { backend: 'redis' },
limits:        { backend: 'redis' },
snapshotCache: { backend: 'redis' },
caches:        { default: { backend: 'redis' } },
tasks:         { broker: 'redis' },                     // only when workers run on other machines
```

`npm i redis@6` in the app. `tvine check` prints every backend and pings Redis (exit 1 if it is down). Use a
real database (Postgres/MySQL) too — several copies cannot share one SQLite file over the network.

**Sticky routing for tab control.** A browser tab's agent connection lives on the copy that holds its event stream.
Route these to the same copy per session (cookie `tvine_s`, or header `x-tvine-sid`): `/tvine/channel`,
`/tvine/tab/*`, `/tvine/agent/*`, and `/mcp` (for `request_control`). Everything else can go anywhere.
Details: [backends.md](design/conventions/backends.md).

Split mode (Next on one server, `tvine start --api-only` on another) exists but is parked (BACKLOG #37); don't
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

Migrations are the same files on every engine. Pool: `settings.db.pool` (`max: 10` by default). Engines:
[db-engines.md](design/conventions/db-engines.md).

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
through the worker with retries. See [email.md](design/conventions/email.md).

## 7. Metrics

Not built yet: a `/tvine/metrics` endpoint is being added (task-prodpack). Until then, use the `command` hook
(`apps/<app>/hooks.ts`: called after every action with its outcome) to feed your own metrics client
([middleware-hooks.md](design/conventions/middleware-hooks.md)).

## 8. Health and restarts

**Health:** `GET /tvine/health` → `200` JSON, `no-store`:

```json
{"tasks":{"queued":0,"scheduled":0,"running":0,"dead":0,"workers":1,"staleWorkers":0,"ageMs":139},
 "backends":{"session":"memory","channels":"memory",…},"ok":true,"uptime":3,"actions":40,"sessions":0}
```

It says the process is up and serving. It does not ping the database; alert on `tasks.dead` and
`tasks.staleWorkers` growing.

**Zero-downtime restart.** On SIGTERM (or Ctrl-C) `tvine start` stops accepting connections, closes the event
streams and timers, and exits 0; if closing takes over 5 s it exits 1. So:

- one machine, several copies: restart them one at a time behind the load balancer (take one out, SIGTERM, start
  the new one, wait for `/tvine/health`, put it back);
- one process: there is a short gap while the new one boots; let the proxy retry;
- containers: `docker stop` sends SIGTERM (the image runs `tvine start` with `exec`, so it gets it directly).

## 9. Docker

`apps/demo-shop/Dockerfile` (multi-stage, pnpm, `next build`, non-root user, `/data` volume, healthcheck).
Build from the repo root:

```bash
docker build -f apps/demo-shop/Dockerfile -t tvine-demo .
docker run -p 3000:3000 -e TVINE_SECRET=$(openssl rand -hex 32) -v tvine-data:/data tvine-demo
docker run -e TVINE_SECRET=… -v tvine-data:/data tvine-demo node_modules/.bin/tvine worker
```

The volume holds `tvine.db` (+ WAL), `tasks.db` and `media/` (env `DATABASE_URL`, `TASKS_DB`, `MEDIA_DIR`).
Ignore rules: `apps/demo-shop/Dockerfile.dockerignore` (BuildKit uses it for this Dockerfile).

The image was not built while writing this (Docker hangs on the docs machine). Its steps were run by hand instead:
`pnpm install --frozen-lockfile`, `pnpm --filter "@tvine/demo-shop..." build`,
`pnpm --filter @tvine/demo-shop deploy --prod <dir>`, then `tvine migrate && tvine start` and the
`HEALTHCHECK` command from that directory with `NODE_ENV=production` — all worked.
