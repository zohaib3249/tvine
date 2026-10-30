// transport/mcp — docs/design/server/transport-mcp.md. Two generic tools (read_page, do) plus one typed
// tool per manifest action; every call is a thin proxy into the same dispatch pipeline.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ActionManifest } from '../core/actions.js'
import { collect, dispatch, renderCtx, type Log, type ServerCtx } from '../core/dispatch.js'
import { ev } from '../core/events.js'
import { RegistryError } from '../core/registry.js'
import { buildRequest, clientIp, type McpSource } from '../core/request.js'
import type { ActionDef, ActionId, Command, Event, Request, Settings, Snapshot } from '../core/types.js'
import { render, type Ctx } from '../serialize/envelope.js'
import { FORBIDDEN_ROUTE, guardCheck } from './guards.js'

export interface McpOptions {
  // Next route pattern for a site path ('/product/42' → '/product/[id]'); undefined = not a page.
  // The composition root passes the same route-table matcher the HTTP transport uses.
  route: (path: string) => string | undefined
}
export type McpCaller = Pick<McpSource, 'ip'> & Partial<Pick<McpSource, 'headers'>>
export type McpTool = Tool & { action?: ActionId }

// Load-bearing: the only schema a generic client's model sees. Budget ≤ 150 tokens each (tested).
export const GENERIC = {
  read_page: 'Open a page of this site and get its data + callable actions. Returns a sid — include it in every later call. Re-call this whenever an action returns a stale/expired error.',
  do: 'Run an action listed on a page from read_page. Pass url (that page), action (its id), params, and the sid read_page returned. Copy bind from the action ref when it has one. Send a new cmdId with every change so a retry never runs it twice.',
} as const

// fresh instances: a reused zod instance becomes a $ref in the JSON Schema
const opt = () => z.string().optional()
const envelope = z.object({ url: z.string().default('/'), sid: opt(), cmdId: opt(), bind: opt() })
const readPage = z.object({ url: z.string(), sid: opt() })
const doInput = envelope.extend({ url: z.string(), action: z.string(), params: z.record(z.unknown()).default({}) })
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
    { name: 'do', description: GENERIC.do, inputSchema: jsonSchema(doInput) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  ]
  if (mode === 'generic') return generic
  const taken = new Set(['read_page', 'do'])
  let typed: (McpTool & { def: ActionDef })[] = []
  for (const def of actions.all()) {
    if (!mcpEnabled(def, settings)) continue
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
      description: `${def.id}${ro ? ' (read-only)' : destructive ? ' (destructive)' : ''}. Same as do with action "${def.id}". Pass the sid from read_page and url = the page it acts on; send a new cmdId on changes; ${bound.length ? 'requires the signed bind from read_page (its action ref)' : "copy bind from the page's action ref"}.`,
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
    if (name === 'read_page') {
      const p = readPage.safeParse(args)
      return p.success ? page(server, opts, src, p.data) : bad(server, p.error)
    }
    const p = (tool.action ? envelope.passthrough() : doInput).safeParse(args)
    if (!p.success) return bad(server, p.error)
    const { url, sid, cmdId, bind, ...rest } = p.data as z.infer<typeof doInput>
    const cmd: Command = tool.action
      ? { action: tool.action, params: rest, sid, cmdId, bind }
      : { action: p.data.action as string, params: p.data.params as Record<string, unknown>, sid, cmdId, bind }
    const request = await requestFor(server, opts, src, url, sid)
    if (!request) return notPage(server, url)
    if (request === FORBIDDEN) return forbidden(server)
    const def = server.actions.get(cmd.action)
    if (!def || !mcpEnabled(def, server.settings)) return reply(server, [await unknownAction(server, cmd, request)], renderCtx(server, cmd, request))
    return reply(server, await collect(dispatch(cmd, server, request)), renderCtx(server, cmd, request))
  }
  return srv
}

// ---- helpers -------------------------------------------------------------------------------
type Src = Omit<McpSource, 'url' | 'route'>
const blank = (page: string): Ctx => ({ sid: '', rev: 0, page })
const pagePath = (r: Request) => r.path + (r.query.size ? `?${r.query}` : '')

// Every snapshot an MCP client sees drops actions disabled for MCP.
function filterSnapshot(server: ServerCtx, s: Snapshot): Snapshot {
  const off = (id: ActionId) => { const d = server.actions.get(id); return !!d && !mcpEnabled(d, server.settings) }
  return { ...s, nodes: s.nodes.map((n) => ({ ...n, actions: n.actions.filter((a) => !off(a.id)) })) }
}

function reply(server: ServerCtx, events: Event[], ctx: Ctx): CallToolResult {
  events = events.map((e) => e.kind === 'snapshot' ? ev.snapshot(filterSnapshot(server, e.snapshot))
    : e.kind === 'err' && e.snapshot ? { ...e, snapshot: filterSnapshot(server, e.snapshot) } : e)
  const text = render(events, server.settings.formats.default, server.settings, { ctx })
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
  const session = server.sessions.peek({ sid: cmd.sid })
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
  return (await guardCheck(server.settings)(path, request, server.sessions.peek({ sid }))) ? request : FORBIDDEN
}

async function page(server: ServerCtx, opts: McpOptions, src: Src, a: z.infer<typeof readPage>): Promise<CallToolResult> {
  const request = await requestFor(server, opts, src, a.url, a.sid)
  if (!request) return notPage(server, a.url)
  if (request === FORBIDDEN) return forbidden(server)
  const session = server.sessions.resolve({ sid: a.sid }) ?? server.sessions.create()
  const ctx: Ctx = { sid: session.sid, rev: session.rev, page: pagePath(request) }
  try {
    const t0 = performance.now()
    const snap = await server.snapshot(ctx.page, session.sid)
    server.hooks.emit('read', { page: ctx.page, via: 'mcp', sid: session.sid, rev: session.rev, ms: Math.round(performance.now() - t0) })
    return reply(server, [ev.snapshot(snap)], ctx)
  } catch (e) {
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
    const srv = mcpServer(server, opts, { ip, headers }, tools)
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
