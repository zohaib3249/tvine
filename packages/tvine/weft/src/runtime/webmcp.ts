'use client'
import { disclose, expand, toTree, UNTRUSTED, UNTRUSTED_TOOL, type WidgetFrag } from 'tvine/shape'
import type { ActionHandle, ActionOutcome } from '../widget/types.js'
import { getOverlay } from '../presence/overlay.js'
import { autoExcluded } from '../jsx/AutoEl.js'
import { describeWidget } from './fragment.js'
import { getRegistry, type RegistryNode } from './registry.client.js'
import { isStopped, runUi, setStopped, type UiCommand } from './exec.js'
import { currentPage, markSeen, navNotice, pendingRegions, settle } from './nav.js'

// WebMCP adapter (transports.md §WebMCP): read_page, expand, ui, do for an in-browser agent in the
// user's own tab. read_page/expand/ui run locally on the registry; do POSTs. Registered by <WeftRoot>
// by default, in production too (security.md). Stop blocks every tool until the human clicks Resume.
// The httpOnly session cookie is the agent's session: never read or sent from JS.

type McTool = {
  name: string
  description: string
  inputSchema: object
  annotations?: object
  execute: (args: any) => Promise<{ content: { type: 'text'; text: string }[] }>
}
type ModelContext = {
  registerTool?: (t: McTool, o?: { signal: AbortSignal }) => unknown
  unregisterTool?: (name: string) => unknown
  provideContext?: (c: { tools: McTool[] }) => unknown
}

let warned = false

// The ONE place that knows the (churning) WebMCP API shape. Returns an unregister fn.
function provideTools(tools: McTool[]): () => void {
  const g = globalThis as any
  const mc: ModelContext | undefined = g.document?.modelContext ?? g.navigator?.modelContext
  if (!mc) {
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true
      console.info('[tvine] WebMCP (modelContext) not available; adapter is a no-op')
    }
    return () => {}
  }
  const ac = new AbortController()
  if (mc.registerTool) {
    // Current API: removal is by aborting the signal given at registration.
    for (const t of tools) {
      try {
        Promise.resolve(mc.registerTool(t, { signal: ac.signal })).catch(devWarn)
      } catch (e) { devWarn(e) }
    }
    // Fallback for older builds that ignore the signal but have unregisterTool.
    ac.signal.addEventListener('abort', () => tools.forEach((t) => { try { mc.unregisterTool?.(t.name) } catch {} }))
    return () => ac.abort() // idempotent
  }
  // Oldest shape. NOTE: this fallback's unregister clears ALL page tools, not just ours.
  mc.provideContext?.({ tools })
  return () => { mc.provideContext?.({ tools: [] }) }
}

function devWarn(e: unknown) {
  if (!warned && process.env.NODE_ENV !== 'production') {
    warned = true
    console.info('[tvine] WebMCP registration failed', e)
  }
}

// randomUUID is undefined on non-secure contexts (plain http).
export function newId(): string {
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  const b: Uint8Array = c.getRandomValues(new Uint8Array(16))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

type Text = { content: { type: 'text'; text: string }[] }
const reply = (v: unknown): Text => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const errOut = (code: string, message: string, extra: object = {}) => reply({ kind: 'err', code, message, ...extra })

// Tool descriptions are versioned constants (transports.md). `ui` before `do`: agents act through the UI.
export const DESCRIPTIONS = {
  read_page: 'Read the current page as a structured snapshot (JSON): widgets with ids, state and controls. Call this first, and again after acting. view: auto|L0|L1|full.' + UNTRUSTED_TOOL,
  expand: 'Show one node of the page in full (all fields, children, controls). Use the id from read_page. Lists page with offset/limit.' + UNTRUSTED_TOOL,
  ui: 'Operate a widget on the page the way a person would: target = widget id from read_page, control = one of its listed controls (e.g. select, input, open, submit), args as listed. Several steps run in order and stop at the first error. Send a new cmdId per change.',
  do: 'Advanced: run a server action directly. Prefer ui on the page\'s widgets. Page-level agent vetoes do not apply here; server permissions do. Call read_page first for actions and params. Retries with the same cmdId are safe.',
} as const

// The in-tab snapshot: the registry's widgets through the same shaper Warp uses (tvine/shape).
function tree() {
  const widgets: WidgetFrag[] = []
  const walk = (n: RegistryNode, p: string) => {
    for (const c of n.children) {
      // Auto (plain-HTML) entries that are inert / hidden / aria-hidden / disabled: left out with their subtree.
      if (c.spec && autoExcluded(c.spec)) continue
      // Any widget (built-ins too) behind an open modal: the background is inert, so skip it with its subtree.
      if (c.el?.closest('[inert]')) continue
      if (c.spec) {
        const d = describeWidget(c.id, p, c.spec)
        // Controls bound to an agent-off action are not shown (the executor refuses them alike).
        if (d.ctl) for (const [k, v] of Object.entries(d.ctl)) if ((v.h as { params?: ActionHandle } | undefined)?.params?.agent === false) delete d.ctl[k]
        widgets.push({ ...d, ...(c.spec.sensitive && { sensitive: true }) } as WidgetFrag)
      }
      walk(c, c.id)
    }
  }
  walk(getRegistry().tree(), '')
  const l = (globalThis as any).location
  return toTree({ page: l.pathname + l.search, title: globalThis.document?.title ?? '', nodes: [], links: [], widgets }, { headless: false })
}

// ponytail: tolerant read of the Warp reply (json envelope or bare event).
function outcome(text: string): ActionOutcome {
  let j: any
  try { j = JSON.parse(text) } catch { return { ok: false, code: 'internal', message: text.slice(0, 200) } }
  const evs: any[] = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : [j]
  const e = evs.find((x) => x && (x.kind === 'ok' || x.kind === 'err' || x.kind === 'goto' || x.status === 'ok' || x.status === 'err' || x.status === 'goto'))
  const kind = e?.kind ?? e?.status
  if (kind === 'err') return { ok: false, code: e.code, message: e.message, ...(e.field && { field: e.field }) }
  if (kind === 'goto') return { ok: true, goto: e.url }
  return { ok: true, ...(e?.result !== undefined && { result: e.result }) }
}

const pageUrl = () => { const l = (globalThis as any).location; return l.pathname + l.search }

// A server action FOR an agent: same-origin POST with the httpOnly cookie, the agent header, and the
// downgrade-only `agentCmd` marker (control-protocol.md): dispatch sets agent.is=true, via webmcp|channel.
export async function agentPost(body: object, header = 'x-tvine'): Promise<string> {
  try {
    const res = await fetch(pageUrl(), {
      method: 'POST', credentials: 'same-origin',
      headers: { [header]: '1', 'content-type': 'application/json', accept: 'application/tvine+json' },
      body: JSON.stringify(body),
    })
    return await res.text()
  } catch (e) {
    // Thrown messages never reach the agent; return the error as a value.
    return `err internal "network error: ${(e instanceof Error ? e.message : String(e)).replace(/"/g, "'")}"`
  }
}

// Who controls this tab right now (security.md: an in-browser and a remote agent never at once).
export const tabControl = { remote: false, webmcpAt: 0 }
const WEBMCP_ACTIVE_MS = 300_000
export const webmcpActive = () => !tabControl.remote && !isStopped() && Date.now() - tabControl.webmcpAt < WEBMCP_ACTIVE_MS

type Obj = Record<string, unknown>
// navigation-spa.md: tell the agent when the page moved under it (human click, back/forward), let a client
// transition settle before reading, and say `pending` while streamed regions are open.
export async function withNav<T>(fn: () => Promise<T>): Promise<T | Obj> {
  const notice = navNotice()
  await settle()
  const out = await fn()
  const pending = pendingRegions()
  markSeen()
  if ((!notice && !pending) || !out || typeof out !== 'object' || Array.isArray(out)) return out
  return { ...(out as Obj), ...(notice && { notice }), ...(pending && { pending }) }
}

// The page tools that run IN the tab on the registry: for an in-browser agent (WebMCP) and for a remote
// agent's forwarded command (via 'tab'), and the dev gallery's "try it as agent" (via 'inspector',
// source 'gallery': same executor, hooks and presence). Results are plain JSON values.
export function pageTools(via: 'webmcp' | 'tab' | 'inspector', header?: string, source?: 'gallery') {
  // the server tells a dev try-it apart from a real agent (still agent-marked; Warp honors 'inspector' in dev only)
  const agentVia = via === 'webmcp' ? 'webmcp' : via === 'inspector' ? 'inspector' : 'channel'
  const run = async (h: ActionHandle, params: Record<string, unknown>, cmdId: string) =>
    outcome(await agentPost({ action: h.id, params, bind: h.bind, cmdId, agentCmd: { cmdId, via: agentVia } }, header))
  return {
    read_page: async ({ view }: { view?: 'auto' | 'L0' | 'L1' | 'full' } = {}): Promise<Obj> =>
      ({ '#data': UNTRUSTED, rev: getRegistry().rev, ...disclose(tree(), { budget: 4000, rowsL1: 5, view: view ?? 'auto', allowL0: true }) }),
    expand: async ({ id, offset, limit }: { id: string; offset?: number; limit?: number }): Promise<Obj> => {
      const x = expand(tree(), String(id), { offset, limit })
      return x ? { '#data': UNTRUSTED, ...x } : { kind: 'err', code: 'unknown_action', message: `no node ${id}; ids come from read_page` }
    },
    ui: async (cmd: UiCommand): Promise<Obj> => {
      const from = currentPage()
      const { result, error } = await runUi(cmd, { via, run, ...(source && { source }) })
      // stale_rev, or a step that changed the page (navigate), carries a fresh L0 map so the agent
      // can re-plan without another call.
      const map = error?.code === 'stale_rev' || result.page !== from ? disclose(tree(), { budget: 0, rowsL1: 0, view: 'L0' }).nodes : undefined
      return error ? { kind: 'err', ...error, result: { ...result, ...(map && { map }) } } : { kind: 'ok', action: 'ui', result: { ...result, ...(map && { map }) } }
    },
    // a backend action (advanced path): POSTed from this page with its cookie, agent-marked
    do: async ({ action, params, bind, cmdId }: { action: string; params?: object; bind?: string; cmdId?: string }): Promise<Obj | string> => {
      const id = cmdId ?? newId()
      const t = await agentPost({ action, params: params ?? {}, ...(bind !== undefined && { bind }), cmdId: id, agentCmd: { cmdId: id, via: agentVia } }, header)
      try { const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : t } catch { return t }
    },
  }
}

export function registerWebMcp(opts: { header?: string; agent?: string } = {}): () => void {
  const header = opts.header ?? 'x-tvine'
  const tools = pageTools('webmcp', header)

  // The pill: "Agent connected · Stop" from the first tool call; Stop ↔ Resume. Name is never verified.
  const who = opts.agent ? `${opts.agent} (unverified)` : 'Agent'
  const overlay = getOverlay()
  const connected = () => overlay.setPill({ text: `${who} connected`, button: 'Stop', onClick: () => { setStopped(true); blocked() } })
  const blocked = () => overlay.setPill({ text: `${who} stopped`, button: 'Resume', onClick: () => { setStopped(false); connected() } })
  const guard = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A): Promise<Text> => {
    if (isStopped()) { blocked(); return errOut('domain', 'the human pressed Stop; agent control is blocked in this tab', { reason: 'stopped' }) }
    if (tabControl.remote) return errOut('domain', 'busy: a remote agent controls this tab', { reason: 'busy' })
    tabControl.webmcpAt = Date.now()
    connected()
    return reply(await withNav(() => fn(a ?? ({} as A))))
  }

  const off = provideTools([
    {
      name: 'read_page', description: DESCRIPTIONS.read_page,
      inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['auto', 'L0', 'L1', 'full'] } } },
      execute: guard(tools.read_page),
    },
    {
      name: 'expand', description: DESCRIPTIONS.expand,
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['id'] },
      execute: guard(tools.expand),
    },
    {
      name: 'ui', description: DESCRIPTIONS.ui,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' }, control: { type: 'string' }, args: { type: 'object' },
          steps: { type: 'array', items: { type: 'object', properties: { target: { type: 'string' }, control: { type: 'string' }, args: { type: 'object' } }, required: ['target', 'control'] } },
          cmdId: { type: 'string', description: 'idempotency key; a retry with the same cmdId returns the same result' },
          rev: { type: 'number' },
        },
      },
      annotations: { destructiveHint: true },
      execute: guard(tools.ui),
    },
    {
      name: 'do', description: DESCRIPTIONS.do,
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' }, params: { type: 'object' }, cmdId: { type: 'string', description: 'optional idempotency key' } },
        required: ['action'],
      },
      annotations: { destructiveHint: true },
      execute: guard(({ action, params, cmdId }: { action: string; params?: object; cmdId?: string }) => tools.do({ action, params, cmdId })),
    },
  ])
  return () => { off(); overlay.setPill(null) }
}
