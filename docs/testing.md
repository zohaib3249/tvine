# Testing

Tvine's own tests and the demo use [Vitest](https://vitest.dev). `@tvine/warp/testing` is Django's test client:
it drives your app the way an agent does, in-process, with no port.

## Run the repo's tests

```bash
pnpm test                          # every package
pnpm --filter @tvine/warp test    # one package
cd apps/demo-shop && pnpm test     # the demo: 9 files, 38 tests, about 40 s (does a real next build first)
```

Postgres, MySQL and Redis suites are opt-in: they run when `TVINE_TEST_PG_URL`, `TVINE_TEST_MYSQL_URL` or
`TVINE_TEST_REDIS_URL` is set.

## Test your app

A test for the notes app: migrate a throwaway database, boot the server in-process, add a note as an agent.

```ts
// examples/notes/test/notes.test.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createAgentServer, type AgentServer } from '@tvine/warp'
import { agentClient } from '@tvine/warp/testing'

let server: AgentServer
beforeAll(async () => {
  const url = `file:${join(mkdtempSync(join(tmpdir(), 'notes-')), 'test.db')}`   // a throwaway database
  execFileSync('node_modules/.bin/tvine', ['migrate'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' })
  server = await createAgentServer({
    settings: { secret: 'k'.repeat(32), logging: 'none', db: { url } },
    appsDir: './apps',
  })
})
afterAll(() => server.close())

it('adds a note through the agent path', async () => {
  const c = agentClient(server)
  const { sid } = await c.get('/')                  // the first visit opens a session
  const r = await c.do('/', 'notes.add', { title: 'Hello', body: 'one two three' }, { sid })
  expect(r.status).toBe(200)
  expect(r.events[0]).toMatchObject({ kind: 'ok', action: 'notes.add', result: { note: { title: 'Hello' } } })
})
```

```bash
cd examples/notes
pnpm exec vitest run
# Test Files  1 passed (1)
```

## The API

| Function | What it does |
|---|---|
| `agentClient(server)` | `get(route)` → `{ status, snapshot, sid, raw }`; `do(route, action, params?, { sid, cmdId, node })` → `{ status, events, sid, raw }`; `session(sid)` for white-box checks |
| `snapshotOf(route, opts?)` | The agent snapshot of a page, normalized: commit it with `toMatchSnapshot()` and any change to what agents see fails CI until reviewed |
| `normalize(snapshot)` | Replaces sid, rev, binds and ISO timestamps with placeholders |
| `signedBind(action, payload, settings)` | The bind a page would sign for `<Form action bind={…}>`, for backend-only tests |

Signatures: [design/conventions/testing.md](design/conventions/testing.md).

## Full-stack tests

The demo boots a real `tvine start` child process on a temp database and a random port, then drives it over
HTTP and with headless Chrome (`playwright-core`). Copy its harness:
[apps/demo-shop/test/shop.ts](../apps/demo-shop/test/shop.ts) (boot, migrate, seed, stop) and
[apps/demo-shop/vitest.config.ts](../apps/demo-shop/vitest.config.ts) (one `next build` in `globalSetup`,
files run one after another).

## In CI

```bash
pnpm exec tvine check                    # settings, actions, migrations, page/model boundary
pnpm exec tvine makemigrations --check   # exit 1 if a model change has no migration
pnpm exec tvine generate --check         # exit 1 if tvine-api.d.ts is stale
```

## Gotchas

- `agentClient` needs a session: call `get()` first and pass its `sid` to `do()`. Without it the answer is
  `expired_sid` (401).
- The server does not create tables. Run `tvine migrate` on the test database first, or every write fails
  with `database error`.
- `r.events` holds the action result first, then a fresh snapshot.
- All `agentClient`s on one server share one IP rate-limit bucket (60/min by default). Raise
  `limits.rate` in test settings for long suites.
