// Client-safe entry (default condition). Must never import runtime/registry or server-only.
export { useAgent } from './useAgent.client.js'
export type { ActionDef, ActionRef, AgentSpec, Link, Node } from './types.js'
export { useTvineChannel } from './runtime/socket.js'
export { AgentBadge } from './runtime/AgentBadge.js'
export type { TvineEvent } from './types.js'
export { registerWebMcp } from './runtime/webmcp.js'
