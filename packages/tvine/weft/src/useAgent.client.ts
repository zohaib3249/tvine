import type { ReactElement } from 'react'
import { submitControl } from './runtime/primitives.client.js'
import { useWidget } from './widget/useWidget.js'
import type { ActionHandle, Control } from './widget/types.js'
import type { AgentSpec } from './types.js'

// Client actions must be ActionHandles from bindAction() in a server component: the client never signs.
export interface ClientAgentSpec extends Omit<AgentSpec, 'actions'> {
  label?: string
  actions?: (ActionHandle | NonNullable<AgentSpec['actions']>[number])[]
}

const isHandle = (a: object): a is ActionHandle => typeof (a as ActionHandle).bind === 'string' && 'agent' in a
let warned = false

// compatibility-v1.md: v1 no-op → alias over useWidget. `<type>:<data.id|key>` is a global entity
// (kind 'data', entity = full id); an explicit `id` is a plain scoped data widget. Each action becomes
// a submit control (one action → `submit`, several → named by action id). Returns the v2 fragment.
export function useAgent(type: string, spec: ClientAgentSpec): ReactElement | null {
  const handles = (spec.actions ?? []).filter((a): a is ActionHandle => {
    if (isHandle(a)) return true
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true
      console.warn(`tvine: useAgent("${type}") in a client component got a raw ActionDef; pass bindAction(def, bind) from a server component (clients cannot sign binds). Ignored.`)
    }
    return false
  })
  const controls: Record<string, Control> = Object.fromEntries(handles.map((h) => [handles.length === 1 ? 'submit' : h.id, submitControl(h)]))
  const k = spec.data.id ?? spec.data.key
  const entity = !spec.id && (typeof k === 'string' || typeof k === 'number') ? `${type}:${k}` : undefined
  const w = useWidget({
    kind: 'data', ...(entity ? { entity } : { id: spec.id }),
    label: spec.label ?? String(spec.data.name ?? spec.data.title ?? type),
    data: spec.data, controls, personal: spec.personal,
  })
  return w.embed
}
