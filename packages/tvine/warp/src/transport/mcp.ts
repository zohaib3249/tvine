// transport/mcp — docs/design/server/transport-mcp.md + frontend/v2/core/transports.md. Generic tools
// (read_page, expand, ui, do — in that order: agents act through widget controls first) plus one typed
// tool per manifest action; every call is a thin proxy into the same dispatch pipeline.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ActionManifest } from '../core/actions.js'
import { collect, dispatch, rateLimited, renderCtx, type Log, type ServerCtx } from '../core/dispatch.js'
import { DomainError, Goto } from '../core/errors.js'
import { ev } from '../core/events.js'
import { RegistryError } from '../core/registry.js'
import { buildRequest, clientIp, type McpSource } from '../core/request.js'
import type { ActionDef, ActionId, Command, Event, Request, Session, Settings, Snapshot } from '../core/types.js'
import { hasNode, pageSnapshot, runUi, stepsOf, uiInput } from '../core/ui.js'
import { render, type Ctx, type ExpandOpt, type ViewOpt } from '../serialize/envelope.js'
import { FORBIDDEN_ROUTE, guardCheck } from './guards.js'
import { UNTRUSTED_TOOL } from '../shape/notation.js'
import { hiddenFromAnon } from '../security/permissions.js'
import { CONTROL_HINT, originOf, type TabHub, type TabOp } from './tab.js'

export interface McpOptions {
  // Next route pattern for a site path ('/product/42' → '/product/[id]'); undefined = not a page.
  // The composition root passes the same route-table matcher the HTTP transport uses.
  route: (path: string) => string | undefined
  tabs?: TabHub   // transport/tab: request_control/release, and calls of a sid that controls a tab go to that tab
}
// base: the site's public origin as the MCP request reached it (approveUrl); mcpHandler derives it from its own request
export type McpCaller = Pick<McpSource, 'ip'> & Partial<Pick<McpSource, 'headers' | 'verified'>> & { base?: string }
export type McpTool = Tool & { action?: ActionId }

// Load-bearing: the only schema a generic client's model sees. Budget ≤ 150 tokens each (tested).
export const GENERIC = {
  read_page: 'Open a page of this site. Use view=md first: the page as compact Markdown with control ids inline ({id controls}), then ui to act. Other views give JSON widgets/actions. Returns a sid — include it in every later call. Re-read after stale/expired errors.' + UNTRUSTED_TOOL,
  expand: 'Show one node of the page in full (all fields, children, controls). Use the id from read_page. Lists page with offset/limit.' + UNTRUSTED_TOOL,
  ui: 'Operate a widget on the page the way a person would: target = widget id from read_page, control = one of its listed controls (e.g. select, input, open, submit), args as listed. Several steps run in order and stop at the first error. Send a new cmdId per change.',
  do: 'Advanced: prefer ui on the page\'s widgets. Run a backend action listed on a page from read_page. Pass url (that page), action (its id), params, and the sid read_page returned. Copy bind from the action ref when it has one. Send a new cmdId with every change so a retry never runs it twice.',
  request_control: 'Ask to operate the user\'s open browser tab. Give the user the approveUrl to open (or the code to type in the site\'s Connect box); they click Allow. Then read_page/ui act in their tab as them, and they see what you do. Your name is shown to them as unverified.',
  release: 'Give the user\'s browser tab back (ends request_control). Pass your sid.',
} as const

// fresh instances: a reused zod instance becomes a $ref in the JSON Schema
const opt = () => z.string().optional()
const envelope = z.object({ url: z.string().default('/'), sid: opt(), cmdId: opt(), bind: opt() })
const readPage = z.object({ url: z.string(), sid: opt(), view: z.enum(['md', 'auto', 'full', 'L1', 'L0']).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(100).max(100_000).optional() })
const expandIn = z.object({ url: z.string(), id: z.string(), sid: opt(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() })
const doInput = envelope.extend({ url: z.string(), action: z.string(), params: z.record(z.unknown()).default({}) })
const controlIn = z.object({ name: z.string().max(200).optional(), reason: z.string().max(500).optional(), sid: opt() })
const releaseIn = z.object({ sid: z.string() })
const IMPLICIT = Object.keys(envelope.shape)

export const toolName = (id: ActionId) => id.replaceAll('.', '_')

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _, ...js } = toJsonSchemaCompat(schema as never) as Record<string, unknown>
  return js
}

// Disable levels, first match wins: action rules.mcp > app rules.ts mcp (both already merged into
// def.rules by ActionManifest.register) > settings.mcp.exclude. A disabled action is not callable over
// MCP at all (no typed tool, refused by `do`, hidden from snapshots). Global = settings.mcp.tools.
export function mcpEnabled(def: ActionDef, settings: Settings): boolean {
  const own = def.rules?.mcp
  return own !== undefined ? own : !settings.mcp.exclude.some((p) => glob(p).test(def.id))
}

// Boot-time tool list. maxTools only HIDES typed tools (still callable via `do`).
export function mcpTools(actions: ActionManifest, settings: Settings, log: Log): McpTool[] {
  const { tools: mode, exclude, maxTools } = settings.mcp
  for (const p of exclude) {
    if (!actions.all().some((d) => glob(p).test(d.id))) log('warn', `mcp: settings.mcp.exclude pattern ${p} matches no action`, { pattern: p })
  }
  const generic: McpTool[] = mode === 'typed' ? [] : [
    { name: 'read_page', description: GENERIC.read_page, inputSchema: jsonSchema(readPage) as Tool['inputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'expand', description: GENERIC.expand, inputSchema: jsonSchema(expandIn) as Tool['inputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'ui', description: GENERIC.ui, inputSchema: jsonSchema(uiInput) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
    { name: 'do', description: GENERIC.do, inputSchema: jsonSchema(doInput) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
    { name: 'request_control', description: GENERIC.request_control, inputSchema: jsonSchema(controlIn) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: 'release', description: GENERIC.release, inputSchema: jsonSchema(releaseIn) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ]
  if (mode === 'generic') return generic
  const taken = new Set(['read_page', 'expand', 'ui', 'do', 'request_control', 'release'])
  let typed: (McpTool & { def: ActionDef })[] = []
  for (const def of actions.all()) {
    if (!mcpEnabled(def, settings) || hiddenFromAnon(def)) continue   // humanOnly / staff / denyAgents: no typed tool (calls are checked anyway)
    const name = toolName(def.id)
    const props = jsonSchema(def.schema)
    const own = (props.properties ?? {}) as Record<string, unknown>
    const skip = taken.has(name) ? `tool name ${name} already taken`
      : props.type !== 'object' ? 'params schema is not an object'
      : IMPLICIT.some((k) => k in own) ? `a param is named one of ${IMPLICIT.join('/')}` : undefined
    if (skip) { log('warn', `mcp: no typed tool for ${def.id} (${skip}); reachable via do`, { action: def.id }); continue }
    taken.add(name)
    const ro = def.rules?.readOnly === true, destructive = !ro && def.rules?.destructive === true
    // rules.bind keys come ONLY from the signed bind (dispatch refuses them in params): not inputs here
    const bound = def.rules?.bind ?? []
    const { required: _r, ...propsNoReq } = props
    const required = [...((props.required ?? []) as string[]).filter((k) => !bound.includes(k)), ...(bound.length ? ['bind'] : [])]
    typed.push({
      def, action: def.id, name,
      description: `Advanced: prefer ui. ${def.id}${ro ? ' (read-only)' : destructive ? ' (destructive)' : ''}. Same as do with action "${def.id}". Pass the sid from read_page and url = the page it acts on; send a new cmdId on changes; ${bound.length ? 'requires the signed bind from read_page (its action ref)' : "copy bind from the page's action ref"}.`,
      inputSchema: {
        ...propsNoReq, properties: { ...Object.fromEntries(Object.entries(own).filter(([k]) => !bound.includes(k))), ...jsonSchema(envelope).properties as object },
        ...(required.length && { required }),
      } as Tool['inputSchema'],
      annotations: { readOnlyHint: ro, destructiveHint: destructive, openWorldHint: false },
    })
  }
  // typed-only mode has no `do` to reach trimmed actions, so it never trims
  if (mode === 'typed' && typed.length > maxTools) {
    log('warn', `mcp: ${typed.length} typed tools exceed settings.mcp.maxTools (${maxTools}); not trimmed because tools='typed' has no do`, { maxTools })
  } else if (generic.length + typed.length > maxTools) {
    const kept = typed.filter((t) => t.def.rules?.priority).slice(0, Math.max(0, maxTools - generic.length))
    log('warn', 'mcp: tool list over settings.mcp.maxTools; typed tools trimmed to priority actions (rest reachable via do)', {
      maxTools, trimmed: typed.filter((t) => !kept.includes(t)).map((t) => t.def.id),
    })
    typed = kept
  }
  return [...generic, ...typed.map(({ def: _, ...t }) => t)]
}

// settings.mcp.exclude globs on action ids: `*` = one dotted segment, `**` = any depth.
const globs = new Map<string, RegExp>()   // ponytail: keyed by pattern text; patterns come from settings, so bounded
function glob(p: string): RegExp {
  let re = globs.get(p)
  if (!re) globs.set(p, (re = toRegExp(p)))
  return re
}
function toRegExp(p: string): RegExp {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${p.split('**').map((s) => s.split('*').map(esc).join('[^.]*')).join('.*')}$`)
}

// One MCP server per connection (or per stateless HTTP request); `caller` is where the calls come from.
export function mcpServer(server: ServerCtx, opts: McpOptions, caller: McpCaller, tools = mcpTools(server.actions, server.settings, server.log)): Server {
  const srv = new Server({ name: server.settings.site.name, version: '1' }, { capabilities: { tools: {} } })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const list = tools.map(({ action: _, ...t }) => t)
  srv.setRequestHandler(ListToolsRequestSchema, () => ({ tools: list }))
  srv.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }): Promise<CallToolResult> => {
    try { return await call(name, args) } catch (e) {
      // never let a throw become an SDK JSON-RPC error carrying its message to the client
      server.log('error', 'mcp tool call failed', { tool: name.slice(0, 100), error: e instanceof Error ? e.stack ?? e.message : String(e) })
      return reply(server, [ev.err('internal', 'internal error')], blank('/'))
    }
  })
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = byName.get(name)
    if (!tool) return reply(server, [ev.err('unknown_action', `unknown tool ${name.slice(0, 100)}`)], blank('/'))
    // no cookie: MCP is sid-only, a browser cookie must never pick the session
    const headers = Object.fromEntries(Object.entries(caller.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'cookie'))
    const src = { ...caller, headers, clientInfo: srv.getClientVersion() }
    const tabs = opts.tabs
    if (name === 'request_control' || name === 'release') {
      if (!tabs) return reply(server, [ev.err('unknown_action', `unknown tool ${name}`)], blank('/'))
      if (name === 'release') {
        const p = releaseIn.safeParse(args)
        if (!p.success) return bad(server, p.error)
        if (await server.sessions.peek({ sid: p.data.sid })) await tabs.releaseAgent(p.data.sid)
        return json({ kind: 'ok', action: 'release', sid: p.data.sid })
      }
      const p = controlIn.safeParse(args)
      if (!p.success) return bad(server, p.error)
      // the session is created only after the ip rate check (a refused request creates none)
      const sid = async () => ((p.data.sid ? await server.sessions.resolve({ sid: p.data.sid }) : undefined) ?? await server.sessions.create()).sid
      const r = await tabs.request(sid, { name: p.data.name ?? src.clientInfo?.name, ip: caller.ip, base: caller.base ?? '' })
      if (!r.ok) return json({ kind: 'err', ...r, ok: undefined })
      return json({ kind: 'ok', action: 'request_control', sid: r.sid, ...(r.data as object), message: CONTROL_HINT })
    }
    // a sid that controls a tab (or waits for one) is answered by that tab, never headless
    const st = await tabs?.state(typeof args.sid === 'string' ? args.sid : undefined)
    if (st && st.kind !== 'control') {
      // tab errors are JSON with a machine-readable reason (control-protocol.md §Errors), like forwarded results
      return json(st.kind === 'awaiting'
        ? { kind: 'err', code: 'domain', reason: 'awaiting_approval', message: `waiting for the human to click Allow: ask them to open ${st.approveUrl} (or type code ${st.code} in the site's Connect box)`, approveUrl: st.approveUrl }
        : { kind: 'err', code: st.reason === 'tab_closed' ? 'expired_sid' : 'domain', reason: st.reason, message: NOTE[st.reason] ?? 'no tab under your control' })
    }
    if (st && (name === 'read_page' || name === 'expand' || name === 'ui')) {
      const op: TabOp = name === 'read_page' ? 'read' : name
      const p = (name === 'read_page' ? readPage : name === 'expand' ? expandIn : uiInput).safeParse(args)
      if (!p.success) return bad(server, p.error)
      const { url: _u, sid, ...payload } = p.data as { url: string; sid: string }
      const a = await tabs!.forward(sid, op, payload)
      return json(a.ok ? { ...(a.data as object), sid, via: 'tab' } : { kind: 'err', code: a.code, reason: a.reason, message: a.message })
    }
    if (name === 'read_page') {
      const p = readPage.safeParse(args)
      if (!p.success) return bad(server, p.error)
      const { view, offset, limit } = p.data
      return page(server, opts, src, p.data, view === 'md' ? { md: { offset, limit } } : { view })
    }
    if (name === 'expand') {
      const p = expandIn.safeParse(args)
      return p.success ? page(server, opts, src, p.data, { expand: { id: p.data.id, offset: p.data.offset, limit: p.data.limit } }) : bad(server, p.error)
    }
    if (name === 'ui') {
      const p = uiInput.safeParse(args)
      if (!p.success) return bad(server, p.error)
      return ui(server, opts, src, p.data)
    }
    const p = (tool.action ? envelope.passthrough() : doInput).safeParse(args)
    if (!p.success) return bad(server, p.error)
    const { url, sid, cmdId, bind, ...rest } = p.data as z.infer<typeof doInput>
    const cmd: Command = tool.action
      ? { action: tool.action, params: rest, sid, cmdId, bind }
      : { action: p.data.action as string, params: p.data.params as Record<string, unknown>, sid, cmdId, bind }
    const def = server.actions.get(cmd.action)
    if (st) {
      // A remote controller's `do` runs IN the tab, like ui: the tab POSTs it with its own cookie (its user, its
      // auth) + agentCmd{via:'channel'}; the agent's own identity (headers, clientInfo) is never used for it.
      // Presence, Stop and idle tracking apply. MCP-disabled actions stay uncallable over MCP.
      if (!def || !mcpEnabled(def, server.settings)) return json({ kind: 'err', code: 'unknown_action', message: `unknown action ${String(cmd.action).slice(0, 100)}` })
      const a = await tabs!.forward(sid!, 'do', { action: cmd.action, params: cmd.params, ...(bind !== undefined && { bind }), ...(cmdId !== undefined && { cmdId }) })
      return json(a.ok ? { ...(a.data as object), sid, via: 'tab' } : { kind: 'err', code: a.code, reason: a.reason, message: a.message })
    }
    const request = await requestFor(server, opts, src, url, sid)
    if (!request) return notPage(server, url)
    if (request === FORBIDDEN) return forbidden(server)
    if (!def || !mcpEnabled(def, server.settings)) return reply(server, [await unknownAction(server, cmd, request)], await renderCtx(server, cmd, request))
    const known = resolved.get(request)
    return reply(server, await collect(dispatch(cmd, server, request, known ? { session: known } : {})), await renderCtx(server, cmd, request))
  }
  return srv
}

// ---- helpers -------------------------------------------------------------------------------
const json = (v: object): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }], ...((v as { kind?: unknown }).kind === 'err' && { isError: true }) })
const NOTE: Record<string, string> = {
  not_connected: 'not connected to a tab: the human pressed Stop, or control ended. Call request_control to ask again, or release to work headless',
  human_denied: 'the human denied control of their tab',
  busy: 'busy: another agent controls that tab',
  timeout: 'the control request expired before the human allowed it; call request_control again',
  tab_closed: 'the tab was closed; call request_control again',
}
type Src = Omit<McpSource, 'url' | 'route'>
const blank = (page: string): Ctx => ({ sid: '', rev: 0, page })
const pagePath = (r: Request) => r.path + (r.query.size ? `?${r.query}` : '')

// Every snapshot an MCP client sees drops actions disabled for MCP.
function filterSnapshot(server: ServerCtx, s: Snapshot): Snapshot {
  const off = (id: ActionId) => { const d = server.actions.get(id); return !!d && !mcpEnabled(d, server.settings) }
  const out = { ...s, nodes: s.nodes.map((n) => ({ ...n, actions: n.actions.filter((a) => !off(a.id)) })) }
  // widgets: their actions, and controls whose headless map submits a disabled action (h.params.id)
  const offCtl = (h: unknown) => { const x = h as { params?: { id?: unknown }; call?: unknown } | undefined; const id = x?.params?.id ?? x?.call; return typeof id === 'string' && off(id) }
  if (s.widgets) out.widgets = s.widgets.map((w) => ({
    ...w,
    ...(w.actions && { actions: w.actions.filter((a) => !off(a.id)) }),
    ...(w.ctl && { ctl: Object.fromEntries(Object.entries(w.ctl).filter(([, c]) => !offCtl(c.h))) }),
  }))
  return out
}

// Every snapshot an MCP client sees is remembered for its session (expand serves L2 from it), then filtered.
function reply(server: ServerCtx, events: Event[], ctx: Ctx, shape: Shape = {}): CallToolResult {
  for (const e of events) if (e.kind === 'snapshot') server.sessions.remember(e.snapshot)
  events = events.map((e) => e.kind === 'snapshot' ? ev.snapshot(filterSnapshot(server, e.snapshot))
    : e.kind === 'err' && e.snapshot ? { ...e, snapshot: filterSnapshot(server, e.snapshot) } : e)
  const { md, ...rest } = shape
  const text = render(events, md ? 'md' : server.settings.formats.default, server.settings,
    { ctx, ...rest, ...(md && { md: { ...md, more: (n: number) => `call read_page again with view "md", offset ${n}` } }) })
  return { content: [{ type: 'text', text }], ...(events.some((e) => e.kind === 'err') && { isError: true }) }
}
const bad = (server: ServerCtx, e: z.ZodError) => {
  const i = e.issues[0]!
  return reply(server, [ev.err('invalid_param', `${i.path.join('.')}: ${i.message}`, { field: String(i.path[0] ?? '') })], blank('/'))
}
const forbidden = (server: ServerCtx) =>
  reply(server, [ev.err('domain', FORBIDDEN_ROUTE, { reason: 'forbidden' })], blank('/'))
const notPage = (server: ServerCtx, url: string) =>
  reply(server, [ev.err('invalid_param', 'url is not a page of this site', { field: 'url' })], blank('/'))

// Missing and disabled ids answer alike (dispatch's wording + a snapshot to recover from, filtered in
// reply()), so disabled ids can't be probed. No live session → no snapshot (never creates one).
async function unknownAction(server: ServerCtx, cmd: Command, request: Request): Promise<Event> {
  const msg = `unknown action ${String(cmd.action).slice(0, 100)}`
  const session = await server.sessions.peek({ sid: cmd.sid })
  if (!session) return ev.err('unknown_action', msg)
  const page = pagePath(request)
  try { return ev.err('unknown_action', msg, { snapshot: await server.snapshot(page, session.sid) }) }
  catch (e) {
    server.log('error', 'snapshot render failed', { page, error: e instanceof Error ? e.message : String(e) })
    return ev.err('unknown_action', msg)
  }
}

// Only route-table paths of this site ever reach snapshot(): absolute URLs to other origins are refused,
// and settings.guards run here, before any snapshot or dispatch (same rules as HTTP).
const FORBIDDEN = Symbol('forbidden')
async function requestFor(server: ServerCtx, opts: McpOptions, src: Src, url: string, sid: string | undefined): Promise<Request | undefined | typeof FORBIDDEN> {
  let u: URL
  try { u = new URL(url, 'http://tvine.local') } catch { return undefined }
  if (u.origin !== 'http://tvine.local') return undefined
  const route = opts.route(u.pathname)
  if (route === undefined) return undefined
  let path: string
  try { path = decodeURIComponent(u.pathname) } catch { return undefined }
  const request = await buildRequest({ ...src, url: u.pathname + u.search, route }, server.settings)
  // resolved once: the command / page that follows reuses it (resolvedFor)
  const session = await server.sessions.resolve({ sid })
  resolved.set(request, session)
  return (await guardCheck(server.settings)(path, request, session)) ? request : FORBIDDEN
}
const resolved = new WeakMap<Request, Session | undefined>()

// read_page (view) and expand (L2 of one node from the session's cached snapshot; unknown id → L0 map).
type Shape = { view?: ViewOpt; expand?: ExpandOpt; md?: { offset?: number; limit?: number } }
async function page(server: ServerCtx, opts: McpOptions, src: Src, a: { url: string; sid?: string }, shape: Shape): Promise<CallToolResult> {
  const request = await requestFor(server, opts, src, a.url, a.sid)
  if (!request) return notPage(server, a.url)
  if (request === FORBIDDEN) return forbidden(server)
  const session = resolved.get(request) ?? await server.sessions.create()
  const ctx: Ctx = { sid: session.sid, rev: session.rev, page: pagePath(request) }
  return rendering(server, ctx, async () => {
    const t0 = performance.now()
    const snap = shape.expand ? await pageSnapshot(server, session.sid, ctx.page) : await server.snapshot(ctx.page, session.sid)
    const ms = Math.round(performance.now() - t0)
    if (server.hooks.has('read')) setImmediate(() => server.hooks.emit('read', { page: ctx.page, via: 'mcp', sid: session.sid, rev: session.rev, ms }))
    if (shape.expand && !hasNode(filterSnapshot(server, snap), shape.expand.id)) {
      return reply(server, [ev.err('unknown_action', `unknown node ${shape.expand.id.slice(0, 100)}; ids are in the map`, { snapshot: snap })], ctx, { view: 'L0' })
    }
    return reply(server, [ev.snapshot(snap)], ctx, shape)
  })
}

// Headless ui: resolved by Warp from the page's widget fragments (core/ui.ts), on this sid's session.
async function ui(server: ServerCtx, opts: McpOptions, src: Src, a: z.infer<typeof uiInput>): Promise<CallToolResult> {
  const steps = stepsOf(a)
  if (!steps) return reply(server, [ev.err('invalid_param', 'give target + control, or steps', { field: 'target' })], blank('/'))
  const request = await requestFor(server, opts, src, a.url, a.sid)
  if (!request) return notPage(server, a.url)
  if (request === FORBIDDEN) return forbidden(server)
  const known = a.sid === undefined ? undefined : resolved.get(request)
  const session = known ?? await server.sessions.create()
  const ctx: Ctx = { sid: session.sid, rev: session.rev, page: pagePath(request) }
  if (a.sid !== undefined && !known) {   // like dispatch: a dead sid never runs steps; a fresh sid + snapshot to restart
    return rendering(server, ctx, async () => reply(server, [ev.err('expired_sid', 'session expired or missing; a new sid is attached', { snapshot: await server.snapshot(ctx.page, session.sid) })], ctx))
  }
  const rl = await server.limiter.check({ ip: request.ip, sid: session.sid })
  if (!rl.ok) return reply(server, [rateLimited(rl.retryAfterMs)], ctx)
  return rendering(server, ctx, async () => {
    const at = async (pg: string) => { const r = await requestFor(server, opts, src, pg, session.sid); return r && r !== FORBIDDEN ? r : undefined }
    const out = await runUi(server, steps, a, { session, page: ctx.page, request: at, filter: (s) => filterSnapshot(server, s) })
    return reply(server, out.events, { ...ctx, page: out.page, rev: session.rev })
  })
}

async function rendering(server: ServerCtx, ctx: Ctx, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await fn() } catch (e) {
    if (e instanceof Goto) return reply(server, [ev.goto(e.url)], ctx)   // the page redirected
    if (e instanceof DomainError) return reply(server, [ev.err('domain', e.message, { reason: e.code })], ctx)   // e.g. not_found
    server.log('error', 'snapshot render failed', { page: ctx.page, error: e instanceof Error ? e.message : String(e) })
    return reply(server, [ev.err(e instanceof RegistryError ? e.code : 'internal', 'page could not be rendered')], ctx)
  }
}

// Streamable-HTTP endpoint for the composition root to mount at /mcp. Stateless: one MCP server per
// POST, so each call carries its own socket ip and headers. /mcp is unauthenticated in v1 (anonymous scope).
export function mcpHandler(server: ServerCtx, opts: McpOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const tools = mcpTools(server.actions, server.settings, server.log)
  const { settings } = server
  return async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
    let body: unknown
    try { body = await readJson(req, settings.limits.bodyBytes) }
    catch (e) { res.writeHead(e === TOO_BIG ? 413 : 400).end(); return }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
    const ip = clientIp(headers['x-forwarded-for'] ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
    const srv = mcpServer(server, opts, { ip, headers, base: originOf(req, settings), verified: (req as { tvine?: { verifiedAgent?: { directory: string; keyid: string } } }).tvine?.verifiedAgent }, tools)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void srv.close() })
    await srv.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

const TOO_BIG = new Error('body too large')
async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((n += c.length) > max) throw TOO_BIG
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
