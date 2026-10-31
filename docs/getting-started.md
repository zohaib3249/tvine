# Getting started: a notes app in 15 minutes

You know Django and Next.js. Tvine is both in one TypeScript process: Django-style backend (Warp) and
Next.js pages (Weft). Every action you write is also an agent tool (MCP), and every page also has a JSON view for agents.

We build `examples/notes/` — it is in the repo, finished, so you can copy from it or compare.
Every command below was run as written.

> Packages are not on npm yet: build your app inside this repo (`examples/<name>/` or `apps/<name>/`, both are pnpm
> workspace folders) so `workspace:*` resolves.

## 0. Start a project

```bash
npm create tvine@latest mysite     # or: pnpm create tvine mysite  /  tvine startproject mysite
cd mysite
pnpm tvine migrate
pnpm tvine createsuperuser
pnpm tvine dev                     # http://localhost:3000: the Tvine welcome page, /admin, /mcp
pnpm tvine startapp notes --model Note    # apps/notes/: models, views, urls, admin, tests
pnpm tvine makemigrations && pnpm tvine migrate
```

Node 22.15 or newer. Until the packages are on npm, run it from a clone: `pnpm install && pnpm -r build`, then
`node packages/warp/bin/tvine.js startproject mysite ../mysite --local` (links the clone's packages).
What each file is: [conventions/scaffolding.md](design/conventions/scaffolding.md). The rest of this guide builds
`examples/notes/` by hand, file by file.

## 1. Project files

```
examples/notes/
├─ package.json        deps: @tvine/warp, @tvine/weft, @tvine/admin, next, react, zod
├─ settings.ts         Django settings.py
├─ urls.ts             Django ROOT_URLCONF (optional)
├─ next.config.ts
├─ apps/notes/         one Django app: models, views, urls, admin, tasks
├─ app/                Next.js pages
└─ components/
```

`package.json` — copy [examples/notes/package.json](../examples/notes/package.json); the scripts are:

```json
"build": "next build",
"start": "tvine migrate && tvine start"
```

`settings.ts`:

```ts
import { defineSettings } from '@tvine/warp'

export default defineSettings({
  site: { name: 'Notes', description: 'A tiny notes app built on Tvine.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin'],   // users, background jobs, /admin
})
```

Everything else is a default: SQLite at `./tvine.db`, jobs in `./tasks.db`. All keys:
[conventions/settings.md](design/conventions/settings.md).

`next.config.ts`:

```ts
export default {
  serverExternalPackages: ['@tvine/warp'],   // Warp is Node-only: never bundled
  compress: false,                            // Warp compresses; Next must not gzip twice
} satisfies NextConfig
```

## 2. A model and its migration

`apps/notes/models.ts`:

```ts
import { defineModel, field, type Infer } from '@tvine/warp'

export const Note = defineModel('note', {
  id: field.id(),
  title: field.text({ searchable: true }),
  body: field.text({ default: '' }),
  pinned: field.bool({ default: false }),
  words: field.int({ default: 0 }),   // filled in by a background task
})
export type Note = Infer<typeof Note>
```

```bash
cd examples/notes
pnpm exec tvine makemigrations     # → created notes/migrations/0001_initial.ts
pnpm exec tvine migrate            # → applied admin.0001_initial, auth…, notes.0001_initial, tasks…
```

Same as Django: migrations are code files you commit; `showmigrations`, `sqlmigrate`, `migrate <app> <target>`
(rollback) all exist. Run `pnpm exec tvine` for the full command list.

## 3. Views: a ListView plus `@action`

`apps/notes/views.ts` (shortened):

```ts
import { z } from 'zod'
import { action, defineAction, DomainError, ListView, type ViewCtx } from '@tvine/warp'
import { Note } from './models.ts'
import { countWords } from './tasks.ts'

const addParams = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(10_000).default('') })
const idParam = z.object({ id: z.number().int() })

export class NoteList extends ListView<Note> {      // → notes.list (?q= search, ?sort=, cursor pages)
  model = Note
  ordering = ['id', 'title']
  getQueryset() { return Note.objects.order('-pinned', '-id') }

  @action(addParams)                                 // → notes.add
  async add({ title, body }: z.infer<typeof addParams>, _ctx: ViewCtx) {
    const note = await Note.create({ title, body })
    return { note, job: await countWords.delay({ id: note.id }) }
  }

  @action(idParam)                                   // → notes.pin
  async pin({ id }: z.infer<typeof idParam>) { /* toggle pinned */ }

  @action(idParam, { rules: { confirm: { message: 'Delete this note for good?' }, destructive: true } })
  async remove({ id }: z.infer<typeof idParam>) {    // → notes.remove (asks first, see §7)
    return { deleted: await Note.objects.filter({ id }).delete() }
  }
}

export const clearAll = defineAction('clearAll', z.object({}), async () => ({ deleted: await Note.objects.delete() }),
  { humanOnly: 'Deleting every note', destructive: true })   // → notes.clearAll (humans only, see §7)
```

Action ids are `<app folder>.<name>`. Each request is one transaction (Django `ATOMIC_REQUESTS`). Params are
validated by the zod schema before your code runs. Generic views and every DRF hook:
[conventions/generic-views.md](design/conventions/generic-views.md).

Every action already answers at `POST /tvine/api/notes.add`. `urls.ts` adds REST paths if you want them:

```ts
// urls.ts
export const urlpatterns = [path('api/', include('notes.urls'))]
// apps/notes/urls.ts
export const appName = 'notes'
export const urlpatterns = [
  path('notes/', NoteList, { name: 'notes' }),                          // GET → notes.list
  path('notes/<int:id>/pin/', NoteList.action('pin'), { name: 'pin' }),
]
```

```bash
pnpm exec tvine show_urls
# /api/notes/               GET      notes:notes  notes.list
# /api/notes/<int:id>/pin/  POST     notes:pin    notes.pin
```

## 4. Admin

`apps/notes/admin.ts`:

```ts
import { admin, ModelAdmin } from '@tvine/warp/contrib/admin'
import { Note } from './models.ts'

class NoteAdmin extends ModelAdmin {
  listDisplay = ['title', 'pinned', 'words']
  listFilter = ['pinned']
  searchFields = ['title']
  str(n: any) { return String(n.title) }
}
admin.site.register(Note, NoteAdmin)
```

Warp serves it at `/admin` (no page file needed). Make a login:

```bash
TVINE_SUPERUSER_USERNAME=admin TVINE_SUPERUSER_EMAIL=admin@example.com \
TVINE_SUPERUSER_PASSWORD='change-me-please-42' pnpm exec tvine createsuperuser --noinput
```

(or plain `pnpm exec tvine createsuperuser` to be prompted). More: [contrib/admin.md](design/contrib/admin.md).

## 5. A page with `api.*`

Pages never import models. They call the backend through the typed client `api.*`, which runs in-process
(server components) or over `fetch` (client components). Generate its types first:

```bash
pnpm exec tvine generate           # → wrote tvine-api.d.ts
```

`app/layout.tsx` wraps the app in `<WeftRoot>` (agent badge, WebMCP, tab control). `app/page.tsx`:

```tsx
import { connection } from 'next/server'
import { Page } from '@tvine/weft'
import { Card } from '@tvine/weft/widgets'
import { api, must } from '@tvine/weft/api'
import { AddNote, ClearAll, NoteButtons } from '../components/notes.tsx'

type NoteRow = { id: number; title: string; body: string; pinned: boolean; words: number }

export default async function Notes() {
  await connection()
  const notes = must(await api.notes.list({})).items as NoteRow[]
  return (
    <Page name="notes" title="Notes">
      <h1>Notes</h1>
      <AddNote />
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            <Card entity={`note:${n.id}`} label={n.title} data={{ title: n.title, pinned: n.pinned, words: n.words }}>
              <strong>{n.title}</strong> <small>{n.words} words</small>
              <p>{n.body}</p>
              <NoteButtons id={n.id} />
            </Card>
          </li>
        ))}
      </ul>
      <ClearAll />
    </Page>
  )
}
```

`components/notes.tsx` is a client component: a plain `<form>` that calls `api.notes.add`, and Weft `<Button>`s
that call `api.notes.pin` / `api.notes.remove` then `router.refresh()`. `<Page>`, `<Card>` and `<Button>` are what
agents see; `entity="note:1"` gives each card a stable id. Widgets:
[frontend/v2/README.md](design/frontend/v2/README.md), the client: [api-client.md](design/frontend/v2/core/api-client.md).

`tvine check` fails if a page or component imports a model (the frontend/backend boundary).

## 6. Run it

```bash
pnpm exec tvine check              # settings + actions + migrations + boundary → ok: 35 actions
pnpm exec tvine dev --port 4400    # Next dev + HMR, tvine-api.d.ts regenerated on save
```

Open http://localhost:4400 and http://localhost:4400/admin.

Production-like run: `pnpm build` once, then `pnpm start` (needs `TVINE_SECRET`, see [deploy.md](deploy.md)).

## 7. What an agent sees

Same URL, agent header → JSON instead of HTML:

```bash
curl -s -H 'x-tvine: 1' http://localhost:4400/
# {"#tvine":"1 sid=… rev=0 page=notes view=full","page":"notes","title":"Notes","nodes":[
#   {"id":"note:1","kind":"note","label":"Hello","data":{"title":"Hello","pinned":false,"words":3}},
#   {"id":"note:1 > button:pin","kind":"button","label":"Pin","state":{}},
#   {"id":"note:1 > button:remove","kind":"button","label":"Delete","state":{}},
#   {"id":"button:clear-all","kind":"button","label":"Delete all notes","humanOnly":"Deleting every note","state":{}}]}
```

An agent runs an action by POSTing to the page with its `sid` (from the first line):

```bash
SID=…   # from "#tvine": "1 sid=…"
curl -s -X POST http://localhost:4400/ -H 'x-tvine: 1' -H "x-tvine-sid: $SID" \
  -H 'content-type: application/json' -d '{"action":"notes.pin","params":{"id":1}}'
```

**MCP.** Every action is an MCP tool at `/mcp`, plus `read_page`, `expand`, `ui`, `do`, `request_control`,
`release`. Connect Claude Code with `.mcp.json` next to where you run `claude`:

```json
{ "mcpServers": { "tvine-notes": { "type": "http", "url": "http://localhost:4400/mcp" } } }
```

The raw call, to see it without Claude:

```bash
curl -s -X POST http://localhost:4400/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_page","arguments":{"url":"/"}}}'
```

`tools/list` shows `notes_list`, `notes_add`, `notes_pin`, `notes_remove` — and no `notes_clearAll` (human only).

**Tab control.** With the page open in a browser, an agent calls `request_control`; the tab shows an **Allow**
button; after the human clicks it the agent drives the real page (and **Stop** takes it back). See
[agent-presence.md](design/frontend/v2/core/agent-presence.md).

**Inspector** (dev only): a split view of the human page and the agent's snapshot, with a live command feed.

```bash
pnpm exec tvine inspect http://127.0.0.1:4400 --port 7400   # → inspector on http://127.0.0.1:7400
```

It needs `@tvine/inspect` as a dev dependency (the example has it).

## 8. A background task

`apps/notes/tasks.ts`:

```ts
import { z } from 'zod'
import { defineTask } from '@tvine/warp/tasks'
import { Note } from './models.ts'

export const countWords = defineTask('countWords', async ({ id }) => {
  const note = await Note.get(id)
  if (!note) return { words: 0 }
  const words = note.body.split(/\s+/).filter(Boolean).length
  await Note.objects.filter({ id }).update({ words })
  return { words }
}, { args: z.object({ id: z.number().int() }) })
```

`notes.add` calls `countWords.delay({ id })`: the job is queued after the request commits, and the action answers
at once with `{ pending: true, jobId }`. Jobs live in `./tasks.db`, never in your main database. Run a worker in a
second terminal:

```bash
pnpm exec tvine worker
# info job.start … task=notes.countWords attempt=1
# info job.ok    … task=notes.countWords attempt=1 ms=2
pnpm exec tvine tasks list         # queued / running / dead jobs
```

Ctrl-C stops claiming and lets running jobs finish (30 s grace). Retries, cron, chains:
[contrib/tasks.md](design/contrib/tasks.md).

## 9. Sensitive actions: confirm and HumanOnly

Two levels, both in `views.ts` above.

**`rules.confirm`** — `notes.remove`. The first call runs nothing and answers `confirm_required` with a one-time
token (2 minutes, bound to this session and these exact params). Calling again with `$confirm` runs it.

```bash
curl -s -X POST http://localhost:4400/ -H 'x-tvine: 1' -H "x-tvine-sid: $SID" \
  -H 'content-type: application/json' -d '{"action":"notes.remove","params":{"id":1}}'
# "status":"err","code":"confirm_required","confirm":{"token":"eyIk…","message":"Delete this note for good?",…}
curl -s -X POST http://localhost:4400/ -H 'x-tvine: 1' -H "x-tvine-sid: $SID" \
  -H 'content-type: application/json' -d '{"action":"notes.remove","params":{"id":1,"$confirm":"eyIk…"}}'
# "status":"ok","action":"notes.remove","result":{"deleted":1}
```

In the browser, `api.notes.remove()` shows the confirm dialog and resends by itself. Use
`confirm: { by: 'human' }` when only the user may say yes.

**`humanOnly`** — `notes.clearAll`. Every agent path (MCP, `do`, the agent header, an agent driving the tab) gets
`human_only` (HTTP 403); a person's click works. In the page, wrap the control so agents see why:

```tsx
<HumanOnly reason="Deleting every note">
  <Button name="clear-all" onClick={…}>Delete all notes</Button>
</HumanOnly>
```

```bash
curl -s -X POST http://localhost:4400/ -H 'x-tvine: 1' -H "x-tvine-sid: $SID" \
  -H 'content-type: application/json' -d '{"action":"notes.clearAll","params":{}}'
# "code":"human_only","message":"only a human can do this here (Deleting every note); ask the user to do it …"
```

The wrapper alone is a UI guard; the `humanOnly` flag on the action is the real one. Always set the flag.
Details: [human-only.md](design/frontend/v2/widgets/human-only.md).

> Note: `POST /tvine/api/<id>` is the **frontend's** API (what `api.*` calls). It counts as a human request even
> with `x-tvine: 1`, so `humanOnly` does not stop it there — protect actions with permissions, not with
> `humanOnly` alone.

## Next

- Deploy: [deploy.md](deploy.md)
- The full reference app: `apps/demo-shop` (catalog, cart, checkout, uploads, admin)
- Everything else: the feature map in the [README](../README.md)
