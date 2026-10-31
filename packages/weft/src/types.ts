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
export interface ActionDef { id: string; schema: unknown; rules?: { bind?: readonly string[] } }

export interface AgentSpec {
  id?: string
  data: Record<string, unknown>
  actions?: { def: ActionDef; bind?: Record<string, unknown> }[]
  personal?: boolean
  live?: boolean
}

// Channel frame payload (warp serialize/json.ts, one flat object per SSE `data:`).
// TODO(W1): derive from @tvine/warp's Event/envelope types.
export interface TvineEvent {
  status: string
  source?: 'human' | 'agent' | 'job'
  code?: string
  message?: string
  [k: string]: unknown
}

// TODO(W1): from @tvine/warp core/types.
export interface Paginated<T> { items: T[]; total?: number; pageSize: number; nextCursor?: string }
export interface Command {
  action: string
  params: Record<string, unknown>
  sid?: string
  bind?: string
  cmdId?: string
  rev?: number
}
