# Frontend: Weft

Weft is the frontend half of Tvine, built on React 19 and Next.js 16 (App Router, server components, streaming).
What it adds: **every widget on the page can be read and operated by an AI agent**, through the same handlers a
person's click runs. You write normal React. Weft keeps a *control tree* (what is on the page, what each widget
can do) and serves it to agents as compact JSON.

## Setup

Three things, all already done in `examples/notes`:

1. **Dependencies:** `tvine/weft`, `tvine`, `next`, `react`, `react-dom`.
2. **`<WeftRoot>` in the root layout.** It runs the presence overlay, WebMCP tools, tab control and the dev
   gallery, and survives client navigation.

   ```tsx
   // app/layout.tsx
   import { WeftRoot } from 'tvine/weft'
   export default function RootLayout({ children }) {
     return <html lang="en"><body><WeftRoot>{children}</WeftRoot></body></html>
   }
   ```

3. **Plain HTML becomes controllable** with one `tsconfig.json` line:

   ```json
   { "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "tvine/weft" } }
   ```

   Now every `<button>`, `<a>`, `<input>`, `<select>`, `<textarea>`, `<form>` and `<details>` registers itself:
   an agent can click, type, select and submit it. Turn it off for a subtree with `agent={false}`, or everywhere
   with `<WeftRoot auto={false}>`.

`next.config.ts` needs `compress: false` (Warp compresses).

## Minimal usage

```tsx
import { Page } from 'tvine/weft'
import { Card } from 'tvine/widgets'
import { api, must } from 'tvine/api'

export default async function Notes() {
  const notes = must(await api.notes.list({})).items
  return (
    <Page name="notes" title="Notes">
      {notes.map((n) => (
        <Card key={n.id} entity={`note:${n.id}`} label={n.title} data={{ title: n.title }}>
          <strong>{n.title}</strong>
        </Card>
      ))}
    </Page>
  )
}
```

`entity="note:1"` gives the card a stable id across pages. An agent reading this page gets
`{"id":"note:1","kind":"note","label":"Hello","data":{...}}`, not HTML. Pages fetch data only through `api.*`
([views-urls-api.md](views-urls-api.md#the-api-client)).

## Widgets

Import from `tvine/widgets` (not the root entry). They are built on native HTML (`<dialog>`, the
Popover API, `<details>`, native inputs), with no Radix and no extra dependencies, and you style them with your
own CSS or Tailwind.

| Group | Widgets |
|---|---|
| Forms | `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `CheckboxGroup`, `RadioGroup`, `Switch`, `Slider`, `DatePicker`, `FileUpload` |
| Commerce | `Quantity`, `Swatch`, `ColorPicker`, `Rating`, `CartBadge` |
| Actions / navigation | `Button`, `Link`, `Pagination`, `Menu`, `ContextMenu` |
| Disclosure | `Tabs`, `Accordion`, `Stepper` |
| Overlays | `Dialog`, `Drawer`, `Popover`, `Tooltip`, `Toaster` + `toast()` |
| Collections | `Table`, `Card`, `Carousel`, `SortableList`, `Tree` |
| Guards | `HumanOnly` |

Each widget has a `name` (its id on the page, e.g. `select:sort`), a `label`, and controls the agent sees, e.g.
`select(value: price|-price|name)`. From the demo catalog (`components/CatalogControls.tsx`):

```tsx
<Select name="sort" label="Sort" url="sort" placeholder="Featured" options={SORTS}
  value={sort ?? ''} onValueChange={(v) => go('sort', v as string)} />
<Slider name="price__lte" label="Max price" url="price__lte" min={10} max={70} step={5}
  defaultValue={70} onValueChange={(v) => go('price__lte', String(v))} />
```

`url="sort"` is the **headless map**: it tells agents without a browser that this widget's value lives in the
`?sort=` query parameter, so `ui select:sort price` works over plain HTTP too. The other maps: `rendered` (all
content is already in the server HTML, the default for Tabs/Accordion), `params` (the value is a form param),
`session` (stored in the session). A widget that changes content with no map gets a dev error.

One doc per widget: [frontend v2 index](design/frontend/v2/README.md). Live gallery in dev: press
**Alt+Shift+W** on any page.

### Your own widgets: `useWidget`

```tsx
'use client'
import { useWidget } from 'tvine/weft'

export function ListOf({ name, label, children }) {
  const w = useWidget({ kind: 'list', name, label })
  return <ul ref={w.ref} {...w.props}>{w.embed}<w.Scope>{children}</w.Scope></ul>
}
```

The spec takes `kind`, `name` or `entity`, `label`, `state`, `data`, `controls` (named functions an agent may
call), `sum` (one-line summary), `hidden`, `sensitive`. `defineWidget(def)` makes a reusable kind. Contract:
[widget-contract.md](design/frontend/v2/core/widget-contract.md), custom control logic and veto hooks:
[custom-logic.md](design/frontend/v2/core/custom-logic.md).

## Forms (`tvine/forms`)

Django `ModelForm`-style forms built from field metadata. The admin uses them; any page can too.

```tsx
import { ModelForm } from 'tvine/forms'
import 'tvine/forms/forms.css'   // optional default look
```

Parts: `ModelForm` (fieldsets, client validation, server errors per field, dirty state), `Field`, `Fieldset`,
`InlineFormset` (tabular or stacked), `registerFieldWidget(kind | 'app.model.field', Component)` (Django
`formfield_overrides`).

### Input kinds

Base kinds: text, email, url, slug, uuid, textarea, int, decimal, money, bool, date, datetime, time, duration,
json, choice (radios or select, `multiple` for multi-select), fk (async autocomplete), m2m (chips +
autocomplete), file, image, password (show/hide), rich (rich text editor).

Extra kinds. Every kind is one agent target `field:<name>` with `set({value})` and `clear`, plus:

| Kind | Widget | Extra agent verbs |
|---|---|---|
| `color` | color picker + hex + swatches | |
| `range` | slider, two thumbs with `multiple` | |
| `phone` | country code + number → E.164 | |
| `search` | search box | |
| `tags` | chips, free text or `choices` | `add`, `remove` |
| `checkboxes` | checkbox list | `add`, `remove`, `toggle` |
| `switch` | toggle switch | `toggle` |
| `segmented` | segmented radios | `choose` |
| `rating` | stars | |
| `otp` | one-time code cells | (agents see only `{filled}`) |
| `markdown` | editor with preview | `append`, `read` |
| `code` | code editor with gutter | `read` |
| `daterange` | two dates | |
| `month` / `week` | native month / week | |
| `country` / `currency` | searchable select | `choose` |
| `address` | address block | |
| `keyvalue` | key/value rows | `add`, `remove` |
| `list` | rows of a sub-kind | `add`, `remove` |
| `percent`, `ip`, `slugAuto` | number + %, IPv4/6, slug built from another field | |
| `signature` | canvas → PNG | none: human only |

Agents are validated by the same rules as people and get the same error messages. Full table and limits:
[forms.md](design/frontend/v2/widgets/forms.md).

## Sensitive actions: `confirm` and `HumanOnly`

Two levels, set on the **backend** action ([views-urls-api.md](views-urls-api.md#rules-the-4th-argument-or-actionschema--rules-)):

- **`rules.confirm`**: the first call returns `confirm_required` with a one-time token (2 minutes, tied to the
  session and these exact params). In the browser, `api.*` shows a confirm dialog and resends by itself.
  `confirm: { by: 'human' }` means only a person may confirm.
- **`humanOnly`**: every agent path is refused with `human_only` (403). A person's click works.

In the page, wrap the control so agents see *why* it is locked:

```tsx
import { HumanOnly } from 'tvine/weft'
import { Button } from 'tvine/widgets'

<HumanOnly reason="Deleting every note">
  <Button name="clear-all" onClick={clearAll}>Delete all notes</Button>
</HumanOnly>
```

The agent sees `"humanOnly":"Deleting every note"` on the button and no controls. The wrapper is a UI guard;
the `humanOnly` flag on the action is the real one. Always set the flag.
Details: [human-only.md](design/frontend/v2/widgets/human-only.md).

## `<WeftRoot>` options

| Prop | Default | Meaning |
|---|---|---|
| `inTab` | `'on'` | `'off'` = remote agents can never control this tab |
| `presence` | on | `false` hides outline / cursor / labels (never the "Agent connected · Stop" pill), or `{ outline, cursor, label, typing: 'animate' \| 'instant', cps, holdMs, labels }` |
| `auto` | `true` | `false` = plain HTML is not auto-registered |
| `hooks` | none | `{ onAgentAction(e) }` etc.: audit or veto agent actions for the whole app |

Theme the agent overlay with CSS variables on `:root`: `--tvine-agent-color`, `--tvine-agent-contrast`,
`--tvine-agent-danger-color`, `--tvine-agent-ring`, `--tvine-agent-radius`, `--tvine-agent-font`,
`--tvine-agent-cursor-size`. See [agent-presence.md](design/frontend/v2/core/agent-presence.md).

## Settings that affect the frontend

```ts
agent: { shape: 'v2', budget: 1500, rowsL1: 10, inTab: 'on' },   // snapshot shape, token budget, rows per list
frontend: { boundary: 'error' },                                  // 'warn' while migrating
```

All settings: [settings-and-env.md](settings-and-env.md).

## CLI

| Command | Use |
|---|---|
| `tvine dev --port 4400` | Next dev + hot reload, regenerates `tvine-api.d.ts` |
| `tvine generate` | write the `api.*` types |
| `tvine check` | fails if a page imports a model |

All commands: [cli.md](cli.md).

## Gotchas

- **Next `<Link>` is not instrumented** (it renders through React's precompiled runtime). Use a plain `<a>` or
  Weft's `Link` widget.
- **`<el {...spread} key={k}>`** falls back to `createElement` and is not auto-registered. Put `key` before the
  spread or use a widget.
- **Widgets come from `tvine/widgets`.** The root entry exports an older `Input` with the same name.
- **Ids are names, not indexes.** Give widgets a `name` (or an `entity`) that is stable across renders; never
  `useId()`.
- **Sensitive inputs** (passwords, `cc-*` autocomplete, `otp`) show agents `{filled}` only. Agents can type into
  them but never read them.
- **Elements that are `disabled`, `hidden`, `inert`** or inside a disabled fieldset are not offered to agents.
- **React portals** escape the `HumanOnly` DOM guard (agent control stays locked). No built-in widget uses portals.
- **The in-tab confirm prompt** (`agentConfirm`) is accepted but not built yet. Use `rules.confirm` on the action.
