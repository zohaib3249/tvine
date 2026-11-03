# Weft overview

## What it is

Weft is Tvine's frontend layer for React 19 / Next 16 (App Router). It does three things: it gives you
widgets (buttons, selects, tables, dialogs…) that AI agents can read and operate the same way a person
does; it gives you `api.*`, a typed client for the backend's actions, which is the frontend's only data
path; and it runs the in-browser agent runtime (WebMCP tools, remote tab control with an Allow prompt,
the agent cursor and the Stop pill). Every page an app builds with Weft is "agent-readable": each widget
registers itself with an id, kind, label, state and a list of controls an agent may call.

## Import

```ts
import { WeftRoot, Page, Section, Data, HumanOnly, useWidget, defineWidget } from 'tvine/weft'
import { Button, Select, Table, Dialog, toast, Toaster } from 'tvine/widgets'
import { ModelForm, Field } from 'tvine/forms'
import 'tvine/forms/forms.css'                 // optional default look for tvine/forms
import { api, must, currentUser } from 'tvine/api'
```

| Path | What is in it | Server or client |
|---|---|---|
| `tvine/weft` | `WeftRoot`, `HumanOnly`, `AgentSuspense`, `WidgetScope`, `useWidget`, `defineWidget`, `useAgent`, `useTvineChannel`, `AgentBadge`, `connectTab`, `openConnect`, `registerWebMcp`, `WeftError`, `ACTION_KINDS`, `signature`, all widget contract types. Under the `react-server` condition it also exports the server primitives `Page`, `Section`, `Data`, `List`, `Form`, `Input`, `Button`, `Link`, plus `bindAction`, `register`, `registerLink`, `pageFragment`, `registerAgent`, `setSigner`, `setDispatcher`. | both (condition-switched) |
| `tvine/weft/server` | the server entry directly (same as `tvine/weft` under `react-server`) | server |
| `tvine/widgets` | every built-in widget (see [widgets.md](widgets.md)), `HumanOnly`, slot helpers `part`, `useControllable` | `'use client'` modules; a server component may render them |
| `tvine/forms` | `ModelForm`, `Fieldset`, `InlineFormset`, `Field`, `registerFieldWidget`, value helpers | client |
| `tvine/forms/forms.css` | default CSS for `tvine/forms` (`tf-*` classes) | CSS |
| `tvine/api` | `api`, `must`, `ApiError`, `currentUser`, `UserProvider`, `useUser`, confirm helpers | both (condition-switched) |
| `tvine/weft/jsx-runtime`, `tvine/weft/jsx-dev-runtime` | the JSX runtime that auto-registers plain HTML | both |
| `tvine/weft/dev` | the dev widget gallery (`mountDevtools`); `WeftRoot` loads it itself in dev | client, dev only |

TypeScript does not know the `react-server` condition, so for types `tvine/weft` shows the client API and
the server primitives together. At runtime a server primitive (`Page`, `Section`, …) exists only in a
server component; in a client bundle it is absent.

## Setup (two steps)

1. Put `<WeftRoot>` in the root layout:

```tsx
// app/layout.tsx
import type { ReactNode } from 'react'
import { WeftRoot } from 'tvine/weft'

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><WeftRoot>{children}</WeftRoot></body></html>
}
```

2. Optional but recommended: make plain HTML agent-controllable with the Weft JSX runtime:

```json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "tvine/weft" } }
```

With it, every `<button>`, `<a href>`, `<input>`, `<select>`, `<textarea>`, `<form>`, `<details>` and any
element with `onClick`/`onChange`/`onInput`/`onSubmit` or a known ARIA role registers as a widget on its own.

## How a page is agent-readable

Every widget calls `useWidget(spec)` (built-ins do it through `defineWidget`). That does two things:

- **SSR fragment.** It renders a `<script type="text/tvine">` JSON descriptor next to the widget:
  `{"v":2,"k":"w","w":{id,p,kind,label,state,ctl,…}}`. The server reads these to answer a headless agent
  (MCP over HTTP, no browser).
- **In-tab registry.** In the browser it registers an entry in a per-tab registry (one per tab, on
  `globalThis`). WebMCP tools and remote tab control read this registry and call controls on it.

What an agent sees for each widget:

| Field | Meaning | Example |
|---|---|---|
| `id` | path of local segments joined by ` > ` | `form:checkout > input:email` |
| `kind` | widget kind (closed list, custom kinds start with `x-`) | `select` |
| `label` | human label (required; dev throws without it) | `Size` |
| `state` | JSON state (sensitive widgets show only `{filled}`) | `{"value":"m"}` |
| `ctl` | controls: name → `{kind, in (params), h (headless map)}` | `select(value: s\|m\|l)` |
| `e` | global entity id, when the widget is an entity | `product:12` |
| `data`, `summary`, `detail`, `collapsed`, `sum` | extra data and disclosure hints | see [pages-and-regions.md](pages-and-regions.md) |
| `ho` | HumanOnly reason; no controls are listed | `Confirm this action` |

Ids are built from names, never from render order: a widget's local segment is `<kind>:<name>` (or its
`id` prop, or `<kind>:<data.id|data.key>`), joined to the nearest enclosing widget. Entity widgets
(`Card entity="product:12"`) use the entity as a global id, so the same product in two places is one node.

Agents act through **controls**. A control has a `kind` from a closed verb list: `click input clear select
toggle set open close submit navigate scroll focus move upload`. Built-in controls act on the real DOM
element (native value setter + `input`/`change` events, or a real `.click()`), so your `onChange` /
`onClick` handlers run exactly as for a person. A disabled control is not listed and not callable.

## Server components vs client components

| You write | Use |
|---|---|
| Server component (default in `app/`) | read data with `await api.<app>.<name>(params)` from `tvine/api`; render built-in widgets from `tvine/widgets` directly (they are client references); use `Page`, `Section`, `Data`, `List`, `Form`, `Input`, `Button`, `Link` from `tvine/weft`; sign server actions for client widgets with `bindAction(def, bind)` |
| Client component (`'use client'`) | call `api.*` in handlers; use widgets, `useWidget`, `defineWidget`, `HumanOnly`, `useTvineChannel`; never call `bindAction` (it needs the server signer) |

Functions cannot cross the server → client boundary, so hooks (`<WeftRoot hooks>`, widget `hooks`) and
callbacks go in an app-owned `'use client'` wrapper.

## The `api.*` client

`api.<app>.<name>(params, opts?)` calls the backend action `<app>.<name>`. It never throws; it returns
`{ ok: true, data } | { ok: false, code, message, … }`. `must(result)` returns the data or throws. In a
server component it dispatches in-process (or over signed HTTP in split mode); in the browser it POSTs to
`/tvine/api/<id>` with the session cookie. Types come from the generated `tvine-api.d.ts`
(`tvine generate`, regenerated by `tvine dev`). Full reference: [api-client.md](api-client.md).

## The frontend boundary

Frontend code must not import models or the ORM. `tvine check` (and `tvine dev`, on every change) bundles
every file under `app/`, `src/app/`, `components/`, `src/components/` and every `'use client'` file, and
fails when any of them reaches, directly or through a helper:

- anything under `apps/` (models, views),
- the runtime names `defineModel`, `field`, `QuerySet`, `Paginator`, `connections`, `atomic`,
  `configureDb` (or `import *`, or a dynamic import) from `tvine`,
- `tvine/migrations`, `tvine/auth`, `tvine/contrib/*`.

`import type` is fine (erased). The fix it prints: add a view in `apps/<app>/views.ts` and call it with
`must(await api.<app>.<name>(params))`. Setting `settings.frontend.boundary = 'warn'` turns errors into
warnings.

## Example: a product list page

```tsx
// app/products/page.tsx (server component)
import { Page } from 'tvine/weft'
import { Card } from 'tvine/widgets'
import { api, must } from 'tvine/api'
import { AddToCart } from '../../components/add-to-cart'   // a 'use client' file with a <Button name="add">

type Product = { id: number; name: string; price: string; stock: number }

export default async function Products() {
  const items = must(await api.shop.list({})).items as Product[]   // ListView rows are untyped: say their shape
  return (
    <Page name="products" title="Products">
      {items.map((p) => (
        <Card key={p.id} entity={`product:${p.id}`} label={p.name} href={`/products/${p.id}`} data={{ price: p.price, stock: p.stock }}>
          <AddToCart productId={p.id} />
        </Card>
      ))}
    </Page>
  )
}
```

An agent reading this page sees `product:1 … product:N` (kind `card`, control `navigate`), each with its
own `product:N > button:add` (control `click`).

## Gotchas

- Every widget needs a non-empty `label` and a stable name; dev throws otherwise.
- Two widgets with the same id in one scope: the first stays addressable, dev logs an error. Give one a
  different `name`.
- Widget `state` must be plain JSON (dev throws on a `Date`, `Map`, class instance).
- `<WeftRoot>` must live in the root layout so the registry, tab socket and nav watcher survive client
  navigations.
- `HumanOnly` is a UI guard. The security guard is the action's `rules.humanOnly`.

## See also

- [widgets.md](widgets.md) — every built-in widget
- [forms.md](forms.md) — forms, field kinds, validation, uploads, HumanOnly, confirm
- [api-client.md](api-client.md) — `api.*`, errors, auth, agent marking
- [pages-and-regions.md](pages-and-regions.md) — Page / Section / Data / List, custom widgets, ids, disclosure, live updates
- [agents-in-the-browser.md](agents-in-the-browser.md) — WebMCP, tab control, presence, Stop, testing
- [../warp/actions.md](../warp/actions.md), [../warp/views.md](../warp/views.md) — the backend actions `api.*` calls
