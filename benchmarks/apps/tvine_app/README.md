# Tvine App

A [Tvine](https://github.com/zohaib3249/tvine) project: a TypeScript backend with models, migrations, auth and admin (Warp) + Next.js pages (Weft); every action is also an MCP tool.

```bash
pnpm install
pnpm tvine migrate
pnpm tvine createsuperuser
pnpm tvine dev            # http://localhost:3000 · /admin · /mcp
pnpm tvine startapp blog     # apps/blog + installedApps + config/urls.ts
```

| File | What it is |
|---|---|
| config/settings/base.ts, dev.ts, prod.ts | settings split per environment (TVINE_SETTINGS picks one) |
| config/urls.ts | root URL table |
| config/tasks.ts | Celery config: queues, beat schedule |
| apps/<name>/ | an app (listed in installedApps): models, views, urls, admin, migrations |
| app/ | Next.js pages (call the backend through `api.*`) |

AI assistants (Claude Code, Cursor, Copilot, Codex): read `AGENTS.md` first; the full docs are in `node_modules/tvine/llms-full.txt` and `node_modules/tvine/docs/` (reference, one topic per file: `docs/reference/warp/models.md`, `fields.md`, `actions.md`, `weft/widgets.md`…).

Claude Code: `.mcp.json` points at `http://localhost:3000/mcp`; start `tvine dev`, then run `claude` in this folder.
