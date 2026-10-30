// core/dispatch — the single mutation path (docs/design/server/core-dispatch.md). Every command
// (HTTP, MCP, channel, WebMCP, human <Form>) runs this pipeline; first failure → one `err` event.
import type { ActionManifest } from './actions.js'
import { MemoryChannelLayer } from './channels.js'
import { DomainError } from './errors.js'
import { ev, isTerminal } from './events.js'
import { SessionStore } from './session.js'
import type { ActionCtx, ActionDef, ChannelLayer, Command, Event, Request, Session, Settings, Sid, Snapshot } from './types.js'
import { atomic, setOnCommitErrorHandler } from '../data/engine.js'
import { hashParams, IdempotencyCache } from '../security/idempotency.js'
import { permissionCtx, runPermissions } from '../security/permissions.js'
import { RateLimiter } from '../security/ratelimit.js'
import { verifyBind } from '../security/sign.js'
import type { Ctx } from '../serialize/envelope.js'
import { validate } from '../views/generic.js'

export type Log = (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

export interface ServerCtx {
  actions: ActionManifest
  sessions: SessionStore
  snapshot: (route: string, sid: Sid) => Promise<Snapshot>
  settings: Settings
  channels: ChannelLayer           // the same layer the SessionStore was built on
  limiter: RateLimiter
  idempotency: IdempotencyCache
  log: Log
}

const errStr = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e))

// Fills the defaults (validating settings.limits.rate) and routes onCommit hook errors to the logger.
// ponytail: setOnCommitErrorHandler is process-global, so the last ServerCtx built owns it (single-process v1).
export function serverCtx(o: Pick<ServerCtx, 'actions' | 'settings' | 'snapshot'> & Partial<ServerCtx>): ServerCtx {
  const { settings } = o
  const channels = o.channels ?? new MemoryChannelLayer()
  const log: Log = o.log ?? (settings.logging === 'none' ? () => {} : (level, msg, data) => console[level](JSON.stringify({ level, msg, ...data })))
  const ctx: ServerCtx = {
    ...o, channels, log,
    sessions: o.sessions ?? new SessionStore(settings.session, { channels }),
    limiter: o.limiter ?? new RateLimiter(settings.limits.rate),
    idempotency: o.idempotency ?? new IdempotencyCache(settings.session.ttlMs),
  }
  setOnCommitErrorHandler((e) => log('error', 'onCommit hook failed', { error: errStr(e) }))
  return ctx
}

export async function* dispatch(cmd: Command, server: ServerCtx, request: Request): AsyncIterable<Event> {
  yield* await run(cmd, server, request)
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
function crossOrigin(r: Request, s: Settings): boolean {
  const origin = r.headers.get('origin')
  if (origin === null) return false
  const host = (s.trustProxy > 0 && r.headers.get('x-forwarded-host')?.split(',')[0]!.trim()) || r.headers.get('host')
  try { return new URL(origin).host !== host } catch { return true }
}

// One command at a time per sid: rev bumps and session.data writes never interleave.
const chains = new Map<Sid, Promise<unknown>>()
function serial<T>(sid: Sid, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(sid) ?? Promise.resolve()).then(fn)
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
async function run(cmd: Command, server: ServerCtx, request: Request): Promise<Event[]> {
  const { settings, sessions } = server
  if (crossOrigin(request, settings)) return [ev.err('domain', 'forbidden: cross-origin request')]
  // 1. session
  const session = sessions.resolve({ sid: cmd.sid, cookie: cookieOf(request, settings) })
  if (!session) {
    const fresh = sessions.create()
    return [ev.err('expired_sid', 'session expired or missing; a new sid is attached', { snapshot: await snap(server, request, fresh.sid) })]
  }
  const { sid } = session
  if (!cmd.cmdId) return serial(sid, () => pipeline(cmd, server, request, session, ''))
  // 2a. in-flight dedupe (2b, the stored replay, runs inside the chain)
  const hash = hashParams({ action: cmd.action, params: cmd.params, bind: cmd.bind })
  const key = `${sid}:${cmd.cmdId}`
  const running = inFlight.get(key)
  if (running) {
    const r = await running
    return r.hash === hash ? r.events : [conflict()]
  }
  const p = serial(sid, () => pipeline(cmd, server, request, session, hash)).then((events) => ({ hash, events }))
  inFlight.set(key, p)
  try { return (await p).events } finally { inFlight.delete(key) }
}

async function snap(server: ServerCtx, request: Request, sid: Sid): Promise<Snapshot | undefined> {
  try { return await server.snapshot(pageOf(request), sid) }
  catch (e) { server.log('error', 'snapshot render failed', { page: pageOf(request), error: errStr(e) }); return undefined }
}

async function pipeline(cmd: Command, server: ServerCtx, request: Request, session: Session, hash: string): Promise<Event[]> {
  const { settings } = server, { sid } = session
  // 2b. idempotency replay
  if (cmd.cmdId) {
    const r = server.idempotency.replay(sid, cmd.cmdId, hash)
    if (r.hit === 'conflict') return [conflict()]
    if (r.hit) return r.events
  }
  // 3. rate limit (an action's own rate gets a bucket keyed by its id)
  const def = server.actions.get(cmd.action)
  const rl = server.limiter.check({ sid, ip: request.ip, action: def?.id }, def?.rules?.rate)
  if (!rl.ok) return [ev.err('rate_limited', `rate limited: retry after ${rl.retryAfterMs}ms`)]
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
    // 7. validate: signed bind values win over agent-supplied params
    const params = validate(def.schema, { ...cmd.params, ...bound })
    // 8. handler (atomic unless readOnly / opted out), raced against handlerMs
    const out = await execute(def, params, ctx, server)
    // 9. committed: apply staged session data, bump rev, flush channel events
    try {
      session.data = staged.data
      server.sessions.bump(sid, request.agent.is ? 'agent' : 'human')
      for (const [g, e] of outbox) server.channels.group(g).send(e)
    } catch (e) { server.log('error', 'post-commit side effect failed', { action: def.id, error: errStr(e) }) }
    // 10. ok + fresh snapshot (render failure after a commit → goto the page instead of a false err)
    let events: Event[]
    if ('goto' in out) events = [ev.ok(def.id), ev.goto(out.goto)]
    else {
      const s = await snap(server, request, sid)
      events = [ev.ok(def.id, out.result), s ? ev.snapshot(s) : ev.goto(pageOf(request))]
    }
    if (cmd.cmdId) server.idempotency.remember(sid, cmd.cmdId, hash, events)
    return events
  } catch (e) {
    if (e instanceof HandlerTimeout) return [ev.err('internal', 'handler timeout')]
    if (e instanceof DomainError) {
      return [ev.err(e.code === 'invalid_param' ? 'invalid_param' : 'domain', e.message, { field: e.field })]
    }
    server.log('error', 'action failed', { action: def.id, error: errStr(e) })
    return [ev.err('internal', 'internal error')]
  }
}

type Outcome = { result: unknown } | { goto: string }

async function execute(def: ActionDef, params: unknown, ctx: ActionCtx, server: ServerCtx): Promise<Outcome> {
  const { handlerMs } = server.settings.limits
  const call = async (): Promise<Outcome> => {
    try { return { result: await def.run(params, ctx) } }
    catch (e) { const url = redirectUrl(e); if (url !== undefined) return { goto: url }; throw e }   // goto commits
  }
  const tx = server.settings.db.atomicRequests && !def.rules?.readOnly && def.rules?.atomic !== false
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      // leak guard: the transaction's connection was held past handlerMs; abort marks it dead
      if (tx) server.log('warn', 'db connection held past handlerMs; transaction aborted', { action: def.id, handlerMs })
      const e = new HandlerTimeout()
      ac.abort(e)
      rej(e)
    }, handlerMs)
  })
  const work = tx ? atomic(call, { signal: ac.signal }) : call()
  work.catch(() => undefined)   // settles after a timeout already answered
  try { return await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
}
