// core/dispatch — the single mutation path (docs/design/server/core-dispatch.md). Every command
// (HTTP, MCP, channel, WebMCP, human <Form>) runs this pipeline; first failure → one `err` event.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ActionManifest } from './actions.js'
import { MemoryChannelLayer } from './channels.js'
import { DomainError } from './errors.js'
import { siteRedirect } from './redirect.js'
import { ev, isTerminal } from './events.js'
import { compose, deepFreeze, Hooks } from './middleware.js'
import { SessionStore } from './session.js'
import type { ActionCtx, ActionDef, ChannelLayer, Command, Event, Middleware, Request, Session, Settings, Sid, Snapshot } from './types.js'
import { atomic, setOnCommitErrorHandler } from '../data/engine.js'
import { hashParams, IdempotencyCache } from '../security/idempotency.js'
import { permissionCtx, runPermissions } from '../security/permissions.js'
import { RateLimiter } from '../security/ratelimit.js'
import { verifyBind } from '../security/sign.js'
import type { Ctx } from '../serialize/envelope.js'
import { validate } from '../views/generic.js'

export type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

export interface ServerCtx {
  actions: ActionManifest
  sessions: SessionStore
  snapshot: (route: string, sid: Sid) => Promise<Snapshot>
  settings: Settings
  channels: ChannelLayer           // the same layer the SessionStore was built on
  limiter: RateLimiter
  idempotency: IdempotencyCache
  log: Log
  hooks: Hooks                     // server.ctx.hooks.on('command' | 'error' | 'session' | 'read', fn)
  appMiddleware: Map<string, Middleware[]>   // apps/<app>/middleware.ts (discoverMiddleware)
  route?: (path: string) => string | undefined   // the site's route matcher (createAgentServer): redirect targets must match
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
  const channels = o.channels ?? new MemoryChannelLayer()
  const log: Log = o.log ?? (settings.logging === 'none' ? () => {} : (level, msg, data) => console[level](JSON.stringify({ level, msg, ...data })))
  const closers: (() => unknown)[] = []
  const ctx: ServerCtx = {
    ...o, channels, log, close: () => {}, health: o.health ?? new Map(), onClose: (fn) => { closers.push(fn) },
    hooks: o.hooks ?? new Hooks((hook, e) => log('error', 'hook failed', { hook, error: errStr(e) })),
    appMiddleware: o.appMiddleware ?? new Map(),
    sessions: o.sessions ?? new SessionStore(settings.session, { channels }),
    limiter: o.limiter ?? new RateLimiter(settings.limits.rate),
    idempotency: o.idempotency ?? new IdempotencyCache(settings.session.ttlMs),
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

// Requests whose caller discards snapshots (the human <Form>: formResult only reads ok/err/goto).
const quiet = new WeakSet<Request>()

export async function* dispatch(cmd: Command, server: ServerCtx, request: Request, opts: { snapshot?: boolean } = {}): AsyncIterable<Event> {
  if (opts.snapshot === false) quiet.add(request)
  const t0 = performance.now()
  const { sid, events } = await run(cmd, server, request)
  emitHooks(server, cmd, sid, events, Math.round(performance.now() - t0))
  yield* events
}

// Hooks fire once run() settled (an ok is always after its commit), on a frozen copy: a hook can alter
// neither the reply nor the stored idempotency result. Deferred past the reply.
// ponytail: setImmediate only defers; a hook doing slow sync work still blocks the event loop.
function emitHooks(server: ServerCtx, cmd: Command, sid: Sid | undefined, events: Event[], ms: number): void {
  const { hooks } = server
  const err = events.find((e): e is Extract<Event, { kind: 'err' }> => e.kind === 'err')
  if (!hooks.has('command') && !(err && hooks.has('error'))) return
  let copy: { cmd: Command; events: Event[] }
  try { copy = deepFreeze(structuredClone({ cmd, events })) }
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
export function renderCtx(server: ServerCtx, cmd: Pick<Command, 'sid'>, request: Request): Ctx {
  const s = server.sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, server.settings) })
  return { sid: s?.sid ?? cmd.sid ?? '', rev: s?.rev ?? 0, page: pageOf(request) }
}

// The human <Form> shim's result (weft FormResult, primitive-form.md §Human validation errors).
export interface FormResult { ok: boolean; errors?: Record<string, string>; message?: string; goto?: string }
export function formResult(events: Event[]): FormResult {
  for (const e of events) {
    if (e.kind === 'err') return { ok: false, ...(e.code === 'invalid_param' && e.field && { errors: { [e.field]: e.message } }), message: e.message }
    if (e.kind === 'goto') return { ok: true, goto: e.url }
  }
  return { ok: true }
}

// ---- helpers -------------------------------------------------------------------------------
const pageOf = (r: Request) => { const q = r.query.toString(); return q ? `${r.path}?${q}` : r.path }

function cookieOf(r: Request, s: Settings): string | undefined {
  for (const part of (r.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === s.session.cookieName) return part.slice(i + 1).trim()
  }
  return undefined
}

// Next's server-action check, kept for every path into dispatch: a browser Origin must match the host.
// No Origin (curl, SDKs, MCP clients) passes. ponytail: no allowedOrigins list yet; add with settings when needed.
// the public host of the request (X-Forwarded-Host only through trusted proxies)
const hostOf = (r: Request, s: Settings) => ((s.trustProxy > 0 && r.headers.get('x-forwarded-host')?.split(',')[0]!.trim()) || r.headers.get('host'))?.toLowerCase() || undefined

export function crossOrigin(r: Request, s: Settings): boolean {
  const origin = r.headers.get('origin')
  if (origin === null) return false
  const host = hostOf(r, s)
  try { return new URL(origin).host !== host } catch { return true }
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

async function run(cmd: Command, server: ServerCtx, request: Request): Promise<Ran> {
  const { settings, sessions } = server
  const peeked = () => sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, settings) })?.sid
  if (crossOrigin(request, settings)) return { sid: peeked(), events: [ev.err('domain', 'forbidden: cross-origin request', { reason: 'forbidden' })] }
  // 2'. a retry of a FINISHED command replays before any rate token is spent (peek: creates nothing)
  const hash = cmd.cmdId ? hashParams({ action: cmd.action, params: cmd.params, bind: cmd.bind }) : ''
  const known = cmd.cmdId && sessions.peek({ sid: cmd.sid, cookie: cookieOf(request, settings) })
  if (known) {
    const r = server.idempotency.replay(known.sid, cmd.cmdId!, hash)
    if (r.hit === true) return { sid: known.sid, events: r.events }
  }
  // 3a. ip + default sid bucket first: abusive traffic never creates sessions or queues (3b, an action's own rate, runs later)
  const rl = server.limiter.check({ ip: request.ip, sid: cmd.sid ?? cookieOf(request, settings) })
  if (!rl.ok) return { sid: peeked(), events: [rateLimited(rl.retryAfterMs)] }
  // 1. session
  const session = sessions.resolve({ sid: cmd.sid, cookie: cookieOf(request, settings) })
  if (!session) {
    const fresh = sessions.create()
    return { sid: fresh.sid, events: [ev.err('expired_sid', 'session expired or missing; a new sid is attached', { snapshot: await snap(server, request, fresh.sid) })] }
  }
  const { sid } = session
  const hold: Hold = {}
  if (!cmd.cmdId) return { sid, events: await serial(sid, () => pipeline(cmd, server, request, session, '', hold)) }
  // 2a. in-flight dedupe (2b, the stored replay, runs inside the chain)
  const key = `${sid}:${cmd.cmdId}`
  const running = inFlight.get(key)
  if (running) {
    const r = await running
    return { sid, events: r.hash === hash ? r.events : [conflict()] }
  }
  const p = serial(sid, () => pipeline(cmd, server, request, session, hash, hold)).then((events) => ({ hash, events }))
  inFlight.set(key, p)
  try { return { sid, events: (await p).events } } finally {
    // held until the handler itself settles (not the timeout): a retry never runs it a second time
    void Promise.resolve(hold.settled).catch(() => undefined).then(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
  }
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

type Hold = { settled?: Promise<unknown> }   // the handler's own promise, which may outlive the timeout

async function pipeline(cmd: Command, server: ServerCtx, request: Request, session: Session, hash: string, hold: Hold): Promise<Event[]> {
  const { settings } = server, { sid } = session
  // 2b. idempotency replay
  if (cmd.cmdId) {
    const r = server.idempotency.replay(sid, cmd.cmdId, hash)
    if (r.hit === 'conflict') return [conflict()]
    if (r.hit) return r.events
  }
  // 3b. an action's own rate: a bucket keyed by sid + action id
  const def = server.actions.get(cmd.action)
  if (def?.rules?.rate) {
    const rl = server.limiter.check({ sid, action: def.id }, def.rules.rate)
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
    await runPermissions(def.rules?.permissions ?? [], permissionCtx(ctx, def.id))
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
      const smuggled = bindKeys.find((k) => Object.hasOwn(cmd.params ?? {}, k))
      if (smuggled) return [ev.err('invalid_param', `${smuggled} comes from the signed bind, not from params`, { field: smuggled })]
      const input = { ...cmd.params, ...bound }
      const params = def.rawParams ? input : validate(def.schema, input)
      // 8. handler (atomic unless readOnly / opted out), raced against handlerMs
      const out = await execute(def, params, ctx, server, hold)
      // 9. committed: apply staged session data, bump rev, flush channel events
      try {
        session.data = staged.data
        if (!def.rules?.readOnly) server.sessions.bump(sid, request.agent.is ? 'agent' : 'human')
        for (const [g, e] of outbox) server.channels.group(g).send(e)
      } catch (e) { server.log('error', 'post-commit side effect failed', { action: def.id, error: errStr(e) }) }
      // 10. ok + fresh snapshot (render failure after a commit → goto the page instead of a false err)
      if ('goto' in out) return (committed = [ev.ok(def.id), ev.goto(out.goto)])
      if (quiet.has(request)) return (committed = [ev.ok(def.id, out.result)])
      const s = await snap(server, request, sid)
      return (committed = [ev.ok(def.id, out.result), s ? ev.snapshot(s) : ev.goto(pageOf(request))])
    }
    const inner = async function* (): AsyncIterable<Event> {
      if (dead) throw new Error('middleware called next() after its time limit')   // never run a handler nobody awaits
      busy = true
      let out: Event[]
      try { out = await steps() } finally { busy = false }
      yield* out
    }
    const chain = [...settings.middleware, ...(server.appMiddleware.get(def.id.slice(0, def.id.indexOf('.'))) ?? [])]
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
    if (committed && cmd.cmdId) server.idempotency.remember(sid, cmd.cmdId, hash, events)
    return events
  } catch (e) {
    if (e instanceof HandlerTimeout) return [ev.err('internal', 'handler timeout')]
    if (e instanceof DomainError) {
      const code = e.code === 'invalid_param' || e.code === 'internal' ? e.code : 'domain'
      return [ev.err(code, e.message, { field: e.field, reason: e.code })]
    }
    server.log('error', 'action failed', { action: def.id, error: errStr(e) })
    return [ev.err('internal', 'internal error')]
  }
}

type Outcome = { result: unknown } | { goto: string }

async function execute(def: ActionDef, params: unknown, ctx: ActionCtx, server: ServerCtx, hold: Hold): Promise<Outcome> {
  const { handlerMs } = server.settings.limits
  const call = async (): Promise<Outcome> => {
    try { return { result: await scope.run(ctx, () => def.run(params, ctx)) } }
    catch (e) {
      const url = redirectUrl(e)
      if (url === undefined) throw e
      return { goto: siteRedirect(url, { base: `http://${hostOf(ctx.request, server.settings) ?? 'tvine.local'}`, hosts: [hostOf(ctx.request, server.settings) ?? 'tvine.local'], route: server.route }) }   // goto commits; a refused one rolls back
    }
  }
  // lazy: BEGIN only at the handler's first query, so DB-free handlers open nothing
  const tx = server.settings.db.atomicRequests && !def.rules?.readOnly && def.rules?.atomic !== false
  const ac = new AbortController()
  const work = tx ? atomic(call, { signal: ac.signal, lazy: true }) : call()
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
