// Structural mirrors of @tvine/warp core/types (Node, ActionRef, Link, ActionDef).
// TODO(W1): import from @tvine/warp (its public entry does not export these yet).

export interface ActionRef {
  id: string
  params: { name: string; type: string; required: boolean }[]
  bind: string
}
export interface Node {
  id: string
  type: string
  data: Record<string, unknown>
  actions: ActionRef[]
}
export interface Link { id: string; href: string; label: string; params?: string[] }

// Only what the registry reads; any real warp ActionDef is assignable.
export interface ActionDef { id: string; schema: unknown }

export interface AgentSpec {
  id?: string
  data: Record<string, unknown>
  actions?: { def: ActionDef; bind?: Record<string, unknown> }[]
  personal?: boolean
}
