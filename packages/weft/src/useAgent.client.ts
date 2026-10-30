import type { AgentSpec } from './types.js'

let warned = false

// v1: agent-visible nodes must server-render. In a client bundle the hook does nothing.
export function useAgent(_type: string, _spec: AgentSpec): void {
  if (warned || process.env.NODE_ENV === 'production') return
  warned = true
  console.warn('tvine: useAgent() ran in a client-only render and was ignored; agent-visible nodes must render on the server (v1).')
}
