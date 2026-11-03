# Tvine guides

Tvine is the agent-native web framework: a TypeScript backend with models, migrations, auth and admin, a Next.js frontend, and a built-in MCP
server so AI agents can use your app. npm package `tvinejs`, imported and run as `tvine`.

| Guide | What it covers |
|---|---|
| [installation.md](installation.md) | Install, `startproject`, getting the `tvine` command |
| [getting-started.md](getting-started.md) | Tutorial: a notes app in 15 minutes |
| [settings-and-env.md](settings-and-env.md) | `settings.ts` keys, middleware catalog, logging, environment variables, `.env` |
| [models-and-orm.md](models-and-orm.md) | Models, fields (encrypted, humanOnly), QuerySets, await-or-not, migrations, fixtures |
| [views-urls-api.md](views-urls-api.md) | Actions, generic views, routers, `urls.ts`, the typed `api.*` client |
| [frontend-weft.md](frontend-weft.md) | Weft widgets, forms and input kinds, `HumanOnly`, confirm prompts |
| [agents-and-mcp.md](agents-and-mcp.md) | MCP setup (Claude Code, Claude Desktop), tools, `read_page` / `ui` / `do`, tab control and Allow, WebMCP, the inspector |
| [admin.md](admin.md) | Admin panel: ModelAdmin options, widgets, dashboard, charts, system pages |
| [shield.md](shield.md) | Bot protection: rules, challenges, code rules, country rules, the /shield panel, rate limits |
| [auth-and-security.md](auth-and-security.md) | Users, 2FA, tokens, sessions, permissions, ALLOWED_HOSTS, CSP/CORS, audit, privacy, encryption keys |
| [tasks-cache-email.md](tasks-cache-email.md) | Background tasks, cron, cache, email |
| [testing.md](testing.md) | Test client and helpers |
| [cli.md](cli.md) | Every `tvine` command |
| [deploy.md](deploy.md) | Production checklist, proxies, Redis, Docker |
| [releasing.md](releasing.md) | Publishing a new version |
