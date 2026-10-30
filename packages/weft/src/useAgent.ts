import { useId } from 'react'
import { currentPage, register } from './runtime/registry.js'
import type { AgentSpec } from './types.js'

// Server-component form (no hooks). id is required: without useId there is no stable default.
export function registerAgent(type: string, spec: AgentSpec & { id: string }): void {
  register({
    id: spec.id,
    type,
    data: spec.data,
    personal: spec.personal,
    actions: spec.actions?.map((a) => ({ def: a.def, bindPayload: a.bind })),
  })
}

// Server (react-server) build. Client build lives in useAgent.client.ts.
export function useAgent(type: string, spec: AgentSpec): void {
  const auto = useId()
  registerAgent(type, { ...spec, id: spec.id ?? `${currentPage()}:${type}:${auto}` })
}
