import { useId, type ReactElement } from 'react'
import { register } from './runtime/registry.js'
import type { AgentSpec } from './types.js'

// Server-component form (no hooks). id is required: without useId there is no stable default.
// Returns the fragment element to render.
export function registerAgent(type: string, spec: AgentSpec & { id: string }): ReactElement {
  return register({
    id: spec.id,
    type,
    data: spec.data,
    personal: spec.personal,
    actions: spec.actions?.map((a) => ({ def: a.def, bindPayload: a.bind })),
  })
}

// Server (react-server) build. Client build lives in useAgent.client.ts.
// Default id is `${type}:${useId()}` (no route is known at render; pass id for stable ids).
export function useAgent(type: string, spec: AgentSpec): ReactElement {
  const auto = useId()
  return registerAgent(type, { ...spec, id: spec.id ?? `${type}:${auto}` })
}
