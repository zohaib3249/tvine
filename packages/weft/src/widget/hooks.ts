import { getRegistry, type Entry, type Registry } from '../runtime/registry.client.js'
import { agentState } from '../runtime/fragment.js'
import { joinId } from './ids.js'
import type { AgentActionEvent, Control, ControlCtx, ErrCode, Json, Override, Presence, UiStepResult, WidgetHooks, WidgetHandle } from './types.js'
import { listed } from './vocabulary.js'

// custom-logic.md: overrides, hook bubbling, veto. The framework never refuses an action on its
// own (owner ruling Q5): `danger`/`attention` are passed to hooks as metadata, the app decides.

export class WeftError extends Error {
  constructor(readonly code: ErrCode, message: string, readonly reason?: string, readonly field?: string) { super(message) }
}
// HumanOnly: refused before any hook runs, so no veto hook (or override) can let an agent through.
export const humanOnlyMessage = (reason: string) => `only a human can do this here (${reason}); ask the user to do it`
const veto = (reason: string) => new WeftError('domain', reason, 'veto')

type Controls = Record<string, Control<any, any>>

// false → remove · function → middleware (args, ctx, next) · partial → patch · full control → add.
export function applyOverrides(base: Controls, over?: Record<string, Override | Control<any, any> | undefined>): Controls {
  if (!over) return base
  const out = { ...base }
  for (const [k, o] of Object.entries(over)) {
    const b = base[k]
    if (o === undefined) continue
    if (o === false) delete out[k]
    else if (typeof o === 'function') {
      if (!b) throw new Error(`tvine: override "${k}" wraps a control this widget does not have`)
      out[k] = { ...b, run: (args, ctx) => {
        let calls = 0
        return o(args, ctx, async (a = args) => {
          if (++calls === 2 && process.env.NODE_ENV !== 'production') console.warn(`tvine: override "${k}" called next() more than once; the control ran twice`)
          return b.run(a, ctx)
        })
      } }
    } else if (b) out[k] = { ...b, ...o }
    else if (o.kind && o.run) out[k] = o as Control<any, any>
    else throw new Error(`tvine: override "${k}" is not a control of this widget; a new control needs kind and run`)
  }
  return out
}

export interface CallOptions {
  via: ControlCtx['via']
  cmdId: string
  step?: number
  source?: ControlCtx['source']
  signal?: AbortSignal
  presence?: Presence
  run?: ControlCtx['run']                 // ActionHandle → submitForm → dispatch (W4/W6 wire it)
  navigate?: ControlCtx['navigate']       // client navigation (W8)
  agent?: AgentActionEvent['agent']
}

const NO_PRESENCE: Presence = { point: async () => {}, type: async () => {}, say: () => {} }

// Target first, then each registered ancestor in its mount's scope chain, then <WeftRoot hooks>.
function chain(reg: Registry, e: Entry): WidgetHooks[] {
  const out: WidgetHooks[] = []
  if (e.spec.hooks) out.push(e.spec.hooks)
  for (const p of ancestors(reg, e)) { const h = reg.get(p)?.spec.hooks; if (h) out.push(h) }
  for (const r of reg.roots) if (r.hooks) out.push(r.hooks)
  return out
}

// The mount's own scope chain (through RSC containers, which have no hooks but may sit inside a client
// widget that does). Entries registered without one (tests, hand-made) walk registered parents.
function ancestors(reg: Registry, e: Entry): readonly string[] {
  if (e.chain) return e.chain
  const out: string[] = []
  for (let p = e.parent, n = 0; p && n < 256; p = reg.get(p)?.parent ?? '', n++) out.push(p)
  return out
}

const isUnder = (reg: Registry, e: Entry, ancestor: string): boolean => ancestors(reg, e).includes(ancestor)

// One agent call on one widget: lookup → onAgentAction (target → root) → re-lookup → run →
// afterAgentAction (always, with the outcome, veto included). Missing target, missing control and
// disabled control all answer unknown_action alike — also when that becomes true during an async hook.
// ponytail: no ParamSpec validation here; the executor (W4) checks args → invalid_param before calling.
export async function callControl(target: string, control: string, args: Record<string, unknown> = {}, o: CallOptions): Promise<Json | void> {
  const reg = getRegistry()
  const unknown = () => new WeftError('unknown_action', `unknown control ${control} on ${target}`)
  const find = (e: Entry | undefined) => e && listed(e.spec).find(([n]) => n === control)?.[1]
  const e = reg.get(target)
  if (e?.spec.humanOnly) throw new WeftError('human_only', humanOnlyMessage(e.spec.humanOnly), 'human_only')
  const first = find(e)
  if (!e || !first) throw unknown()

  const frozen = Object.freeze({ ...args })
  const ev: AgentActionEvent = { target, control, args: frozen, via: o.via, cmdId: o.cmdId, ...meta(first.headless), ...(o.agent && { agent: o.agent }) }
  const hooks = chain(reg, e)
  const i = o.step ?? 0
  let outcome: UiStepResult | undefined
  try {
    await before(hooks, ev)
    // The page may have changed while hooks awaited: same mount, control still listed, latest el.
    const c = reg.get(target)?.token === e.token ? find(e) : undefined
    if (!c) throw unknown()
    const ctx: ControlCtx = {
      source: o.source ?? 'agent', via: o.via, cmdId: o.cmdId,
      signal: o.signal ?? new AbortController().signal,
      el: e.el, presence: o.presence ?? NO_PRESENCE,
      // A bound server action goes through the hooks with its own danger/attention before it is submitted —
      // unless it is this control's own bound handle: the hooks already decided on it (one call per click).
      run: async (handle, params = {}) => {
        const own = c.headless && 'params' in c.headless && c.headless.params.id === handle.id && c.headless.params.bind === handle.bind
        if (!own) await before(hooks, { ...ev, args: Object.freeze({ ...params }), ...meta({ params: handle }) })
        if (!o.run) throw new Error('tvine: ctx.run is not wired (no executor)')
        return o.run(handle, params)
      },
      navigate: o.navigate ?? (async (href) => { location.assign(href) }),
      child: (id) => childHandle(reg, e, id, o),
      veto: (reason) => { throw veto(reason) },
    }
    const result = await c.run(frozen, ctx)
    outcome = { i, target, ok: true, ...(result !== undefined && { result }) }
    return result
  } catch (err) {
    const w = err instanceof WeftError ? err : new WeftError('internal', err instanceof Error ? err.message : String(err))
    outcome = { i, target, ok: false, code: w.code, message: w.message, ...(w.reason && { reason: w.reason }), ...(w.field && { field: w.field }) }
    throw err
  } finally {
    for (const h of hooks) try { h.afterAgentAction?.({ ...ev, outcome: outcome! }) } catch { /* after-hooks never change the outcome */ }
  }
}

const meta = (h: Control['headless']): Pick<AgentActionEvent, 'danger' | 'attention'> => {
  const a = h && 'params' in h ? h.params : undefined
  return { ...(a?.danger && { danger: true as const }), ...(a?.attention && { attention: a.attention }) }
}

async function before(hooks: WidgetHooks[], ev: AgentActionEvent): Promise<void> {
  for (const h of hooks) {
    let r: void | false | string
    try { r = await h.onAgentAction?.(ev) } catch { throw veto('internal hook error') }
    if (r === false) throw veto('vetoed by the page')
    if (typeof r === 'string') throw veto(r)
  }
}

// Parent → descendant control. Local segment first (`radio:color`), else a full id; only descendants.
function childHandle(reg: Registry, parent: Entry, id: string, o: CallOptions): WidgetHandle | undefined {
  const c = reg.get(joinId(parent.id, id)) ?? reg.get(id)
  if (!c || !isUnder(reg, c, parent.id)) return undefined
  return {
    id: c.id, kind: c.kind,
    get state() { const x = reg.get(c.id); return (x && agentState(x.spec)) ?? null },
    call: (control, args) => callControl(c.id, control, args as Record<string, unknown>, o),
  }
}
