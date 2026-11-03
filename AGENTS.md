# AGENTS.md: working on the Tvine framework

This repo is the framework itself. To **use** Tvine in an app, read [packages/tvine/AGENTS.md](packages/tvine/AGENTS.md)
instead. `tvine startproject` copies that file into every new project.

## Layout (pnpm monorepo, Node >= 22.15)

```
packages/tvine/           the single npm package `tvinejs` (imported as `tvine`)
  warp/src/               backend: core/ (actions, apps), data/ (ORM, fields, migrate), views/, transport/
                          (http, api, mcp, urls), security/, middleware/, contrib/ (auth, admin, tasks, audit…),
                          cli.ts (every `tvine` command), cli/scaffold.ts (startproject/startapp templates)
  warp/test/              vitest suites (pg/mysql/redis ones run only with TVINE_TEST_*_URL set)
  weft/src/               frontend: jsx runtime, widgets, forms, api client, presence, WebMCP
  admin/src/              the admin panel (React + Tailwind, bundled with esbuild)
  inspect/                `tvine inspect` devtool
  AGENTS.md               the AI guide for app builders (shipped in the package, written into new projects)
examples/notes/           the tutorial app (docs/getting-started.md), built against the workspace package
docs/*.md                 public user guides; docs/design/ is internal and must not be linked from public docs
llms.txt, llms-full.txt   LLM indexes at repo root (committed; generated). packages/tvine/llms* + docs/ are npm-only (--package), git-ignored
scripts/                  check-doc-links.mjs, build-llms.mjs
```

## Commands

```bash
pnpm install
pnpm -r build                          # every package (tsc + tailwind + esbuild) and examples/notes
pnpm test                              # every package's vitest
pnpm -C packages/tvine test            # the framework only
cd packages/tvine/warp && npx vitest run test/server/scaffold.test.ts   # one file
node scripts/check-doc-links.mjs       # docs links resolve and do not point into docs/design
pnpm build:llms                        # regenerate llms-full.txt after editing docs/ or packages/tvine/AGENTS.md
node packages/tvine/warp/bin/tvine.js startproject x ../x --local   # a scratch project linked to this clone
```

## Conventions

- Keep the existing API names and behavior, in camelCase (`listDisplay`, `getQueryset`, `atomicRequests`).
- No ORM or other heavy dependencies. Stay with the stdlib, the native platform, and what is already installed.
- Code is ESM TypeScript. Relative imports use `.js` in package source and `.ts` in projects and examples.
- Code that changes behavior comes with a vitest test next to similar tests in `warp/test/` (or the package's `test/`).
- A user-visible change updates the matching `docs/*.md`.
  It also updates `packages/tvine/AGENTS.md` when it touches layout, commands or recipes.
  Then run `pnpm build:llms`.
- Pages and components never import models. That boundary is enforced by `tvine check`; keep it that way.
- Commits: short imperative subject, `area: what changed`. No attribution trailers.
