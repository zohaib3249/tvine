# Tvine

Tvine is a web framework for apps that people and AI agents both use.
You write Django-style backend code (models, migrations, views, admin) and Next.js pages, in TypeScript.
Every page also has a compact JSON view for agents on the same URL, and every action is also an MCP tool.
Agents can work through the real UI too: they read the page and click its widgets, or drive a user's open tab once the user clicks **Allow**.
It runs as one Node process: **Warp** is the server and **Weft** the frontend. The name is Icelandic for "twine two threads".

## Quick start

Needs Node 22.15+ and pnpm 9.

```bash
pnpm install
pnpm -r build                 # warp, weft, admin, inspect + the demo's next build
cd apps/demo-shop
pnpm demo                     # migrate, seed 60 products, serve on http://localhost:3000
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin. Create a login first:
  `TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput`
- What an agent sees: `curl -H 'x-tvine: 1' http://localhost:3000/`
- Health: http://localhost:3000/tvine/health

**Connect Claude.** Put this `.mcp.json` in the folder where you run `claude`. Claude Code then lists the shop's
tools (`read_page`, `ui`, `do`, `catalog_list`, `catalog_addToCart`, …):

```json
{ "mcpServers": { "tvine-shop": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```

Try asking it: "browse the shop, add two hats to the cart and check out". If you have the shop open in a browser,
it can ask to control that tab (`request_control`). You click **Allow**, and **Stop** takes control back.

Next: build your own app with [docs/getting-started.md](docs/getting-started.md). Ship it with
[docs/deploy.md](docs/deploy.md).

## Feature map

| Area | What you get | Docs |
|---|---|---|
| Settings | one `settings.ts` (Django `settings.py`) drives every subsystem | [settings.md](docs/design/conventions/settings.md) |
| Apps | `apps/<app>/{models,views,serializers,rules,urls,admin,tasks,hooks}.ts` | [apps-structure.md](docs/design/conventions/apps-structure.md) |
| ORM + migrations | own ORM (no third-party), QuerySet, relations, aggregates, Django-style migration files | [models-db.md](docs/design/conventions/models-db.md), [orm-queryset.md](docs/design/conventions/orm-queryset.md), [orm-advanced.md](docs/design/conventions/orm-advanced.md) |
| Databases | SQLite (default), Postgres, MySQL/MariaDB | [db-engines.md](docs/design/conventions/db-engines.md) |
| Views | `defineAction`, ListView/DetailView/ModelViewSet with all DRF hooks, `@action` | [generic-views.md](docs/design/conventions/generic-views.md) |
| URLs | `urls.ts`: `path`, `include`, routers, `reverse` | [urls.md](docs/design/conventions/urls.md) |
| Security features | every built-in protection (signing, encrypted fields, private media, sessions, notifications, `safeFetch`, privacy export/erase, staff hardening), its setting and default | [security-features.md](docs/design/conventions/security-features.md) |
| Permissions | DRF-style permissions, rate limits, `humanOnly`, `confirm` | [permissions.md](docs/design/conventions/permissions.md), [human-only.md](docs/design/frontend/v2/widgets/human-only.md) |
| Request | `request.user`, `request.agent`, `request.ip` | [request.md](docs/design/conventions/request.md) |
| Middleware + hooks | per-app middleware, `command`/`error`/`session` hooks, `ready()` | [middleware-hooks.md](docs/design/conventions/middleware-hooks.md) |
| Auth | users, groups, passwords, login throttling, TOTP, agent tokens (`tvine.auth`) | [auth.md](docs/design/contrib/auth.md) |
| Admin | Django admin at `/admin`, served by Warp (`tvine.admin`) | [admin.md](docs/design/contrib/admin.md) |
| Background tasks | `defineTask`, `.delay()`, retries, cron, chains, `tvine worker` (`tvine.tasks`) | [tasks.md](docs/design/contrib/tasks.md) |
| Cache / email / media | Django cache API, `sendMail` + SMTP, uploads | [cache.md](docs/design/conventions/cache.md), [email.md](docs/design/conventions/email.md), [media.md](docs/design/conventions/media.md) |
| Scaling | memory or Redis per subsystem, named connections | [backends.md](docs/design/conventions/backends.md) |
| Security | nonce CSP, headers, CORS, compression, signing, idempotency | [security-headers.md](docs/design/server/security-headers.md) |
| Frontend | `api.*` typed client, Weft widgets, JSX runtime | [api-client.md](docs/design/frontend/v2/core/api-client.md), [frontend v2](docs/design/frontend/v2/README.md) |
| Agents | snapshot format, progressive disclosure, MCP, tab control, WebMCP | [snapshot-format.md](docs/design/frontend/v2/core/snapshot-format.md), [transport-mcp.md](docs/design/server/transport-mcp.md), [agent-presence.md](docs/design/frontend/v2/core/agent-presence.md) |
| Dev tools | `tvine dev`, `tvine inspect` split-view inspector, testing helpers | [inspector.md](docs/design/inspect/inspector.md), [testing.md](docs/design/conventions/testing.md) |
| CLI | `tvine` with no arguments prints every command | [server-index.md](docs/design/server/server-index.md) |
| Overview | architecture and core types | [00-overview.md](docs/design/00-overview.md), [BACKLOG](docs/design/BACKLOG-v1.1.md) |

## Project layout

```
packages/
  warp/        @tvine/warp     server: dispatch, ORM + migrations, views, MCP/HTTP/SSE, auth/admin/tasks, CLI (tvine)
  weft/        @tvine/weft     frontend: widgets, api.* client, tab socket, WebMCP
  admin/       @tvine/admin    the /admin panel UI
  inspect/     @tvine/inspect  dev inspector (tvine inspect)
apps/
  demo-shop/   reference app: catalog, cart, checkout, uploads, admin; Dockerfile
examples/
  notes/       the getting-started app
docs/
  getting-started.md   tutorial
  deploy.md            production
  design/              module docs (the source of truth)
```

Tests: `pnpm test` (all packages), or `pnpm --filter @tvine/warp test`.
