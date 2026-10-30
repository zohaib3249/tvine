import { getRegistry, type Entry, type Registry } from '../runtime/registry.client.js'
import { joinId } from './ids.js'
import type { AgentActionEvent, Control, ControlCtx, ErrCode, Json, Override, Presence, UiStepResult, WidgetHooks, WidgetHandle } from './types.js'
import { listed } from './vocabulary.js'

// custom-logic.md: overrides, hook bubbling, veto. The framework never refuses an action on its
// own (owner ruling Q5): `danger`/`attention` are passed to hooks as metadata, the app decides.

export class WeftError extends Error {
  constructor(readonly code: ErrCode, message: string, readonly reason?: string, readonly field?: string) { super(message) }
}
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
      out[k] = { ...b, run: (args, ctx) => o(args, ctx, async (a = args) => b.run(a, ctx)) }
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

// Target first, then each registered ancestor, then <WeftRoot hooks>.
function chain(reg: Registry, e: Entry): WidgetHooks[] {
  const out: WidgetHooks[] = []
  for (let cur: Entry | undefined = e, n = 0; cur && n < 256; cur = reg.get(cur.parent), n++) if (cur.spec.hooks) out.push(cur.spec.hooks)
  if (reg.rootHooks) out.push(reg.rootHooks)
  return out
}

function isUnder(reg: Registry, e: Entry, ancestor: string): boolean {
  for (let p = e.parent, n = 0; p && n < 256; p = reg.get(p)?.parent ?? '', n++) if (p === ancestor) return true
  return false
}

// One agent call on one widget: lookup → onAgentAction (target → root) → run → afterAgentAction.
// Missing target, missing control and disabled control all answer unknown_action alike.
// ponytail: no ParamSpec validation here; the executor (W4) checks args → invalid_param before calling.
export async function callControl(target: string, control: string, args: Record<string, unknown> = {}, o: CallOptions): Promise<Json | void> {
  const reg = getRegistry()
  const e = reg.get(target)
  const c = e && listed(e.spec).find(([n]) => n === control)?.[1]
  if (!e || !c) throw new WeftError('unknown_action', `unknown control ${control} on ${target}`)

  const bound = c.headless && 'params' in c.headless ? c.headless.params : undefined
  const ev: AgentActionEvent = {
    target, control, args: Object.freeze({ ...args }), via: o.via, cmdId: o.cmdId,
    ...(bound?.danger && { danger: true as const }), ...(bound?.attention && { attention: bound.attention }), ...(o.agent && { agent: o.agent }),
  }
  const hooks = chain(reg, e)
  for (const h of hooks) {
    let r: void | false | string
    try { r = await h.onAgentAction?.(ev) } catch { throw veto('internal hook error') }
    if (r === false) throw veto('vetoed by the page')
    if (typeof r === 'string') throw veto(r)
  }

  const ctx: ControlCtx = {
    source: o.source ?? 'agent', via: o.via, cmdId: o.cmdId,
    signal: o.signal ?? new AbortController().signal,
    el: e.el, presence: o.presence ?? NO_PRESENCE,
    run: o.run ?? (() => Promise.reject(new Error('tvine: ctx.run is not wired (no executor)'))),
    navigate: o.navigate ?? (async (href) => { location.assign(href) }),
    child: (id) => childHandle(reg, e, id, o),
    veto: (reason) => { throw veto(reason) },
  }
  const i = o.step ?? 0
  let outcome: UiStepResult | undefined
  try {
    const result = await c.run(args, ctx)
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

// Parent → descendant control. Local segment first (`radio:color`), else a full id; only descendants.
function childHandle(reg: Registry, parent: Entry, id: string, o: CallOptions): WidgetHandle | undefined {
  const c = reg.get(joinId(parent.id, id)) ?? reg.get(id)
  if (!c || !isUnder(reg, c, parent.id)) return undefined
  return {
    id: c.id, kind: c.kind,
    get state() { return reg.get(c.id)?.spec.state ?? null },
    call: (control, args) => callControl(c.id, control, args as Record<string, unknown>, o),
  }
}
