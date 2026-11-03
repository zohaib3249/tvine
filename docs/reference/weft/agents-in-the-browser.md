# Agents in the browser

## What it is

The Weft runtime lets an AI agent work inside a person's open browser tab, as that person, while they
watch. There are two ways in: **WebMCP** (an agent built into the browser calls tools the page registers)
and **remote tab control** (an agent connected to the site's MCP server calls `request_control`, the person
clicks Allow, and the agent's commands run in their tab). Both use the same in-tab registry and executor,
show the same agent cursor, outline and Stop pill, and run the same widget hooks. `<WeftRoot>` turns all
of it on; most apps write no extra code.

## Import

```ts
import { WeftRoot, registerWebMcp, connectTab, openConnect, useTvineChannel, AgentBadge, HumanOnly,
         type PresenceOptions, type WidgetHooks } from 'tvine/weft'
```

## `<WeftRoot>`

```ts
function WeftRoot(props: {
  children?: ReactNode
  hooks?: WidgetHooks            // page-wide agent hooks (veto, audit)
  auto?: boolean                 // false: no auto-registration of plain HTML inside
  inTab?: 'on' | 'off'           // 'off': no WebMCP tools and no tab socket
  presence?: false | PresenceOptions   // false: no outline/cursor/label (the Stop pill always shows)
}): JSX.Element
```

| Prop | Default | Meaning |
|---|---|---|
| `hooks` | — | `onAgentAction` / `afterAgentAction` / `onAgentFocus` for every widget on the page. Several mounted roots stack (innermost first). Functions: pass them from an app-owned `'use client'` wrapper. |
| `auto` | `true` | `false` keeps the JSX runtime but skips auto-registering plain HTML. |
| `inTab` | `'on'` | On in production too. `'off'` is the app's opt-out. |
| `presence` | `{}` | See "Presence". |

What it mounts: the presence overlay settings, the navigation watcher, the WebMCP tools, the tab socket,
the confirm dialog (`ConfirmHost`), and in development only the widget gallery (Alt+Shift+W) — in a
production build that code is not in the bundle. Put it in the **root layout** so it survives client
navigations.

```tsx
// components/agent-root.tsx
'use client'
import type { ReactNode } from 'react'
import { WeftRoot, type WidgetHooks } from 'tvine/weft'

const hooks: WidgetHooks = {
  onAgentAction: (e) => (e.danger ? 'Ask the customer before deleting anything' : undefined),
  afterAgentAction: (e) => console.info('agent', e.target, e.control, e.outcome.ok),
}
export function AgentRoot({ children }: { children: ReactNode }) {
  return <WeftRoot hooks={hooks} presence={{ typing: 'animate' }}>{children}</WeftRoot>
}
```

## The four page tools

Both WebMCP and remote tab control expose the same four operations:

| Tool | Input | Does |
|---|---|---|
| `read_page` | `{ view?: 'md' \| 'auto' \| 'L0' \| 'L1' \| 'full', offset?, limit? }` | Reads the page from the in-tab registry (`md`: Markdown with control ids inline; others: JSON widgets with ids, state, controls). See [pages-and-regions.md](pages-and-regions.md#progressive-disclosure). |
| `expand` | `{ id, offset?, limit? }` | One node in full. |
| `ui` | `{ target, control, args? }` or `{ steps: [{ target, control, args? }…] }`, plus `cmdId?`, `rev?` | Operates widgets the way a person would. |
| `do` | `{ action, params?, cmdId? }` | Advanced: runs a server action directly (POST to the current page with the agent header). Page hooks do not apply; server permissions do. |

### `ui` results

```ts
// ok
{ kind: 'ok', action: 'ui', result: { cmdId, rev, page, steps: StepResult[], touched: { id, kind, label, state? }[], map? } }
// error
{ kind: 'err', code, message, reason?, field?, maybeApplied?, result: { … same as above … } }
// StepResult
{ i, target, ok: true, state?, result? } | { i, target, ok: false, code, reason?, field?, message, maybeApplied? }
```

| Rule | Value |
|---|---|
| Steps per command | 1–20; run in order; stop at the first failure; nothing is undone |
| Step timeout | 5 s (`reason: 'timeout'`, `maybeApplied: true` → read again before retrying) |
| Command timeout | 15 s |
| Idempotency | the same `cmdId` returns the stored result (last 32 kept) |
| Concurrency | one command at a time per tab |
| `rev` | if given and the page changed, `stale_rev` plus a fresh L0 `map` |
| Navigation | a step that changed the page returns a fresh L0 `map`; URL-driven controls wait for the new page to settle |
| Disabled widget (busy form) | `code: 'domain', reason: 'disabled'` — retry shortly |
| Missing control, hidden widget, behind an open modal, agent-off action | `unknown_action` |
| Inside `HumanOnly` | `human_only` |
| Vetoed by a hook | `domain`, `reason: 'veto'` |
| Stop pressed | `domain`, `reason: 'stopped'` |

When the person navigated (or used back/forward) since the agent's last read, the next result carries
`notice: "human navigated /a → /b"`. While an `AgentSuspense` fallback is showing, results carry `pending: n`.

Agent navigation (`Link`, `Card`, `Pagination`, plain `<a>`) is same-site only (http(s), same origin);
anything else fails with `reason: 'forbidden'`. It clicks the real link (so Next transitions and your
`onClick` run), then waits until the URL matches and the registry is quiet for 100 ms (max 3 s).

## WebMCP (in-browser agents)

```ts
registerWebMcp(opts?: { header?: string; agent?: string }): () => void   // WeftRoot calls this; returns unregister
```

- Registers `read_page`, `expand`, `ui`, `do` on `document.modelContext` or `navigator.modelContext`
  (`registerTool` with an abort signal, or the older `provideContext`). If neither exists it does nothing
  (dev logs one info line).
- The first tool call shows the pill **"Agent connected · Stop"** (or `"<agent> (unverified) connected"`
  when `agent` is passed). Stop → **"Agent stopped · Resume"**; every tool then returns
  `reason: 'stopped'` until Resume. Stop survives a reload for the session (sessionStorage).
- While a remote agent controls the tab, WebMCP calls get `reason: 'busy'`.
- `api.*` calls your handlers make during a WebMCP step are marked as agent calls on the server.
- `header` (default `x-tvine`) is the header the `do` tool and bound actions send to mark agent requests.

## Remote tab control (`request_control` → Allow → Stop)

The flow, step by step:

1. An agent connected to the site's MCP server calls `request_control`. It gets an `approveUrl` (the site
   with `?tvine-approve=<id>`) and a short code, and tells the person.
2. The person opens the link in their signed-in tab. Weft strips the param from the address bar, opens the
   tab's own stream (`/tvine/channel?tab=<id>&doc=<nonce>`) and asks the server for the request.
3. The **Allow prompt** appears in a closed shadow root that page CSS and scripts cannot reach:
   *Unverified agent "<name>" wants to control this tab. It will act as you; you can press Stop at any
   time.* — **Deny** / **Allow**. The name is the agent's own claim, shown as text, always "unverified".
4. Allow only counts for a real (trusted) click or Enter/Space that starts on the button, at least 500 ms
   after the prompt appeared, while the page is visible and focused (focus or visibility changes re-arm the
   500 ms). Synthetic clicks do nothing.
5. On approval the pill shows **"Unverified agent "<name>" connected · Stop"**. The agent's `read_page` /
   `ui` / `expand` / `do` calls are forwarded to the tab, run by the in-tab executor with the tab's cookie,
   and answered by a POST back to the server.
6. **Stop** releases control at once (running steps are aborted) and keeps retrying the release until the
   server confirms; after a reload the tab still refuses to resume silently.

Other ways in and edge cases:

| Case | Behaviour |
|---|---|
| `?tvine-connect` in the URL, or `openConnect()` | Opens the **Connect box**: the person types the code the agent gave them (max 12 chars). |
| Link expired or used | Notice: "This agent request expired or was already used (links work once, for 5 minutes). Ask the agent for a new link." |
| Server unreachable | Notice: "Could not reach the site to load the agent request…" |
| A WebMCP agent active in the last 5 minutes | The new request is refused (`busy`) and the person sees a notice. |
| Page inside a frame | Tab control never starts (the prompt must not be clickjackable). |
| Reload while controlled | The tab reconnects and keeps the session's state. |

```ts
connectTab(): () => void     // WeftRoot calls this; returns cleanup
openConnect(): void          // show the Connect box (e.g. behind a "Connect an assistant" menu item)
```

```tsx
'use client'
import { openConnect } from 'tvine/weft'
export const ConnectAssistant = () => <button type="button" onClick={() => openConnect()}>Connect an assistant</button>
```

## Presence (cursor, outline, label, pill)

While a control runs, the runtime draws (in a closed shadow root on the top layer, `<tvine-presence>`):
an **outline** around the widget, a **label** ("Agent clicked Add to cart", "Agent: typing… Email",
"Agent selected in Size"), and a **cursor** that glides to the target for `click`, `select`, `toggle`,
`open`. The **pill** with Stop is always shown while an agent is connected; `presence={false}` never hides it.
Destructive actions (`rules.destructive`) use the danger colour and set `data-agent-danger` on the widget.

```ts
interface PresenceOptions {
  outline?: boolean            // default true
  cursor?: boolean             // default true
  label?: boolean              // default true
  typing?: 'animate' | 'instant'   // default 'instant'; 'animate' types per character
  cps?: number                 // characters per second when animating; capped at 40
  holdMs?: number              // outline stays after the step, default 600
  labels?(e: { verb: ActionKind; label: string; control: string }): string   // your own label text (i18n)
}
```

Text over 200 characters is always set at once. Under `prefers-reduced-motion` nothing animates.

Theme with CSS custom properties on the page (they inherit into the shadow root):

| Variable | Default |
|---|---|
| `--tvine-agent-color` | `#7c3aed` |
| `--tvine-agent-contrast` | `#fff` |
| `--tvine-agent-danger-color` | `#dc2626` |
| `--tvine-agent-font` | `500 12px/1.2 system-ui` |
| `--tvine-agent-ring` | `2px` |
| `--tvine-agent-radius` | `6px` |
| `--tvine-agent-cursor-size` | `20px` |

The pill's font, size, z-index and text colours are fixed, so a theme cannot make Stop invisible.

Style the widget itself while an agent works on it with its attributes:

```css
[data-agent-active] { box-shadow: 0 0 0 2px var(--tvine-agent-color); }
[data-agent-verb="input"] { background: #faf5ff; }
[data-agent-danger] { outline-color: #dc2626; }
```

## The page channel (live updates and agent activity)

`useTvineChannel` and `AgentBadge` show "an agent changed something" for server-side agent work (an MCP
agent calling actions for this session). See [pages-and-regions.md](pages-and-regions.md#live-updates).

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { useTvineChannel, AgentBadge } from 'tvine/weft'
export function CartWatcher() {
  const router = useRouter()
  const { agentActive, lastJob } = useTvineChannel({ onUpdate: () => router.refresh() })
  return <><AgentBadge active={agentActive} />{lastJob && <p>{lastJob.task}: {lastJob.status}{lastJob.progress !== undefined && ` (${lastJob.progress})`}</p>}</>
}
```

## What the developer has to do

Usually nothing beyond `<WeftRoot>` in the root layout. Then, as needed:

| Want | Do |
|---|---|
| Keep agents off a button / area | `<HumanOnly reason="…">`, and `rules.humanOnly` on the action |
| Refuse some agent actions | `onAgentAction` hook on a widget or on `<WeftRoot hooks>` |
| Ask before destructive server actions | `rules.confirm` on the action (the confirm button is human-only) |
| No in-tab agents at all | `<WeftRoot inTab="off">` |
| Hide the cursor/outline | `<WeftRoot presence={false}>` or `presence={false}` per widget |
| A "Connect an assistant" entry point | call `openConnect()` |

## Testing it

| Tool | How |
|---|---|
| `tvine dev` | Runs Next in-process with the API, regenerates `tvine-api.d.ts`, re-runs the FE boundary check on change. Debug on (inspector feed). |
| Widget gallery | In dev, press **Alt+Shift+W** on any page: this page's widget tree (state, controls with signatures, headless maps, auto vs declared, agent-hidden), the built-in widget catalog, and **try it as agent** — runs a control through the real executor, hooks and presence (`via: 'inspector'`). |
| `tvine inspect [url] [--port 7357]` | Split-view devtool on 127.0.0.1, dev only. Its Widgets tab shows the framed page's widget tree and the agent commands run there. |
| A real agent | Point an MCP client at the site's MCP server, call `request_control`, open the `approveUrl`, click Allow; or use a WebMCP-capable browser. |

Not covered: the inspector's full feature list (it lives in `packages/tvine/inspect`, outside `weft/src`).

## Gotchas

- `HumanOnly` stops in-tab agents and synthetic events, but `do` / MCP / HTTP can still call the action unless the action has `rules.humanOnly`.
- `do` skips page hooks by design. Put rules that must always hold on the server action.
- During a **remote-tab** step, `api.*` calls your own handlers make are not marked as agent calls (only WebMCP steps set the mark in this version). See [api-client.md](api-client.md#agent-marking).
- Agent-typed text is instant unless `typing: 'animate'`; tests that watch keystrokes need that.
- The Allow prompt cannot be clicked by scripts, test runners that fake events, or an agent: approve it by hand.

## See also

- [overview.md](overview.md), [widgets.md](widgets.md), [pages-and-regions.md](pages-and-regions.md), [forms.md](forms.md), [api-client.md](api-client.md)
- [../warp/actions.md](../warp/actions.md) — `rules.humanOnly`, `rules.confirm`, `destructive`, `mcp: false`
