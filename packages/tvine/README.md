# Tvine

**The agent-native web framework.** Django-style TypeScript backend (ORM, migrations, auth, admin, background
tasks) plus a Next.js / React frontend, where AI agents use your app through a built-in MCP server and WebMCP.

The npm package is `tvinejs`; you import it and run it as `tvine`.

![Tvine admin dashboard](https://raw.githubusercontent.com/zohaib3249/tvine/main/docs/images/admin-dashboard-light.png)

## Install

Needs Node 22.15+.

```bash
npx tvinejs startproject my-app      # new project
npm install tvine@npm:tvinejs        # add to an existing project (import from 'tvine')
npm i -g tvinejs                     # optional: the global `tvine` command
```

## Quick start

```bash
npx tvinejs startproject my-app
cd my-app && pnpm install
pnpm exec tvine migrate
pnpm exec tvine createsuperuser
pnpm exec tvine dev
```

Open http://localhost:3000 (admin at `/admin`). Connect Claude Code with a `.mcp.json`:

```json
{ "mcpServers": { "my-app": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```

## Features

- **Agents and people use the same app.** Every action is an MCP tool; every page has a compact JSON view for agents.
- **Agents can drive the real UI** after the user clicks **Allow**; **Stop** takes it back.
- **Django in TypeScript:** models, migrations, QuerySets, generic views, `urls.ts`, auth, admin, tasks, cache, email.
- **Next.js pages** calling the backend through a typed `api.*` client.
- **Secure by default:** allowed hosts, CSP, CORS, sessions, 2FA, encrypted fields, human-only actions, confirm prompts.

## Docs

- [All guides](https://github.com/zohaib3249/tvine/blob/main/docs/README.md)
- [Installation](https://github.com/zohaib3249/tvine/blob/main/docs/installation.md) · [Getting started](https://github.com/zohaib3249/tvine/blob/main/docs/getting-started.md)
- [Settings and env](https://github.com/zohaib3249/tvine/blob/main/docs/settings-and-env.md) · [Models and ORM](https://github.com/zohaib3249/tvine/blob/main/docs/models-and-orm.md) · [Views, URLs and api.*](https://github.com/zohaib3249/tvine/blob/main/docs/views-urls-api.md)
- [Frontend: Weft](https://github.com/zohaib3249/tvine/blob/main/docs/frontend-weft.md) · [Agents and MCP](https://github.com/zohaib3249/tvine/blob/main/docs/agents-and-mcp.md) · [Admin](https://github.com/zohaib3249/tvine/blob/main/docs/admin.md)
- [Auth and security](https://github.com/zohaib3249/tvine/blob/main/docs/auth-and-security.md) · [Tasks, cache, email](https://github.com/zohaib3249/tvine/blob/main/docs/tasks-cache-email.md) · [Testing](https://github.com/zohaib3249/tvine/blob/main/docs/testing.md)
- [CLI](https://github.com/zohaib3249/tvine/blob/main/docs/cli.md) · [Deploy](https://github.com/zohaib3249/tvine/blob/main/docs/deploy.md)

Source and issues: https://github.com/zohaib3249/tvine. License: MIT.
