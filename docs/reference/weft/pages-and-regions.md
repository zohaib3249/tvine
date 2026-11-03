# Pages, regions and custom widgets

## What it is

This page covers the primitives that structure what an agent sees: the server primitives `Page`,
`Section`, `Data`, `List`, `Link` (they emit `<script type="text/tvine">` fragments for headless agents),
the client contract `useWidget` / `defineWidget` / `WidgetScope` for making your own components
agent-readable, how ids are built, the auto-registration props of the Weft JSX runtime, progressive
disclosure (what an agent reads at L0 / L1 / full and how `expand` works), and live updates.

## Import

```ts
// server components (react-server build of tvine/weft)
import { Page, Section, Data, List, Link, registerAgent, useAgent, register, registerLink, pageFragment, bindAction } from 'tvine/weft'
// client components
import { useWidget, defineWidget, WidgetScope, useWidgetScope, useAgent, useTvineChannel, AgentBadge, AgentSuspense, WeftError,
         type WidgetSpec, type Control, type ControlCtx, type ParamSpec, type WidgetHooks } from 'tvine/weft'
```

---

## Server primitives

They work in server components only. Each scoping primitive (`Page`, `Section`, `Form`, `List`) walks the
JSX it was handed and passes a `scope` prop to every primitive it finds, which is how ids get their
prefix (`section:cart > form:shop.checkout`). Primitives rendered inside your own component are not seen
by that walk: use render-prop children `{(scope) => <Custom scope={scope} />}` and forward `scope`. Dev
warns when a container saw only components.

### Page

```ts
function Page(props: { name: string; title?: string; personal?: boolean; live?: boolean; children: ReactNode | ((scope: Scope) => ReactNode) }): JSX.Element
```

| Prop | Default | Meaning |
|---|---|---|
| `name` | required | Page id for agents (e.g. `product`). |
| `title` | `name` | Page title in the agent snapshot. This is not the document `<title>`; set that with Next `metadata`. In-tab reads use `document.title`. |
| `personal` | `false` | The page shows per-session content: never cached or shared. |
| `live` | `false` | The page changes without a write the server sees (time, another system): never cached, but not per-session. |

A route has exactly one `Page`; a literally nested `Page` throws in dev.

### Section

```ts
function Section(props: { name: string; as?: ElementType; className?: string; children: ReactNode | ((scope: Scope) => ReactNode) }): JSX.Element
```

Registers a node `section:<name>` and scopes everything inside under it. Renders `<section>` (or `as`).
Client widgets inside get the parent id too (`section:cart > button:checkout`).

### Data

```ts
function Data(props: { type: string; value: Record<string, unknown>; agentId?: string; personal?: boolean; live?: boolean; children?: ReactNode }): JSX.Element
```

An entity node: id `<type>:<value.id | value.key>`, or `agentId`. `value` is what the agent reads. Client
widgets inside are scoped under the **global** entity id (`product:12 > button:add`). Renders no element.

### List

```ts
function List<T>(props: {
  name: string; items: T[] | Paginated<T>; query?: URLSearchParams | Record<string, string | string[] | undefined>
  children: (item: T, i: number, scope: Scope) => ReactNode; as?: ElementType; className?: string
}): JSX.Element
```

Registers `list:<name>` with `{ name, count, pageSize?, nextCursor? }`. With a `Paginated` value only the
first `pageSize` rows register for agents (people still see all), and a `list:<name>:next` link is
added that keeps `query` and replaces `cursor`. Renders `<ul>` (or `as`).

### Link (server)

```ts
function Link(props: { href: string; label?: string; params?: string[]; personal?: boolean; live?: boolean; agentId?: string; as?: ElementType; children?: ReactNode; [k: string]: unknown }): JSX.Element
```

Registers `link:<href>` (or `agentId`) with the label (plain-text children, else `label`; dev throws when
neither). `as={NextLink}` for client navigation. `javascript:` / `data:` / `vbscript:` hrefs are not
exposed. Other props go to the rendered element.

### registerAgent / useAgent (server)

```ts
registerAgent(type: string, spec: AgentSpec): ReactElement      // also exported as useAgent on the server
interface AgentSpec { id?: string; data: Record<string, unknown>; actions?: { def: ActionDef; bind?: Record<string, unknown> }[]; personal?: boolean; live?: boolean }
```

Returns the fragment element; render it. Id is `<type>:<data.id | data.key>` unless `id` is given (throws
when neither exists). Low-level: `register(node)`, `registerLink(link, flags)`, `pageFragment({ page, title, personal?, live? })`.

### bindAction (server)

```ts
bindAction(def: ActionDef, bind?: Record<string, unknown>): ActionHandle
// ActionHandle = { id, params, bind, agent, ro?, danger?, attention?, humanOnly? } — plain JSON, safe to pass to a client component
```

Signs `bind` (with the action id inside, so a bind for A cannot be replayed on B) and lists the params
agents may send (bind-only params are hidden). `agent: false` when the action is `mcp: false` or
`denyAgents`. `ro`, `danger`, `attention`, `humanOnly` mirror `rules.readOnly`, `destructive`,
`humanAttention`, `humanOnly`. Throws if `bind` is given and no signer is configured (the server sets it at boot).

---

## Client widgets: `useWidget`

```ts
function useWidget<S extends Json>(spec: WidgetSpec<S>): Widget

interface Widget {
  id: string                                   // full id, e.g. 'product:12 > x-coupon:code'
  ref: (el: HTMLElement | null) => void        // put on your root element
  props: { 'data-tvine-id': string; 'data-agent-active'?: ''; 'data-agent-verb'?: ActionKind }   // spread on the root
  embed: ReactElement | null                   // the SSR fragment: render it once
  Scope: (p: { children: ReactNode }) => ReactElement   // wrap children so their ids nest under this one
  agent: { active: boolean; verb?: ActionKind }         // true while an agent acts on this widget
}
```

The four things to do: `ref={w.ref}`, `{...w.props}`, render `{w.embed}`, wrap children in `<w.Scope>`.

### WidgetSpec

| Field | Type | Meaning |
|---|---|---|
| `kind` | built-in kind or `` `x-${string}` `` | Built-ins: `section data card cart-badge button link pagination menu context-menu form input textarea select combobox checkbox radio switch slider date file quantity rating tabs accordion stepper dialog drawer popover tooltip toast list table tree carousel`. Custom: `x-…`. |
| `label` | `string` | Required, non-empty (dev throws). |
| `name` | `string` | Local id = `<kind>:<name>`. |
| `id` | `string` | Local id override. |
| `entity` | `string` | Global id (`product:12`); the widget's id IS this, ignoring the parent. |
| `state` | JSON | What the agent reads. Plain JSON only (dev throws on `Date`, `Map`, classes, `NaN`). |
| `controls` | `Record<string, Control>` | Agent controls (below). |
| `data` | `Record<string, unknown>` | Extra fields the agent reads. |
| `sum` | `string` | L0 one-liner. |
| `summary` | `string[]` | Data keys shown in the L1 view (for list rows); some built-ins put short text lines here. |
| `detail` | `string[]` | Data keys left out of L1 (shown in full / `expand`). |
| `hidden` | `string[]` | Data keys never shown to agents. |
| `collapsed` | `boolean` | One line until the agent calls `expand(id)`. |
| `changesContent` | `boolean` | Acting on it changes page content (built-in inputs set it). |
| `disabled` | `boolean` | Lists no controls. |
| `personal` | `boolean` | Marks the snapshot uncacheable. |
| `sensitive` | `boolean` | State becomes `{ filled: boolean }`; args masked in logs. |
| `humanOnly` | `string` | Locked with this reason (set for you inside `<HumanOnly>`). |
| `presence` | `false \| PresenceOptions` | Agent cursor / outline for this widget. |
| `hooks` | `WidgetHooks` | See below. |
| `rows` | `{ count; get(offset, limit) }` | Type exists for large row sets. Not covered: no code in this version reads it. |
| `children` | `(c: AutoChild) => AutoChild \| { label?, controls?, hooks?, presence? } \| false \| 'group'` | Policy for plain HTML auto-registered directly inside this widget (JSX runtime): `false` hides the child from agents, an object patches its label / controls (override rules) / hooks / presence. `AutoChild` = `{ id, role, name, label, href?, tag, props }`. `'group'` is reserved, not applied. |

The id must be computable without render order: give `name`, `id`, `entity`, or `data.id` / `data.key`
(string or number), else `useWidget` throws. Segment characters other than letters, digits, `_ . : @ / + -`
are replaced by `_` (dev logs); max 256 chars.

### Control

```ts
interface Control<A = Record<string, unknown>, R = Json | void> {
  kind: ActionKind                 // click input clear select toggle set open close submit navigate scroll focus move upload
  params?: { [K in keyof A]: ParamSpec }
  run(args: A, ctx: ControlCtx): R | Promise<R>
  enabled?: boolean                // false = not listed, not callable
  label?: string                   // shown to agents (and in the presence label)
  confirm?: boolean | string       // stored; Not covered: the executor does not prompt on it in this version
  headless?: HeadlessMap           // what a browser-less agent does instead
}
interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'date' | 'file' | 'json'
  enum?: readonly string[]; min?: number; max?: number; step?: number
  maxLength?: number; pattern?: string; multiple?: boolean; optional?: boolean; secret?: boolean
}
```

The executor checks args against `params` before calling `run`: unknown args, missing required args,
wrong types, `enum`, `min`/`max`, `maxLength`, `pattern` (full match) → `invalid_param`. `file` and `json`
are checked by your `run`. The signature agents see is like `choose(item: a|b|c)` or `qty(value: 1..10)`.

```ts
interface ControlCtx {
  source: 'agent' | 'gallery'; via: 'webmcp' | 'tab' | 'inspector'; cmdId: string
  signal: AbortSignal                 // aborted on Stop / timeout
  el: HTMLElement | null              // the widget's root
  presence: { point(el): Promise<void>; type(el, text): Promise<void>; say(text): void }
  run(action: ActionHandle, params?): Promise<{ ok: true; result?; goto? } | { ok: false; code; field?; message }>
  navigate(href: string): Promise<void>
  child(localOrFullId: string): WidgetHandle | undefined   // a descendant widget: { id, kind, state, call(control, args) }
  veto(reason: string): never                              // refuse with code 'domain'
}
```

Throw `new WeftError(code, message, reason?, field?)` from `run` to return a specific error code.
Each step has a 5 s timeout, a command 15 s, 20 steps max.

### HeadlessMap

What a browser-less agent (MCP over HTTP) does for a control:

| Shape | Meaning |
|---|---|
| `{ url: 'color', values?: 'enum' \| 'any' }` | Set `?color=<value>` on this page (a path instead of a name = GET that page). |
| `{ rendered: true }` | Nothing to do: the content is already in the HTML (tabs, accordion). |
| `{ params: ActionHandle, field? }` | Fill `field` of that server action. |
| `{ call: 'app.action', args? }` | Run `do <call>` with `args` + the agent's args. |
| `{ session: string, enum? }` | Type exists. Not covered: no built-in uses it. |

### Hooks

```ts
interface WidgetHooks {
  onAgentAction?(e: AgentActionEvent): void | false | string | Promise<…>   // false / string = refuse (code 'domain')
  afterAgentAction?(e: AgentActionEvent & { outcome: UiStepResult }): void  // always runs, refusal included
  onAgentFocus?(active: boolean): void
}
interface AgentActionEvent { target; control; args; via; cmdId; danger?: true; attention?: true | string; agent?: { name; verified: false } }
```

Order: the target widget, then every enclosing widget, then every mounted `<WeftRoot hooks>` (page-wide).
A throwing hook refuses with `internal hook error`. `danger` / `attention` come from the bound action's
`destructive` / `humanAttention`; the framework never refuses on them by itself. `HumanOnly` is checked
before any hook.

### Example: a custom coupon widget with `useWidget`

```tsx
'use client'
import { useState } from 'react'
import { useWidget, WeftError } from 'tvine/weft'
import { api } from 'tvine/api'

export function CouponBox() {
  const [code, setCode] = useState('')
  const [applied, setApplied] = useState<string | null>(null)
  const apply = async (c: string) => {
    const r = await api.cart.applyCoupon({ code: c })
    if (!r.ok) throw new WeftError(r.code, r.message, undefined, 'code')
    setApplied(c)
  }
  const w = useWidget({
    kind: 'x-coupon', name: 'coupon', label: 'Coupon code',
    state: { applied },
    controls: {
      apply: { kind: 'submit', params: { code: { type: 'string', maxLength: 20, pattern: '[A-Z0-9]+' } }, run: (a: { code: string }) => apply(a.code) },
      ...(applied ? { remove: { kind: 'clear', run: async () => { await api.cart.removeCoupon({}); setApplied(null) } } } : {}),
    },
  })
  return (
    <div ref={w.ref} {...w.props}>
      {w.embed}
      <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} agent={false} />
      <button onClick={() => apply(code).catch(() => {})} agent={false}>Apply</button>
      {applied && <p>Applied: {applied}</p>}
    </div>
  )
}
```

`agent={false}` (Weft JSX runtime) keeps the inner input/button from registering twice; the agent uses
`x-coupon:coupon` with `apply(code)` / `remove()`.

## `defineWidget`

The factory every built-in uses. It keeps internal state seeded from props, re-seeds when the props-derived
state changes (compared by JSON), and applies `controls` / `hooks` / `id` / `name` / `label` /
`disabled` / `presence` props for you.

```ts
function defineWidget<P, S extends Json, C extends Record<string, Control>>(def: {
  kind: WidgetKind | `x-${string}`
  state(props: P): S
  controls(api: { props: P; state: S; set(next: Partial<S>): void; el(): HTMLElement | null }): C
  headless?(props: P): Partial<Record<keyof C, HeadlessMap>>
  describe?(props: P): { label: string; summary?: string[] }
  spec?(props: P): Partial<WidgetSpec>          // e.g. { name, sensitive, personal, data, entity }
}): (props: DefinedProps<P, C>) => Widget & { state: S }
```

```tsx
'use client'
import { defineWidget, type DefinedProps } from 'tvine/weft'

type P = { name: string; sizes: string[]; value: string; onChange(v: string): void }
const useSizePicker = defineWidget<P, { value: string }, any>({
  kind: 'x-size',
  state: (p) => ({ value: p.value }),
  controls: ({ props: p, el }) => ({
    select: { kind: 'select', params: { value: { type: 'string', enum: p.sizes } },
      run: async (a: { value: string }) => { el()?.querySelector<HTMLButtonElement>(`[data-size="${a.value}"]`)?.click() } },
  }),
  describe: () => ({ label: 'Size' }),
  spec: (p) => ({ name: p.name }),
})

export function SizePicker(props: DefinedProps<P, any>) {
  const w = useSizePicker(props)
  return <div ref={w.ref} {...w.props}>{w.embed}
    {props.sizes.map((s) => <button key={s} data-size={s} aria-pressed={s === props.value} onClick={() => props.onChange(s)} agent={false}>{s}</button>)}
  </div>
}
```

Clicking the real button from `run` means the person-path `onChange` runs for agents too.

## `useAgent` (client)

```ts
useAgent(type: string, spec: { id?; label?; data: Record<string, unknown>; actions?: ActionHandle[]; personal?; live? }): ReactElement | null
```

A v1-compatible shortcut over `useWidget`: kind `data`, entity `<type>:<data.id|key>` (or a scoped `id`),
label from `label` / `data.name` / `data.title` / `type`. Each `ActionHandle` (from `bindAction` on the
server) becomes a `submit` control (one action → `submit`, several → named by action id). Render the
returned element. A raw `ActionDef` is ignored with a dev warning (clients cannot sign).

## `WidgetScope` / `useWidgetScope`

```ts
function WidgetScope(props: { id: string; entity?: boolean; children?: ReactNode }): JSX.Element
function useWidgetScope(): string        // the nearest enclosing widget's full id ('' = page)
```

Make client widgets inside nest under an id without registering a widget yourself (the server
primitives use it). `entity` = `id` is global, not joined to the parent.

## Ids, in one table

| Source | Local segment | Full id |
|---|---|---|
| `name="size"` on a `select` | `select:size` | `<parent> > select:size` |
| `id="sizes"` | `sizes` | `<parent> > sizes` |
| `entity="product:12"` | — | `product:12` (global) |
| `data={{ id: 7 }}`, kind `data` | `data:7` | `<parent> > data:7` |
| plain `<button name="buy">` (JSX runtime) | `button:buy` | `<parent> > button:buy` |
| plain `<a href="/cart">` | `link:/cart` | |
| server `Section name="cart"` | `section:cart` | |
| server `Form action={a}` | `form:<a.id>[:bind values]` | |

Same id twice in one scope: the first mount stays addressable, dev logs an error. The same entity in two
places (grid + "recently viewed") is fine: one node.

## JSX runtime props (plain HTML)

With `"jsxImportSource": "tvine/weft"`, every intrinsic element accepts:

| Prop | Meaning |
|---|---|
| `agent={false}` | Do not register this element or anything inside it. (`'group'` is reserved, not applied.) |
| `agentId` | Explicit name → `<role>:<agentId>`. |
| `agentLabel` | Label override. |
| `agentSensitive` | Value never shown (password inputs and `autocomplete=*password*`/`cc-*` are sensitive already). |
| `agentConfirm` | Stored on the control; Not covered: no prompt in this version. |

Elements that are disabled, `hidden`, `aria-hidden`, `aria-disabled` or `inert` are left out of the agent
view. `<WeftRoot auto={false}>` turns auto-registration off for the whole app.

## Progressive disclosure

The agent tool `read_page({ view })` returns the page at a chosen size:

| View | What |
|---|---|
| `md` | The page as compact Markdown with control ids inline. The tool description tells agents to start here. Supports `offset` / `limit`. |
| `auto` (default) | `full` if it fits ~4000 tokens, else `L1` if it fits, else `L0`. |
| `L0` | A map: up to 30 top nodes and 10 links, one line each (`label`, `sum`, what it offers). |
| `L1` | Depth 2, 5 rows per list, rows shown by their `summary` keys; repeated row controls folded into one `×N` line. |
| `full` | Everything. |

`expand({ id, offset?, limit? })` returns one node in full (rows paged). What you control per widget:
`sum` (the L0 line), `summary` (L1 row keys), `detail` (keys kept out of L1), `hidden` (never shown),
`collapsed` (one line until expanded). Tabs, accordion and tree render every panel in the HTML, so a
headless agent reads them without clicking.

## Live updates

| Tool | Use |
|---|---|
| `Page live` / `Data live` / `Link live` | Mark content that changes without a server write: never cached. |
| `personal` | Per-session content: never cached or shared. |
| `useTvineChannel({ enabled?, onUpdate? })` | Same-origin SSE on `/tvine/channel`. Returns `{ status: 'off'\|'connecting'\|'live'\|'expired', agentActive, lastEvent?, lastJob? }`. `onUpdate` fires when an agent changed something server-side (`source: 'agent'`), when a background job of this session finishes or bumps the rev, and on a `stale_rev` replay gap. `agentActive` turns off 30 s after the last agent event. |
| `AgentBadge({ active, className?, children? })` | Renders `<span data-tvine-agent-badge>` (default text `agent active`) while `active`. |
| `AgentSuspense({ fallback, children })` | A `Suspense` the agent runtime knows about: while its fallback shows, reads report `pending` and the settle rule waits for it (max 3 s). |

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { useTvineChannel, AgentBadge } from 'tvine/weft'

export function LiveCart() {
  const router = useRouter()
  const { agentActive } = useTvineChannel({ onUpdate: () => router.refresh() })
  return <AgentBadge active={agentActive}>An assistant is editing your cart</AgentBadge>
}
```

In the tab, the registry has a revision number (`rev`) that bumps on every mount, unmount and state
change; an agent `ui` call that sends an old `rev` gets `stale_rev` and a fresh L0 map.

## Gotchas

- Forgetting `{w.embed}` hides the widget from headless agents; forgetting `ref={w.ref}` breaks in-tab controls that read `ctx.el`.
- Do not use `useId` or list indexes in names: ids must be the same on the server and in every render.
- Server primitives inside your own components need the render-prop `scope` hand-off, or they register without their prefix / without a form.
- `state` is compared shallowly for `rev` bumps; build it from plain values.
- `Page title` is the agent's title, not `document.title`.

## See also

- [widgets.md](widgets.md) — the built-ins made with `defineWidget`
- [forms.md](forms.md) — `Form`, `Input`, `Button` primitives, `HumanOnly`
- [agents-in-the-browser.md](agents-in-the-browser.md) — the tools that read all this
- [overview.md](overview.md)
- [../warp/views.md](../warp/views.md) — ListView `Paginated` results for `List` / `Table`
