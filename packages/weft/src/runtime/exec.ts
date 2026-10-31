import { callControl, humanOnlyMessage, WeftError, type CallOptions } from '../widget/hooks.js'
import type { ActionHandle, ActionOutcome, Control, ErrCode, Json, ParamSpec, PresenceOptions, UiStepResult } from '../widget/types.js'
import { listed } from '../widget/vocabulary.js'
import { getOverlay, POINTED } from '../presence/overlay.js'
import { agentState } from './fragment.js'
import { getRegistry, type Entry } from './registry.client.js'
import { agentNavigate } from './nav.js'

// control-protocol.md: the in-tab executor. A `ui` command = steps run in order, stop at the first
// failure, nothing undone; the result lists exactly the steps that ran. Every step goes through
// callControl, so onAgentAction/afterAgentAction hooks (veto) run for agent calls on every path.

export interface UiStep { target: string; control: string; args?: Record<string, unknown> }
export interface UiCommand { steps?: UiStep[]; target?: string; control?: string; args?: Record<string, unknown>; cmdId?: string; rev?: number }
export interface Touched { id: string; kind: string; label: string; state?: Json }
export interface UiResult { cmdId: string; rev: number; page: string; steps: UiStepResult[]; touched: Touched[]; notice?: string }
// maybeApplied: the step timed out or was stopped mid-call; it may still have taken effect → re-read, don't retry.
export interface UiError { code: ErrCode; message: string; reason?: string; field?: string; maybeApplied?: true }

export interface ExecOptions {
  via: CallOptions['via']
  source?: CallOptions['source']   // 'gallery': the dev gallery's "try it as agent" (same executor, same hooks)
  agent?: CallOptions['agent']
  // ActionHandle → server dispatch, with the per-step cmdId `${cmdId}.${i}` (retries never re-run it).
  run?: (handle: ActionHandle, params: Record<string, unknown>, cmdId: string) => Promise<ActionOutcome>
  navigate?: CallOptions['navigate']
}

export const limits = { maxSteps: 20, stepTimeoutMs: 5_000, cmdTimeoutMs: 15_000, keep: 32, drainMs: 30_000 }

// ---- Stop (security.md §In-browser agents): blocks the executor and the WebMCP tools until Resume.
// Survives reload for the session (sessionStorage; fallback in-memory).
const STOP_KEY = 'tvine.agent.stopped'
let memStopped = false
let stopAc = new AbortController()
const store = () => { try { return globalThis.sessionStorage } catch { return undefined } }
export function isStopped(): boolean { try { return store()?.getItem(STOP_KEY) === '1' || memStopped } catch { return memStopped } }
export function setStopped(on: boolean): void {
  memStopped = on
  try { on ? store()?.setItem(STOP_KEY, '1') : store()?.removeItem(STOP_KEY) } catch { /* private mode */ }
  if (on) { stopAc.abort(); stopAc = new AbortController() }
}
// Remote Stop/release (security.md §Remote agents): abort the running command's steps without blocking the tab.
export function abortRunning(): void { stopAc.abort(); stopAc = new AbortController() }
const stopped = (): UiError => ({ code: 'domain', reason: 'stopped', message: 'the human pressed Stop; agent control is blocked in this tab' })

// ---- Idempotency: a repeated cmdId returns the stored result (last 32); a concurrent repeat joins.
type Out = { result: UiResult; error?: UiError }
const seen = new Map<string, Promise<Out>>()
let tail: Promise<void> = Promise.resolve()
export function resetExecutor(): void { seen.clear(); setStopped(false) }

// Dev observers (the gallery's inspector feed): told after every command, with what ran. Empty in production
// unless dev code subscribed, so the cost there is one size check.
// `steps`: the command's steps with args already masked, decided per step inside execute() while the widget is
// known (sensitive widget → every arg; secret param → that arg). A step never resolved → every arg masked.
export type ExecSeen = { steps: UiStep[]; via: ExecOptions['via']; source?: ExecOptions['source']; out: Out; ms: number }
const MASK = '[sensitive]'
const maskAll = (a: Record<string, unknown> = {}) => Object.fromEntries(Object.keys(a).map((k) => [k, MASK]))
const stepsOf = (cmd: UiCommand): UiStep[] => (Array.isArray(cmd.steps) ? cmd.steps : cmd.target ? [{ target: cmd.target, control: cmd.control ?? '', args: cmd.args }] : [])
export const execWatchers = new Set<(e: ExecSeen) => void>()

export function runUi(cmd: UiCommand, o: ExecOptions): Promise<Out> {
  const cmdId = typeof cmd.cmdId === 'string' && cmd.cmdId ? cmd.cmdId.slice(0, 128) : newCmdId()
  const hit = seen.get(cmdId)
  if (hit) return hit
  // One command at a time per tab: steps of two commands never interleave.
  // A timed-out/stopped step's control keeps running: the next command waits for it (bounded by drainMs).
  let running: Promise<unknown> = Promise.resolve()
  const t0 = Date.now()
  const safe: Record<string, unknown>[] = []   // per step: args as a dev observer may see them (filled by execute)
  const p = tail.then(() => execute(cmd, cmdId, o, (c) => { running = c }, safe))
  if (execWatchers.size) void p.then((out) => {
    const steps = stepsOf(cmd).slice(0, limits.maxSteps).map((s, i) => ({ target: String(s?.target), control: String(s?.control), args: safe[i] ?? maskAll(s?.args) }))
    for (const f of execWatchers) try { f({ steps, via: o.via, source: o.source, out, ms: Date.now() - t0 }) } catch { /* a dev observer never breaks a command */ }
  })
  tail = p.then(() => drain(running), () => drain(running))
  seen.set(cmdId, p)
  // Blocked before anything ran (Stop): not a result worth replaying after Resume.
  p.then((r) => { if (r.error?.reason === 'stopped' && !r.result.steps.some((x) => x.ok)) seen.delete(cmdId) })
  if (seen.size > limits.keep) seen.delete(seen.keys().next().value!)
  return p
}

function drain(c: Promise<unknown>): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([c.then(() => {}, () => {}), new Promise<void>((r) => { t = setTimeout(r, limits.drainMs) })]).finally(() => clearTimeout(t))
}

function newCmdId(): string {
  const c = (globalThis as any).crypto
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

const page = () => { const l = (globalThis as any).location; return l ? l.pathname + l.search : '' }

async function execute(cmd: UiCommand, cmdId: string, o: ExecOptions, hold: (call: Promise<unknown>) => void, safe: Record<string, unknown>[] = []): Promise<Out> {
  const reg = getRegistry()
  const steps: UiStepResult[] = [], touched = new Map<string, Entry>()
  const done = (error?: UiError): Out => ({
    result: {
      cmdId, rev: reg.rev, page: page(), steps,
      touched: [...touched.values()].map((e) => { const s = agentState(e.spec); return { id: e.id, kind: e.kind, label: e.spec.label, ...(s !== undefined && { state: s }) } }),
    },
    ...(error && { error }),
  })
  if (isStopped()) return done(stopped())
  const list: UiStep[] = cmd.steps ?? (cmd.target ? [{ target: cmd.target, control: cmd.control ?? '', args: cmd.args }] : [])
  if (!Array.isArray(list) || !list.length || list.length > limits.maxSteps) return done({ code: 'invalid_param', field: 'steps', message: `steps: 1..${limits.maxSteps} required` })
  if (cmd.rev !== undefined && cmd.rev !== reg.rev) return done({ code: 'stale_rev', message: `page changed (rev ${reg.rev}); read_page again` })

  const signal = stopAc.signal
  const deadline = Date.now() + limits.cmdTimeoutMs
  const overlay = getOverlay()
  for (let i = 0; i < list.length; i++) {
    const { target, control } = list[i] ?? ({} as UiStep)
    const args = list[i]?.args ?? {}
    const fail = (err: UiError) => { steps.push({ i, target: String(target), ok: false, ...err }); return done(err) }
    if (isStopped() || signal.aborted) return fail(stopped())

    const e = typeof target === 'string' ? reg.get(target) : undefined
    if (e?.spec.humanOnly) return fail({ code: 'human_only', reason: 'human_only', message: humanOnlyMessage(e.spec.humanOnly) })
    const c = e && callable(e, control)
    // Missing, hidden, disabled, bound to an agent-off action, or behind an open modal ([inert], as tree()): the same answer.
    if (!e || !c || e.el?.closest('[inert]')) return fail({ code: 'unknown_action', message: `unknown control ${control} on ${target}` })
    const ps = (c.params ?? {}) as Record<string, ParamSpec>
    safe[i] = e.spec.sensitive ? maskAll(args) : Object.fromEntries(Object.entries(args).map(([k, v]) => [k, ps[k]?.secret ? MASK : v]))
    const bad = checkArgs(c.params, args)
    if (bad) return fail({ code: 'invalid_param', field: bad.field, message: bad.message })

    const handle = c.headless && 'params' in c.headless ? c.headless.params : undefined
    const act = { verb: c.kind, label: c.label ?? e.spec.label, control, danger: !!handle?.danger, options: e.spec.presence as false | PresenceOptions | undefined }
    const presence = overlay.presenceFor(act, signal)
    e.agent?.({ active: true, verb: c.kind })
    // Styling hook only: destructive actions are never refused by the framework (apps veto via hooks).
    if (act.danger) e.el?.setAttribute('data-agent-danger', '')
    const end = overlay.begin(e.el, act)
    touched.set(e.id, e)
    try {
      if (POINTED.has(c.kind)) await presence.point(e.el)
      const call = callControl(target, control, args, {
        via: o.via, source: o.source, cmdId, step: i, signal, presence, agent: o.agent,
        // In-tab navigate: same-site client transition, resolves after the new page settles (navigation-spa.md).
        navigate: o.navigate ?? (async (href) => { await agentNavigate(href, signal) }),
        ...(o.run && { run: (h, p) => o.run!(h, p ?? {}, `${cmdId}.${i}`) }),
      })
      hold(call)
      const result = await race(call, Math.min(limits.stepTimeoutMs, deadline - Date.now()), signal)
      const now = reg.get(target)
      const s = now && agentState(now.spec)
      steps.push({ i, target, ok: true, ...(s !== undefined && { state: s }), ...(result !== undefined && { result }) })
    } catch (err) {
      if (signal.aborted) return fail({ ...stopped(), maybeApplied: true })
      if (err instanceof WeftError) return fail({ code: err.code, message: err.message, ...(err.reason && { reason: err.reason }), ...(err.field && { field: err.field }) })
      if (err === TIMEOUT) return fail({ code: 'domain', reason: 'timeout', message: 'step timed out; it may still have taken effect: read_page before retrying', maybeApplied: true })
      return fail({ code: 'internal', message: err instanceof Error ? err.message : String(err) })
    } finally {
      end()
      e.el?.removeAttribute('data-agent-danger')
      e.agent?.({ active: false })
    }
  }
  return done()
}

function callable(e: Entry, name: string): Control | undefined {
  const c = listed(e.spec).find(([n]) => n === name)?.[1]
  // An action handle with agent:false (mcp:false / denyAgents) is not callable by agents.
  if (c?.headless && 'params' in c.headless && c.headless.params.agent === false) return undefined
  return c
}

const TIMEOUT = Symbol('timeout')
function race<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(TIMEOUT), Math.max(0, ms))
    const ab = () => rej(new Error('stopped'))
    signal.addEventListener('abort', ab, { once: true })
    p.then(res, rej).finally(() => { clearTimeout(t); signal.removeEventListener('abort', ab) })
  })
}

// ParamSpec check before callControl (which does not validate): unknown, missing, and ill-typed args.
export function checkArgs(params: Record<string, ParamSpec> | undefined, args: unknown): { field: string; message: string } | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { field: 'args', message: 'args must be an object' }
  const ps = params ?? {}
  for (const k of Object.keys(args)) if (!Object.hasOwn(ps, k)) return { field: k, message: `unknown param ${k}` }
  for (const [k, p] of Object.entries(ps)) {
    const v = (args as Record<string, unknown>)[k]
    if (v === undefined || v === null) { if (p.optional) continue; return { field: k, message: `${k} is required` } }
    const vs = p.multiple ? v : [v]
    if (!Array.isArray(vs)) return { field: k, message: `${k} must be a list` }
    for (const x of vs) { const m = checkOne(p, x); if (m) return { field: k, message: `${k} ${m}` } }
  }
}

function checkOne(p: ParamSpec, v: unknown): string | undefined {
  switch (p.type) {
    case 'string': case 'date': {
      if (typeof v !== 'string') return `must be a ${p.type}`
      if (p.type === 'date' && Number.isNaN(Date.parse(v))) return 'must be a date'
      if (p.maxLength !== undefined && v.length > p.maxLength) return `is longer than ${p.maxLength}`
      if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(v)) return 'has the wrong format'
      if (p.enum && !p.enum.includes(v)) return `must be one of ${p.enum.join('|')}`
      return
    }
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number'
      if (p.min !== undefined && v < p.min) return `must be ≥ ${p.min}`
      if (p.max !== undefined && v > p.max) return `must be ≤ ${p.max}`
      return
    case 'boolean': return typeof v === 'boolean' ? undefined : 'must be true or false'
    default: return   // file/json: the control checks its own shape
  }
}
