// Client-safe entry (default condition). Must never import runtime/registry or server-only.
export { useAgent } from './useAgent.client.js'
export type { ActionDef, ActionRef, AgentSpec, Link, Node } from './types.js'
