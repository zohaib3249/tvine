// core/dispatch — the single mutation path (docs/design/server/core-dispatch.md). Every command
// (HTTP, MCP, channel, WebMCP, human <Form>) runs this pipeline; first failure → one `err` event.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ActionManifest } from './actions.js'
import { redactSecrets } from './redact.js'
import { audited, auditRow, securityEvent, writeAudit } from './audit.js'
import { confirmGate } from './confirm.js'
import { forwardedHost } from './request.js'
import { aliasRequest, authenticate, markRotated, rotatedSession, wantsCycle } from './auth.js'
import { corsAllows } from './cors-match.js'
import { DomainError } from './errors.js'
import { siteRedirect } from './redirect.js'
import { ev, isTerminal } from './events.js'
import { compose, deepFreeze, Hooks } from './middleware.js'
import { SessionBusy, SessionStore } from './session.js'
import { channelsFor, idempotencyFor, limiterFor, marksFor, sessionsFor } from '../backends/index.js'
import type { ActionCtx, ActionDef, ChannelLayer, Command, ConfirmAsk, Event, Middleware, Request, Session, Settings, Sid, Snapshot } from './types.js'
import { atomic, setOnCommitErrorHandler } from '../data/engine.js'
import { withPending } from '../data/pending.js'
import { hashParams, type Idempotency } from '../security/idempotency.js'
import { permissionCtx, runPermissions } from '../security/permissions.js'
import { ipKey, type Limiter } from '../security/ratelimit.js'
import { AGENTS_DENIED } from '../security/permissions.js'
import { verifyBind } from '../security/sign.js'
import { metrics } from './metrics.js'
import type { Ctx } from '../serialize/envelope.js'
import { validate } from '../views/generic.js'
import { cachedRun } from '../cache/index.js'
import { getLogger } from '../log.js'
const tvineLog = getLogger('tvine')

export type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

export interface ServerCtx {
  actions: ActionManifest
  middleware?: { name: string }[]  // the active HTTP middleware, outermost first (server.ts; tvine check prints it)
  sessions: SessionStore
  snapshot: (route: string, sid: Sid) => Promise<Snapshot>
  settings: Settings
  channels: ChannelLayer           // the same layer the SessionStore was built on
  limiter: Limiter                 // settings.limits.backend (backends/index.ts)
  idempotency: Idempotency
  log: Log
  hooks: Hooks                     // server.ctx.hooks.on('command' | 'error' | 'session' | 'read', fn)
  appMiddleware: Map<string, Middleware[]>   // apps/<app>/middleware.ts (discoverMiddleware)
  route?: (path: string) => string | undefined   // the site's route matcher (createAgentServer): redirect targets must match
  // transport/tab: true while a remote agent's forwarded command is running in a tab of this session
  tabs?: { forcedAgent(sid: Sid): boolean | Promise<boolean> }
  // a shared snapshot cache (snapshotCache.backend 'redis'): resolves once this process's committed writes are
  // visible to every server's cache. Awaited after a commit, before the reply.
  settle?: () => Promise<void>
  // tab agent marking shared across servers (limits.backend 'redis'): set(sid, ms) marks the session agent for ms
  // (0 clears), has(sid) reads it. Absent = in-process only (transport/tab.ts keeps its own maps).
  marks?: { set(sid: Sid, ms: number): Promise<void>; has(sid: Sid): Promise<boolean> }
  appsDir?: string                 // the project's apps/ (createAgentServer): contrib apps' ready() discover more modules from it
  health: Map<string, () => unknown>   // extra /tvine/health sections (sync, cheap: e.g. tvine.tasks' cached queue stats)
  onClose(fn: () => unknown): void // run fn on close() (an app's ready() timers, relays)
  close(): void                    // stops this ctx's session watcher, then runs the onClose fns
}

// The action running right now (its ActionCtx), for code deep in a handler's call tree that needs the caller's
// session / user without threading ctx through (tvine.tasks stamps the enqueuer on a job). On globalThis:
// one store however many copies of warp a process loads.
const SCOPE = Symbol.for('tvine.actionScope')
const scope: AsyncLocalStorage<ActionCtx> = ((globalThis as { [SCOPE]?: AsyncLocalStorage<ActionCtx> })[SCOPE] ??= new AsyncLocalStorage())
export const currentAction = (): ActionCtx | undefined => scope.getStore()

const errStr = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e))

const watching = new WeakMap<SessionStore, WeakSet<Hooks>>()   // one session watcher per (store, hooks)

// Fills the defaults (validating settings.limits.rate) and routes onCommit hook errors to the logger.
// ponytail: setOnCommitErrorHandler is process-global, so the last ServerCtx built owns it (single-process v1).
export function serverCtx(o: Pick<ServerCtx, 'actions' | 'settings' | 'snapshot'> & Partial<ServerCtx>): ServerCtx {
  const { settings } = o
  const log: Log = o.log ?? ((level, msg, data) => tvineLog[level](msg, data))
  // backends from settings (backends/index.ts): memory by default, 'redis' shares them across servers
  const channels = o.channels ?? channelsFor(settings, log)
  const closers: (() => unknown)[] = []
  if (!o.channels && 'close' in channels) closers.push(() => (channels as { close(): unknown }).close())
  const ctx: ServerCtx = {
    ...o, snapshot: async (page, sid) => markCalls(await o.snapshot(page, sid), o.actions), channels, log, close: () => {}, health: o.health ?? new Map(), onClose: (fn) => { closers.push(fn) },
    hooks: o.hooks ?? new Hooks((hook, e) => log('error', 'hook failed', { hook, error: errStr(e) })),
    appMiddleware: o.appMiddleware ?? new Map(),
    sessions: o.sessions ?? sessionsFor(settings, { channels }, log),
    limiter: o.limiter ?? limiterFor(settings),
    idempotency: o.idempotency ?? idempotencyFor(settings),
    marks: o.marks ?? marksFor(settings),
  }
  const w = watching.get(ctx.sessions) ?? new WeakSet<Hooks>()
  watching.set(ctx.sessions, w)
  let unwatch = () => {}
  if (!w.has(ctx.hooks)) { w.add(ctx.hooks); unwatch = ctx.sessions.watch((sid, kind) => ctx.hooks.emit('session', { sid, kind })) }
  ctx.close = () => {
    unwatch(); unwatch = () => {}; w.delete(ctx.hooks)
    for (const fn of closers.splice(0)) { try { void Promise.resolve(fn()).catch((e) => log('error', 'onClose failed', { error: errStr(e) })) } catch (e) { log('error', 'onClose failed', { error: errStr(e) }) } }
  }
  setOnCommitErrorHandler((e) => log('error', 'onCommit hook failed', { error: errStr(e) }))
  return ctx
}

// Plain-call controls (headless {call}) whose action refuses agents (denyAgents, mcp:false, humanOnly) get
// h.agent=false: not listed headless and refused by `ui`, like a signed handle's agent:false (dispatch still enforces).
function markCalls(s: Snapshot, actions: ServerCtx['actions']): Snapshot {
  for (const w of s.widgets ?? []) for (const c of Object.values(w.ctl ?? {})) {
    const h = c.h as { call?: unknown; agent?: boolean } | undefined
    const def = typeof h?.call === 'string' ? actions.get(h.call) : undefined
    const r = def?.rules
    if (r && (r.mcp === false || r.humanOnly || r.permissions?.some((p) => !!(p as { [AGENTS_DENIED]?: true })[AGENTS_DENIED]))) h!.agent = false
  }
  return s
}

// Requests whose caller discards snapshots (the human <Form>: formResult only reads ok/err/goto).
const quiet = new WeakSet<Request>()
const renderRead = new WeakSet<Request>()

// render: a page render's read (api.* inside a server component) — it spends no rate bucket (W11-FIX #6: a
// rate-limited render is a 500 page with no Tvine root, which kills tab control). Read-only actions only.
export async function* dispatch(cmd: Command, server: ServerCtx, request: Request, opts: { snapshot?: boolean; render?: boolean } = {}): AsyncIterable<Event> {
  if (opts.snapshot === false) quiet.add(request)
  if (opts.render && server.actions.get(cmd.action)?.rules?.readOnly) renderRead.add(request)
  const t0 = performance.now()
  const hold: Hold = { req: request }
  const { sid, events } = await run(cmd, server, request, hold)
  await auditFailure(server, cmd, sid, events, hold, performance.now() - t0)
  securityOutcome(server, cmd, sid, events, hold.req!)
  emitHooks(server, cmd, sid, events, Math.round(performance.now() - t0))
  if (metrics.enabled) {
    const outcome = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')?.code ?? 'ok'
    // only registered ids label a series (an unknown id is caller-chosen text: cardinality)
    metrics.inc('tvine_actions_total', { action: server.actions.get(cmd.action) ? cmd.action : '_unknown', outcome, via: request.agent.is ? 'agent' : 'human' })
    if (outcome === 'rate_limited') metrics.inc('tvine_ratelimit_hits_total', { scope: 'action' })
  }
  yield* events
}

// ---- audit (BACKLOG #1, core/audit.ts) ------------------------------------------------------
// A committed command's row is written INSIDE its transaction (execute → hold.audit); a refused or failed attempt
// gets its own short write here, after the rollback. Noise (no session, rate limits, stale state) is not audited.
const AUDIT_ERRS = new Set(['domain', 'invalid_param', 'human_only', 'stale_bind', 'internal'])
async function auditFailure(server: ServerCtx, cmd: Command, sid: Sid | undefined, events: Event[], hold: Hold, ms: number): Promise<void> {
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (!err || hold.audited || !AUDIT_ERRS.has(err.code) || !audited(server.settings, server.actions.get(cmd.action))) return
  const { $confirm: _, ...params } = cmd.params ?? {}
  const code = err.reason && err.reason !== err.code ? `${err.code}:${err.reason}` : err.code
  try { await writeAudit(auditRow(server.settings, { action: cmd.action, params, request: hold.req!, sid, cmdId: cmd.cmdId, ms, code })) }
  catch (e) { server.log('error', 'audit write failed', { action: cmd.action, error: errStr(e) }) }
}

// tvine.security: every refusal a command can meet (core/audit.ts securityEvent)
function securityOutcome(server: ServerCtx, cmd: Command, sid: Sid | undefined, events: Event[], request: Request): void {
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (!err) return
  const event = err.code === 'rate_limited' ? 'rate_limited' : err.code === 'human_only' ? 'human_only' : err.code === 'confirm_required' ? 'confirm_required'
    : err.reason === 'forbidden' ? (/cross-origin/.test(err.message) ? 'origin_refused' : 'permission_denied') : undefined
  // rate limits / confirms are routine: logged, not audited (the audit trail already has the command's own row)
  if (event) securityEvent(event, { action: String(cmd.action).slice(0, 100) }, { settings: server.settings, request, sid, audit: event === 'origin_refused' })
}

// Hooks fire once run() settled (an ok is always after its commit), on a frozen copy: a hook can alter
// neither the reply nor the stored idempotency result. Deferred past the reply.
// ponytail: setImmediate only defers; a hook doing slow sync work still blocks the event loop.
function emitHooks(server: ServerCtx, cmd: Command, sid: Sid | undefined, events: Event[], ms: number): void {
  const { hooks } = server
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (!hooks.has('command') && !(err && hooks.has('error'))) return
  let copy: { cmd: Command; events: Event[] }
  // hooks never see credentials: secret-named params redacted; a secretResult action's result blanked (one-time secrets)
  const secretResult = !!server.actions.get(cmd.action)?.rules?.secretResult
  try {
    const c = structuredClone({ cmd, events })
    c.cmd.params = redactSecrets(c.cmd.params) as Command['params']
    c.events = c.events.map((e) => (e.kind === 'ok' && secretResult && e.result !== undefined ? { ...e, result: '[redacted]' } : e))
    copy = deepFreeze(c)
  }
  catch (e) { server.log('error', 'hook payload not cloneable; hooks skipped', { action: cmd.action, error: errStr(e) }); return }
  setImmediate(() => {
    hooks.emit('command', { cmd: copy.cmd, action: cmd.action, status: err?.code ?? 'ok', sid, events: copy.events, ms })
    if (err) hooks.emit('error', { cmd: copy.cmd, code: err.code, message: err.message })
  })
}

// Sync edge: stops at the first terminal event (core-events.md ordering rule).
export async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of events) {
    out.push(e)
    if (isTerminal(e)) break
  }
  return out
}

// {sid, rev, page} for serialize render(): err events without a snapshot carry none themselves.
export async function renderCtx(server: ServerCtx, cmd: Pick<Command, 'sid'>, request: Request): Promise<Ctx> {
  const s = rotatedSession(request) ?? await server.sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, server.settings) })
  return { sid: s?.sid ?? cmd.sid ?? '', rev: s?.rev ?? 0, page: pageOf(request) }
}

// The human <Form> shim's result (weft FormResult, primitive-form.md §Human validation errors).
export interface FormResult { ok: boolean; errors?: Record<string, string>; message?: string; goto?: string; confirm?: ConfirmAsk }
export function formResult(events: Event[]): FormResult {
  for (const e of events) {
    if (e.kind === 'err') {
      const errs = e.code !== 'invalid_param' ? undefined
        : e.errors && e.errors.length > 1 ? Object.fromEntries([...e.errors].reverse().map(x => [x.field, x.message]))   // first message per field wins
        : (e.field ?? e.errors?.[0]?.field) ? { [(e.field ?? e.errors![0]!.field)]: e.message } : undefined   // one field: the "field: message" text, as before errors[]
      return { ok: false, ...(errs && { errors: errs }), message: e.message, ...(e.confirm && { confirm: e.confirm }) }
    }
    if (e.kind === 'goto') return { ok: true, goto: e.url }
  }
  return { ok: true }
}

// ---- helpers -------------------------------------------------------------------------------
const pageOf = (r: Request) => { const q = r.query.toString(); return q ? `${r.path}?${q}` : r.path }

export function cookieOf(r: Request, s: Settings): string | undefined {
  for (const part of (r.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === s.session.cookieName) return part.slice(i + 1).trim()
  }
  return undefined
}

// Next's server-action check, kept for every path into dispatch: a browser Origin must match the host.
// No Origin (curl, SDKs, MCP clients) passes. A foreign Origin passes only where settings.cors opted it in
// for this endpoint + method (core/cors-match corsAllows); the human <Form> path never.
// the public host of the request (X-Forwarded-Host only through trusted proxies)
const hostOf = (r: Request, s: Settings) => forwardedHost((n) => r.headers.get(n), s.trustProxy) || undefined   // X-Forwarded-Host per trusted hops

export function crossOrigin(r: Request, s: Settings): boolean {
  const origin = r.headers.get('origin')
  if (origin === null) return false
  const host = hostOf(r, s)
  let same: boolean
  try { same = new URL(origin).host === host } catch { return true }
  return !same && !corsAllows(r, s, origin)
}

// One command at a time per sid: rev bumps and session.data writes never interleave. The queue depth
// per sid is capped, so one session cannot pile up waiters (each would otherwise age past handlerMs).
export const MAX_QUEUE = 16
const chains = new Map<Sid, Promise<unknown>>()
const depth = new Map<Sid, number>()
export const rateLimited = (ms: number) => ev.err('rate_limited', `rate limited: retry after ${ms}ms`, { retryAfterMs: ms })
function serial(sid: Sid, fn: () => Promise<Event[]>): Promise<Event[]> {
  const n = depth.get(sid) ?? 0
  if (n >= MAX_QUEUE) return Promise.resolve([rateLimited(1000)])
  depth.set(sid, n + 1)
  const next = (chains.get(sid) ?? Promise.resolve()).then(fn).finally(() => {
    const m = depth.get(sid)! - 1
    if (m) depth.set(sid, m); else depth.delete(sid)
  })
  const tail = next.catch(() => undefined)
  chains.set(sid, tail)
  void tail.then(() => { if (chains.get(sid) === tail) chains.delete(sid) })
  return next
}

// Concurrent retries of one sid:cmdId share the first run's events (never a second execution).
const inFlight = new Map<string, Promise<{ hash: string; events: Event[] }>>()
const conflict = () => ev.err('conflict', 'cmdId already used with different params')

// Handler-side channel layer: sends are held until commit (dropped on rollback).
function staging(ch: ChannelLayer, outbox: [string, Event][]): ChannelLayer {
  return {
    group: (name) => ({ ...ch.group(name), send: (e: Event) => { outbox.push([name, e]) } }),
    head: () => ch.head(),
    drop: (name) => ch.drop(name),
  }
}

class HandlerTimeout extends Error { constructor() { super('handler timeout') } }

// Next's redirect(): digest `NEXT_REDIRECT;<type>;<url>;<status>;` (url may itself contain ';').
function redirectUrl(e: unknown): string | undefined {
  const d = (e as { digest?: unknown } | null)?.digest
  return typeof d === 'string' && d.startsWith('NEXT_REDIRECT;') ? d.split(';').slice(2, -2).join(';') : undefined
}

// ---- pipeline ------------------------------------------------------------------------------
type Ran = { sid: Sid | undefined; events: Event[] }   // sid: the session the command resolved to (for hooks)

async function run(cmd: Command, server: ServerCtx, request: Request, hold: Hold): Promise<Ran> {
  const { settings, sessions } = server
  const peeked = async () => (await sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, settings) }))?.sid
  if (crossOrigin(request, settings)) return { sid: await peeked(), events: [ev.err('domain', 'forbidden: cross-origin request', { reason: 'forbidden' })] }
  // 2'. a retry of a FINISHED command replays before any rate token is spent (peek: creates nothing)
  const hash = cmd.cmdId ? hashParams({ action: cmd.action, params: cmd.params, bind: cmd.bind }) : ''
  const known = cmd.cmdId ? await sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, settings) }) : undefined
  // humanOnly actions never replay here: the agent mark (agentCmd, tab mark) is only known after the session (4.1 below)
  if (known && !server.actions.get(cmd.action)?.rules?.humanOnly) {
    const r = await server.idempotency.replay(known.sid, cmd.cmdId!, hash)
    if (r.hit === true) return { sid: known.sid, events: r.events }
  }
  // 3a. ip + default sid bucket first: abusive traffic never creates sessions or queues (3b, an action's own rate, runs later)
  const rl = renderRead.has(request) ? { ok: true as const } : await server.limiter.check({ ip: request.ip, sid: cmd.sid ?? cookieOf(request, settings) })
  if (!rl.ok) return { sid: await peeked(), events: [rateLimited(rl.retryAfterMs)] }
  // 1. session
  const session = await sessions.resolve({ sid: cmd.sid, cookie: cookieOf(request, settings) })
  if (!session) {
    const fresh = await sessions.create()
    return { sid: fresh.sid, events: [ev.err('expired_sid', 'session expired or missing; a new sid is attached', { snapshot: await snap(server, request, fresh.sid) })] }
  }
  const { sid } = session
  await authenticate(settings, request, session)   // request.user from this session (core/auth.ts; no-op without an auth app)
  const original = request
  request = await asAgent(cmd, server, request, sid)
  if (request !== original) aliasRequest(request, original)   // a rotation in the pipeline reaches the transport's request too
  hold.req = request
  // 4.1 humanOnly (widgets/human-only.md): THE security guard, before replay / in-flight dedupe, so an agent reusing a
  // human's cmdId gets human_only, never the stored result. Every agent-marked request (MCP tools, `do`, agent HTTP,
  // the tab agent mark/tail, WebMCP agentCmd) is refused; only a human's own request runs it. No rule or hook overrides it.
  const ho = server.actions.get(cmd.action)?.rules?.humanOnly
  if (ho && request.agent.is) {
    return { sid, events: [ev.err('human_only', `only a human can do this here (${typeof ho === 'string' ? ho : cmd.action}); ask the user to do it`, { reason: 'human_only' })] }
  }
  // within the process: one at a time per sid (serial); across servers: the store's per-sid lock
  const locked = (fn: () => Promise<Event[]>) => serial(sid, () => sessions.lock(sid, fn).catch((e: unknown) => {
    if (e instanceof SessionBusy) return [rateLimited(1000)]
    throw e
  }))
  if (!cmd.cmdId) return { sid, events: await locked(() => pipeline(cmd, server, request, session, '', hold)) }
  // 2a. in-flight dedupe (2b, the stored replay, runs inside the chain)
  const key = `${sid}:${cmd.cmdId}`
  const running = inFlight.get(key)
  if (running) {
    const r = await running
    return { sid, events: r.hash === hash ? r.events : [conflict()] }
  }
  const p = runOnce(server, sid, cmd.cmdId, hash, hold, () => locked(() => pipeline(cmd, server, request, session, hash, hold))).then((events) => ({ hash, events }))
  inFlight.set(key, p)
  try { return { sid, events: (await p).events } } finally {
    // held until the handler itself settles (not the timeout): a retry never runs it a second time
    void Promise.resolve(hold.settled).catch(() => undefined).then(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
  }
}

// A shared idempotency store (limits.backend 'redis'): the sid:cmdId is claimed across servers while it runs. A
// retry that reaches another server meanwhile waits for the stored result instead of running it a second time.
// The claim is released when the handler itself settles (like inFlight), or by its TTL if this process dies.
async function runOnce(server: ServerCtx, sid: Sid, cmdId: string, hash: string, hold: Hold, run: () => Promise<Event[]>): Promise<Event[]> {
  const idem = server.idempotency
  if (!idem.claim) return run()
  const ttl = 4 * server.settings.limits.handlerMs + 15_000
  const until = Date.now() + ttl
  while (!(await idem.claim(sid, cmdId, ttl))) {
    const r = await idem.replay(sid, cmdId, hash)
    if (r.hit === 'conflict') return [conflict()]
    if (r.hit) return r.events
    if (Date.now() > until) return [rateLimited(1000)]
    await new Promise((ok) => setTimeout(ok, 50))
  }
  try { return await run() } finally {
    void Promise.resolve(hold.settled).catch(() => undefined).then(() => idem.release!(sid, cmdId)).catch(() => undefined)
  }
}

// security.md invariant 3: the agent flag is downgrade-only. agentCmd (the client marks a request it sends for
// an agent) can only make a request agent; and while a remote agent's forwarded command runs in a tab of this
// session, EVERY request of the session is agent, whatever the client says (a page handler calling an api,
// a form path, a client that drops the flag). So denyAgents holds on every path through a controlled tab.
async function asAgent(cmd: Command, server: ServerCtx, request: Request, sid: Sid): Promise<Request> {
  const forced = (await server.tabs?.forcedAgent(sid)) === true
  if (!forced && cmd.agentCmd === undefined) return request
  const claim = cmd.agentCmd?.via
  // 'inspector' = the dev gallery's try-it (weft dev/Gallery.tsx); meaningless in production (no gallery there)
  const via = forced ? 'channel' : claim === 'webmcp' ? 'webmcp' : claim === 'inspector' && server.settings.debug ? 'inspector' : 'channel'
  const out: Request = { ...request, agent: { ...request.agent, is: true, via } }
  if (quiet.has(request)) quiet.add(out)
  return out
}

async function snap(server: ServerCtx, request: Request, sid: Sid): Promise<Snapshot | undefined> {
  if (quiet.has(request)) return undefined
  try { return await server.snapshot(pageOf(request), sid) }
  catch (e) {
    // a page that redirects (Next redirect()) is not a failure: the agent gets a goto to it either way
    if ((e as { name?: string })?.name === 'Goto') server.log('info', 'snapshot render redirected', { page: pageOf(request), to: (e as { url?: string }).url })
    else server.log('error', 'snapshot render failed', { page: pageOf(request), error: errStr(e) })
    return undefined
  }
}

// settled: the handler's own promise, which may outlive the timeout. req: the request as dispatched (agent-marked).
// audit: writes the audit row inside the handler's transaction; audited: it did
type Hold = { settled?: Promise<unknown>; req?: Request; audit?: () => Promise<void>; audited?: boolean }

async function pipeline(cmd: Command, server: ServerCtx, request: Request, session: Session, hash: string, hold: Hold): Promise<Event[]> {
  const { settings } = server, { sid } = session
  const t0 = performance.now()
  // C1: resolved before the queue; while it waited, a login/logout may have rotated this session away (or it
  // expired). Refuse without any sid or snapshot: the new sid belongs to whoever ran the rotating command.
  if (!(await server.sessions.isLive(session))) return [ev.err('expired_sid', 'session expired or replaced; re-read the page for a new sid')]
  let live = session   // the session after this command (a rotation replaces it)
  // 2b. idempotency replay
  if (cmd.cmdId) {
    const r = await server.idempotency.replay(sid, cmd.cmdId, hash)
    if (r.hit === 'conflict') return [conflict()]
    if (r.hit) return r.events
  }
  // 3b. an action's own rate: a bucket keyed by sid + action id
  const def = server.actions.get(cmd.action)
  // Renders skip only the default rate (3a, and the copy of it every discovered action carries); an action's OWN
  // rate still holds, keyed by ip there (a render's session may be one-call).
  // ponytail: an own rate equal to settings.limits.rate counts as the default on renders.
  const r = def?.rules?.rate, dflt = settings.limits.rate
  const own = !!r && (r.limit !== dflt.limit || r.windowMs !== dflt.windowMs)
  if (r && (own || !renderRead.has(request))) {
    const rl = await server.limiter.check({ sid: renderRead.has(request) ? `ip:${ipKey(request.ip)}` : sid, action: def!.id }, r)
    if (!rl.ok) return [rateLimited(rl.retryAfterMs)]
  }
  // 4. resolve action
  if (!def) return [ev.err('unknown_action', `unknown action ${String(cmd.action).slice(0, 100)}`, { snapshot: await snap(server, request, sid) })]

  // handler state is staged: applied only after commit
  const outbox: [string, Event][] = []
  try {
    const staged: Session = { ...session, data: structuredClone(session.data) }
    const ctx: ActionCtx = { request, session: staged, sid, settings, channels: staging(server.channels, outbox) }
    // 4.5 permissions (agent identity from request.agent; a throwing permission denies)
    await runPermissions(def.rules?.permissions ?? [], { ...permissionCtx(ctx, def.id), readOnly: !!def.rules?.readOnly })
    // 5. bind: valid MAC, issued for THIS action; $action never reaches the handler
    const bindKeys = def.rules?.bind ?? []
    if (bindKeys.length && cmd.bind === undefined) return [ev.err('stale_bind', 'this action needs the bind from its action ref; re-read the page')]
    let bound: Record<string, unknown> = {}
    if (cmd.bind !== undefined) {
      const v = verifyBind(cmd.bind, settings)
      if (!v.ok) return [ev.err('stale_bind', 'bind is invalid or expired')]
      const { $action, ...rest } = v.payload
      if ($action !== def.id) return [ev.err('stale_bind', 'bind was issued for a different action')]
      bound = rest
    }
    // 6. optimistic concurrency
    if (cmd.rev !== undefined && cmd.rev !== session.rev) {
      return [ev.err('stale_rev', `rev ${cmd.rev} is stale (current ${session.rev})`, { snapshot: await snap(server, request, sid) })]
    }
    // 6.5 middleware (global, then the action's app) wraps steps 7–10; it may short-circuit or reshape events.
    // It sees frozen params (they cannot drift from the idempotency hash). Writes it makes to ctx after
    // next() returned are outside the commit: no transaction, no rev bump, no channel flush.
    let committed: Event[] | undefined
    let busy = false, dead = false
    const steps = async (): Promise<Event[]> => {
      // 7. validate: bind-only keys may not arrive as params; signed bind values win; class views validate themselves
      // $confirm: rules.confirm's token (core/confirm.ts), never a param
      const { $confirm, ...given } = cmd.params ?? {}
      const smuggled = bindKeys.find((k) => Object.hasOwn(given, k))
      if (smuggled) return [ev.err('invalid_param', `${smuggled} comes from the signed bind, not from params`, { field: smuggled })]
      const input = { ...given, ...bound }
      const params = def.rawParams ? input : validate(def.schema, input)
      // 7.5 confirm (BACKLOG #2): an opted-in action's first call runs nothing and answers confirm_required + a token
      const ask = await confirmGate(def, input, $confirm, params, ctx, server)
      if (ask) return [ask]
      // 8. handler (atomic unless readOnly / opted out), raced against handlerMs
      if (audited(settings, def)) {
        const { $confirm: _, ...raw } = cmd.params ?? {}
        hold.audit = () => writeAudit(auditRow(settings, { action: def.id, params: raw, request, sid, cmdId: cmd.cmdId, ms: performance.now() - t0 }))
      }
      const out = await execute(def, params, ctx, server, hold)
      hold.audited = !!hold.audit
      // 9. committed: apply staged session data, bump rev, flush channel events
      session.data = staged.data
      // session fixation (cycleSession, e.g. login): rotate FIRST, so the new data (a login) is only ever saved
      // under the NEW sid. A failed rotation kills the old sid and fails the request: never log in a planted sid.
      if (wantsCycle(staged)) {
        try { live = await server.sessions.rotate(session) } catch (e) {
          server.log('error', 'session rotation failed; old session deleted', { action: def.id, error: errStr(e) })
          await server.sessions.delete(sid).catch((d: unknown) => server.log('error', 'session delete failed', { action: def.id, error: errStr(d) }))
          return [ev.err('internal', 'session could not be renewed; sign in again')]
        }
        markRotated(request, live)
      }
      try {
        if (!def.rules?.readOnly) await server.sessions.bump(live.sid, request.agent.is ? 'agent' : 'human', request.agent.is ? def.id : undefined)
        else await server.sessions.save(live)
        for (const [g, e] of outbox) server.channels.group(g).send(e)
      } catch (e) { server.log('error', 'post-commit side effect failed', { action: def.id, error: errStr(e) }) }
      // every server's snapshot cache sees this commit before anyone gets the reply
      try { await server.settle?.() } catch (e) { server.log('error', 'shared cache invalidation failed', { action: def.id, error: errStr(e) }) }
      // 10. ok + fresh snapshot (render failure after a commit → goto the page instead of a false err)
      if ('goto' in out) return (committed = [ev.ok(def.id), ev.goto(out.goto)])
      if (quiet.has(request)) return (committed = [ev.ok(def.id, out.result)])
      const s = await snap(server, request, live.sid)   // the new sid when the session was rotated
      return (committed = [ev.ok(def.id, out.result), s ? ev.snapshot(s) : ev.goto(pageOf(request))])
    }
    const inner = async function* (): AsyncIterable<Event> {
      if (dead) throw new Error('middleware called next() after its time limit')   // never run a handler nobody awaits
      busy = true
      let out: Event[]
      try { out = await steps() } finally { busy = false }
      yield* out
    }
    const chain = [...settings.actionMiddleware, ...(server.appMiddleware.get(def.id.slice(0, def.id.indexOf('.'))) ?? [])]
    const mwCmd = deepFreeze({ ...cmd, params: structuredClone(cmd.params) })
    const drained = (async () => {   // drained in full (not collect()), so code after `yield* next()` runs
      const out: Event[] = []
      for await (const e of compose(chain, mwCmd, ctx, inner)) out.push(e)
      return out
    })()
    drained.catch(() => undefined)
    // Middleware's own time is capped at handlerMs; the clock re-arms while the handler runs (it has its own limit).
    // ponytail: a middleware may get up to ~2x handlerMs around a handler; track its time exactly if that matters.
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'timeout'>((r) => {
      // dead is set in the callback itself: a next() fired by a timer in the same turn must already see it
      const arm = () => { timer = setTimeout(() => { if (busy) arm(); else { dead = true; r('timeout') } }, settings.limits.handlerMs) }
      arm()
    })
    let events: Event[]
    try {
      const r = await Promise.race([drained, expired])
      if (r === 'timeout') {
        server.log('error', 'middleware timeout', { action: def.id, handlerMs: settings.limits.handlerMs })
        if (!committed) return [ev.err('internal', 'middleware timeout')]
        events = committed
      } else events = r
    } catch (e) {
      if (!committed) throw e
      // committed work is never reported as failed (a retry would run it twice)
      server.log('error', 'middleware failed after commit', { action: def.id, error: errStr(e) })
      events = committed
    } finally { clearTimeout(timer) }
    // the caller stops at the first terminal event, so that one must carry the committed outcome
    const end = events.findIndex(isTerminal)
    const seen = end < 0 ? events : events.slice(0, end + 1)
    if (committed && !seen.some((e) => e.kind === 'ok' || e.kind === 'goto')) {
      server.log('error', 'middleware dropped the committed result', { action: def.id })
      events = committed
    }
    if (committed && cmd.cmdId) {
      try { await server.idempotency.remember(sid, cmd.cmdId, hash, events) }
      catch (e) { server.log('error', 'idempotency store failed', { action: def.id, error: errStr(e) }) }   // committed: never report failure
    }
    return events
  } catch (e) {
    if (e instanceof HandlerTimeout) return [ev.err('internal', 'handler timeout')]
    if (e instanceof DomainError) {
      const code = e.code === 'invalid_param' || e.code === 'internal' ? e.code : 'domain'
      return [ev.err(code, e.message, { field: e.field, errors: e.errors, reason: e.code })]
    }
    server.log('error', 'action failed', { action: def.id, error: errStr(e) })
    return [ev.err('internal', 'internal error')]
  }
}

type Outcome = { result: unknown } | { goto: string }

async function execute(def: ActionDef, params: unknown, ctx: ActionCtx, server: ServerCtx, hold: Hold): Promise<Outcome> {
  const { handlerMs } = server.settings.limits
  const call = async (): Promise<Outcome> => {
    // rules.cache (Django cache_page): a fresh stored result skips the handler; errors are never stored. A cache hit
    // is still an audited command (the audit write below runs either way)
    const handler = () => scope.run(ctx, () => def.run(params, ctx))
    let out: Outcome
    try { out = { result: await (def.rules?.cache ? cachedRun(def, params, ctx, handler) : handler()) } }
    catch (e) {
      const url = redirectUrl(e)
      if (url === undefined) throw e
      out = { goto: siteRedirect(url, { base: `http://${hostOf(ctx.request, server.settings) ?? 'tvine.local'}`, hosts: [hostOf(ctx.request, server.settings) ?? 'tvine.local'], route: server.route }) }   // goto commits; a refused one rolls back
    }
    // in a transaction the audit row is all-or-nothing with the handler (a failed write rolls it back). Without one
    // the handler's work is already done: a failed write is logged, never turned into an error (a retry would repeat it)
    if (hold.audit) {
      if (tx) await hold.audit()
      else await hold.audit().catch((e: unknown) => server.log('error', 'audit write failed', { action: def.id, error: errStr(e) }))
    }
    return out
  }
  // lazy: BEGIN only at the handler's first query, so DB-free handlers open nothing
  const tx = server.settings.db.atomicRequests && !def.rules?.readOnly && def.rules?.atomic !== false
  const ac = new AbortController()
  const work = tx ? atomic(call, { signal: ac.signal, lazy: true }) : withPending(call)   // either way: the reply waits for un-awaited writes
  hold.settled = work
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<true>((r) => { timer = setTimeout(() => r(true), handlerMs) })
  try {
    if (!tx) return await Promise.race([work, timedOut.then((): never => { throw new HandlerTimeout() })])
    if (await Promise.race([work.then(() => false, () => false), timedOut])) {
      // leak guard: the transaction outlived handlerMs. Abort marks it dead, then wait for the real
      // outcome: a COMMIT already in flight may still succeed, and then the request DID commit.
      server.log('warn', 'handler timeout; transaction aborted', { action: def.id, handlerMs })
      ac.abort(new HandlerTimeout())
      // second, generous cap: a hung COMMIT must not hang the request (the block is already marked dead)
      const capped = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new HandlerTimeout()), 3 * handlerMs) })
      try { return await Promise.race([work, capped]) } catch { throw new HandlerTimeout() }
    }
    return await work
  } finally { clearTimeout(timer) }
}
