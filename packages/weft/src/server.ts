// react-server entry: registry + server useAgent.
export { pageFragment, register, registerLink, setSigner,
  type RegisteredAction, type RegisterInput, type Signer } from './runtime/registry.js'
export { registerAgent, useAgent } from './useAgent.js'
export type { ActionDef, ActionRef, AgentSpec, Link, Node } from './types.js'
