import type { ReactElement } from 'react'
import { register } from './runtime/registry.js'
import type { AgentSpec } from './types.js'

// Default id = `${type}:${data.id ?? data.key}` (string|number); otherwise an explicit id is
// required. No useId: in RSC it is a render-order counter, unstable across renders.
export function idFor(type: string, spec: Pick<AgentSpec, 'id' | 'data'>): string {
  if (spec.id) return spec.id
  const k = spec.data.id ?? spec.data.key
  if (typeof k === 'string' || typeof k === 'number') return `${type}:${k}`
  throw new Error(`tvine: ${type} node needs an explicit id (or data.id / data.key as string|number)`)
}

// Server-component form (no hooks). Returns the fragment element to render.
export function registerAgent(type: string, spec: AgentSpec): ReactElement {
  return register({
    id: idFor(type, spec),
    type,
    data: spec.data,
    personal: spec.personal,
    live: spec.live,
    actions: spec.actions?.map((a) => ({ def: a.def, bindPayload: a.bind })),
  })
}

// Server (react-server) build. Client build lives in useAgent.client.ts.
// Same as registerAgent today; kept as a hook so shared components read naturally.
export function useAgent(type: string, spec: AgentSpec): ReactElement {
  return registerAgent(type, spec)
}
