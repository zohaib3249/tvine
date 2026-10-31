// core/ui — headless `ui` resolver (docs/design/frontend/v2/core/headless-parity.md, control-protocol.md).
// A browserless agent operates a widget control; Warp maps it to the control's headless path:
// url → same page with ?param=value; rendered → nothing to do; params → dispatch the bound action;
// call → dispatch a plain api call (no bind);
// session → dispatch the built-in `weft.uiState`. Every server write goes through dispatch(), so
// permissions, binds, rules.bind, rate limits, idempotency and atomic commits are the same as `do`.
import { z } from 'zod'
import { builtins, defineAction } from './actions.js'
import { DomainError } from './errors.js'
import { collect, dispatch, type ServerCtx } from './dispatch.js'
import { ev } from './events.js'
import type { ActionDef, ErrCode, Event, Request, Session, Sid, Snapshot } from './types.js'
import { hashParams } from '../security/idempotency.js'
import { signBind } from '../security/sign.js'
import { expand, toTree, type CtlFrag, type ParamSpec } from '../shape/disclose.js'

export const UI_STATE = 'weft.uiState'
export const MAX_STEPS = 20

// Built-in: writes session.data['ui:'+key]. key/enum come ONLY from the signed bind the resolver makes
// from the server-rendered fragment, so an agent can write only declared keys and values. mcp:false:
// reachable only through `ui`.
const uiState = defineAction(UI_STATE,
  z.object({ key: z.string().min(1).max(100), enum: z.array(z.string()).nullable(), value: z.string().max(1000) }),
  async ({ key, enum: allowed, value }, ctx) => {
    if (allowed && !allowed.includes(value)) throw new DomainError('invalid_param', `value must be one of ${allowed.join('|')}`, 'value')
    ctx.session.data.set(`ui:${key}`, value)
    return { [key]: value }
  },
  { bind: ['key', 'enum'], mcp: false, readOnly: false })
builtins.add(uiState)

// Registered on first use (the manifest is app-built); the app name `weft` is reserved (actions.ts).
export function ensureBuiltins(server: ServerCtx): ActionDef {
  return server.actions.get(UI_STATE) ?? (server.actions.register('weft', uiState), server.actions.get(UI_STATE)!)
}

// The page as `sid` last saw it at the current rev (expand never re-renders); miss → one render, cached.
export async function pageSnapshot(server: ServerCtx, sid: Sid, page: string): Promise<Snapshot> {
  const hit = server.sessions.recall(sid, page)
  if (hit) return hit
  const snap = await server.snapshot(page, sid)
  server.sessions.remember(snap)
  return snap
}

export const hasNode = (snap: Snapshot, id: string) => expand(toTree(snap, { headless: true }), id, { limit: 0 }) !== undefined

// ---- command -------------------------------------------------------------------------------
const step = () => z.object({ target: z.string(), control: z.string(), args: z.record(z.unknown()).default({}) })
export const uiInput = z.object({
  url: z.string(), sid: z.string().optional(), cmdId: z.string().optional(), rev: z.number().int().optional(),
  target: z.string().optional(), control: z.string().optional(), args: z.record(z.unknown()).optional(),
  steps: z.array(step()).min(1).max(MAX_STEPS).optional(),
})
export type UiInput = z.infer<typeof uiInput>
type Step = z.infer<ReturnType<typeof step>>
export const stepsOf = (u: Omit<UiInput, 'url'>): Step[] | undefined =>
  u.steps ?? (u.target !== undefined && u.control !== undefined ? [{ target: u.target, control: u.control, args: u.args ?? {} }] : undefined)

export interface UiEnv {
  session: Session
  page: string
  // the Request for a page of this site, guards checked; undefined = not a page / refused
  request(page: string): Promise<Request | undefined>
  filter?(s: Snapshot): Snapshot   // MCP: drop controls bound to MCP-disabled actions
}
type StepResult = { i: number; target: string; ok: true; result?: unknown } | { i: number; target: string; ok: false; code: ErrCode; message: string }

// → [ok('ui', {steps, page}), snapshot] or [err (the failing step), ...]. Steps run in order and stop at the
// first failure; earlier steps are not undone. A sub-action runs with cmdId `${cmdId}.${i}` (retry-safe).
export async function runUi(server: ServerCtx, steps: Step[], cmd: { cmdId?: string; rev?: number }, env: UiEnv): Promise<{ events: Event[]; page: string }> {
  const { session } = env
  const sid = session.sid
  let page = env.page
  const filter = env.filter ?? ((s: Snapshot) => s)
  const snapNow = async () => filter(await pageSnapshot(server, sid, page))
  if (cmd.rev !== undefined && cmd.rev !== session.rev) {
    return { page, events: [ev.err('stale_rev', `rev ${cmd.rev} is stale (current ${session.rev})`, { snapshot: await snapNow() })] }
  }
  // idempotency for the whole command: a retry with the same cmdId returns the stored result before any step
  // runs (sub-actions' own binds are re-signed per run, so their hashes alone would conflict)
  const key = cmd.cmdId === undefined ? undefined : `ui:${cmd.cmdId}`
  const hash = key ? hashParams({ steps, rev: cmd.rev ?? null }) : ''
  if (key) {
    const r = await server.idempotency.replay(sid, key, hash)
    if (r.hit === 'conflict') return { page, events: [ev.err('conflict', 'cmdId was already used with different steps; send a new cmdId')] }
    if (r.hit) return { page: pageOfEvents(r.events) ?? page, events: r.events }
  }
  const exec = async (): Promise<{ page: string; events: Event[] }> => {
    const done: StepResult[] = []
    const fail = async (i: number, s: Step, code: ErrCode, message: string, o: { reason?: string; field?: string } = {}) => {
      const ran = done.length ? ` (steps 0-${i - 1} ran)` : ''
      return { page, events: [ev.err(code, `step ${i} ${s.target}.${s.control}: ${message}${ran}`, { ...o, snapshot: await snapNow() })] }
    }
    for (const [i, s] of steps.entries()) {
      const snap = await snapNow()
      const w = snap.widgets?.find((x) => x.id === s.target)
      if (w?.ho) return fail(i, s, 'human_only', `only a human can do this here (${w.ho}); ask the user to do it`, { reason: 'human_only' })
      const c: CtlFrag | undefined = w?.ctl && Object.hasOwn(w.ctl, s.control) ? w.ctl[s.control] : undefined
      // missing, disabled and agent-denied controls answer alike (can't be probed)
      const handle = (c?.h as { params?: { id?: unknown; bind?: unknown; agent?: unknown } } | undefined)?.params
      if (!c || c.enabled === false || handle?.agent === false || (c.h as { agent?: unknown } | undefined)?.agent === false) return fail(i, s, 'unknown_action', 'no such control on this page; re-read the page for widget ids and controls')
      const h = c.h as Record<string, unknown> | undefined
      if (!h) return fail(i, s, 'unknown_action', 'this control changes the page only in a browser tab (no headless path)', { reason: 'in_tab_only' })
      const bad = checkArgs(c.in, s.args)
      if (bad) return fail(i, s, 'invalid_param', bad.message, { field: bad.field })
      const value = s.args.value ?? Object.values(s.args)[0]

      if (typeof h.url === 'string') {
        // clear → drop the param; submit → the query as it is (the field's input already set it); else a value
        const keep = c.kind === 'clear' || c.kind === 'submit'
        if (!keep && (value === undefined || (typeof value === 'object' && value !== null))) return fail(i, s, 'invalid_param', 'needs a value', { field: 'value' })
        const u = new URL(page, 'http://tvine.local')
        if (c.kind === 'clear') u.searchParams.delete(h.url)
        else if (c.kind !== 'submit') u.searchParams.set(h.url, String(value))
        const next = u.pathname + u.search
        if (!(await env.request(next))) return fail(i, s, 'domain', 'that page is not reachable', { reason: 'forbidden' })
        page = next
        done.push({ i, target: s.target, ok: true, result: { goto: page } })
      } else if (h.rendered === true) {
        done.push({ i, target: s.target, ok: true })   // content is already in the snapshot: expand(target) shows it
      } else if ((handle && typeof handle.id === 'string') || typeof h.call === 'string') {
        if (typeof h.field === 'string') return fail(i, s, 'unknown_action', `set ${h.field} in the args of the form's submit control instead`, { reason: 'in_tab_only' })
        // plain api call (the default): the page's fixed args + the agent's, no bind; the action validates everything
        const call = typeof h.call === 'string'
          ? { action: h.call, params: { ...(h.args && typeof h.args === 'object' ? h.args : {}), ...s.args } }
          : { action: handle!.id as string, params: s.args, bind: typeof handle!.bind === 'string' && handle!.bind ? handle!.bind : undefined   /* '' = unbound (v1 ActionRef) */ }
        const r = await act(server, env, page, call, sid, cmd.cmdId, i)
        if ('err' in r) return { page, events: [{ ...r.err, message: `step ${i} ${s.target}.${s.control}: ${r.err.message}` }] }
        if (r.goto && !(await env.request(r.goto))) {
          // the action navigated somewhere these steps can't follow: last step → ok + goto; else say exactly what ran
          const ran = [...done, { i, target: s.target, ok: true as const }]
          if (i === steps.length - 1) return { page, events: [ev.ok('ui', { steps: ran, page }), ev.goto(r.goto)] }
          return { page, events: [ev.err('domain', `step ${i} ${s.target}.${s.control} navigated to ${r.goto.slice(0, 200)}; steps 0-${i} ran, steps ${i + 1}-${steps.length - 1} did not. Re-read that page and continue there`, { reason: 'navigated' })] }
        }
        if (r.goto) page = r.goto
        done.push({ i, target: s.target, ok: true, ...(r.result !== undefined && { result: r.result }) })
      } else if (typeof h.session === 'string') {
        ensureBuiltins(server)
        const allowed = Array.isArray(h.enum) ? h.enum.map(String) : null
        const bind = signBind({ $action: UI_STATE, key: h.session, enum: allowed }, server.settings)
        const r = await act(server, env, page, { action: UI_STATE, params: { value: value === undefined ? '' : String(value) }, bind }, sid, cmd.cmdId, i)
        if ('err' in r) return { page, events: [{ ...r.err, message: `step ${i} ${s.target}.${s.control}: ${r.err.message}` }] }
        done.push({ i, target: s.target, ok: true, result: r.result })
      } else {
        return fail(i, s, 'unknown_action', 'this control has no headless path', { reason: 'in_tab_only' })
      }
    }
    return { page, events: [ev.ok('ui', { steps: done, page }), ev.snapshot(await snapNow())] }
  }
  const out = await exec()
  if (key) await server.idempotency.remember(sid, key, hash, out.events)
  return out
}

const pageOfEvents = (events: Event[]): string | undefined => {
  for (const e of events) {
    if (e.kind === 'snapshot') return e.snapshot.page
    if (e.kind === 'err' && e.snapshot) return e.snapshot.page
  }
}

type ErrEv = Extract<Event, { kind: 'err' }>
async function act(server: ServerCtx, env: UiEnv, page: string, c: { action: string; params: Record<string, unknown>; bind?: string }, sid: Sid, cmdId: string | undefined, i: number)
  : Promise<{ err: ErrEv } | { result?: unknown; goto?: string }> {
  const request = await env.request(page)
  if (!request) return { err: ev.err('domain', 'that page is not reachable', { reason: 'forbidden' }) as ErrEv }
  const events = await collect(dispatch({ ...c, sid, ...(cmdId !== undefined && { cmdId: `${cmdId}.${i}` }) }, server, request, { snapshot: false }))
  const err = events.find((e): e is ErrEv => e.kind === 'err')
  if (err) return { err: { ...err, snapshot: undefined } }
  const ok = events.find((e) => e.kind === 'ok') as Extract<Event, { kind: 'ok' }> | undefined
  const goto = events.find((e) => e.kind === 'goto') as Extract<Event, { kind: 'goto' }> | undefined
  return { result: ok?.result, goto: goto?.url }
}

// Args vs the control's ParamSpec (only listed args; required present; type/enum/range).
function checkArgs(spec: Record<string, ParamSpec> | undefined, args: Record<string, unknown>): { field: string; message: string } | undefined {
  if (!spec) return undefined
  for (const k of Object.keys(args)) if (!Object.hasOwn(spec, k)) return { field: k, message: `unknown arg ${k.slice(0, 50)}` }
  for (const [k, s] of Object.entries(spec)) {
    const v = args[k]
    if (v === undefined) { if (!s.optional) return { field: k, message: `${k} is required` }; continue }
    const one = (x: unknown): string | undefined => {
      if (s.enum && !s.enum.includes(x)) return `${k} must be one of ${s.enum.join('|')}`
      if (s.type === 'number' && (typeof x !== 'number' || (s.min !== undefined && x < s.min) || (s.max !== undefined && x > s.max))) return `${k} must be a number${s.min !== undefined ? ` ${s.min}..${s.max ?? ''}` : ''}`
      if (s.type === 'boolean' && typeof x !== 'boolean') return `${k} must be true or false`
      if (s.type === 'string' && !s.enum && typeof x !== 'string') return `${k} must be text`
    }
    const m = s.multiple ? (Array.isArray(v) ? v.map(one).find(Boolean) : `${k} must be a list`) : one(v)
    if (m) return { field: k, message: m }
  }
}
