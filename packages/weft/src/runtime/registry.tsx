import 'server-only'
import type { ReactElement } from 'react'
import type { ActionDef, ActionRef, Link, Node } from '../types.js'
import type { ActionHandle } from '../widget/types.js'

// Inline-fragment contract (runtime-registry.md banner): every registration renders its own
// <script type="text/tvine"> next to itself. The server extractor collects all fragments in
// document order and dedups by id (first wins); weft does not dedup.

export type Signer = (payload: Record<string, unknown>) => string

export interface RegisteredAction {
  def: ActionDef
  bindPayload?: Record<string, unknown>
}

// personal: per-session content (never shared). live: changes without a write the server sees (time,
// another system) — never cached, but not per-session. Both mark the snapshot uncacheable.
export interface CacheFlags { personal?: boolean; live?: boolean }
const flags = ({ personal, live }: CacheFlags) => ({ ...(personal && { personal: true }), ...(live && { live: true }) })

export type RegisterInput = Omit<Node, 'actions'> & { actions?: RegisteredAction[] } & CacheFlags

// On globalThis so every copy of this module (Next builds several module graphs) sees the
// signer set once at boot.
const KEY = Symbol.for('tvine.signer')
const store = globalThis as { [KEY]?: Signer }

// Server wiring calls this once at boot with `(p) => signBind(p, settings)`.
export function setSigner(sign: Signer | undefined): void {
  store[KEY] = sign
}

type ZodLike = { isOptional?: () => boolean; _def?: { typeName?: string; innerType?: ZodLike } }
const TYPES: Record<string, string> = { ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodEnum: 'enum' }

// Same output as warp's ActionManifest.paramSpecs, duck-typed so weft does not depend on zod.
// TODO(W1): import from @tvine/warp
export function paramSpecs(schema: unknown): ActionRef['params'] {
  const shape = (schema as { shape?: Record<string, ZodLike> } | null)?.shape
  if (!shape || typeof shape !== 'object') return []
  return Object.entries(shape).map(([name, f]) => {
    let inner = f
    while (inner._def?.innerType) inner = inner._def.innerType
    return { name, type: TYPES[inner._def?.typeName ?? ''] ?? 'json', required: !f.isOptional?.() }
  })
}

export function bindFor(payload?: Record<string, unknown>): string {
  if (!payload) return ''
  const sign = store[KEY]
  if (!sign) throw new Error('tvine: bindPayload given but no signer configured (setSigner)')
  return sign(payload)
}

// A bind is only valid for the action it was issued for: the action id is signed into the
// payload so a bind for A can't be replayed against B (dispatcher checks $action === cmd.action).
export function pairBind(action: string, payload?: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload && { ...payload, $action: action }
}

// What bindAction reads from a warp ActionDef's rules (structural: weft does not import warp).
type HandleRules = {
  bind?: readonly string[]; permissions?: readonly unknown[]; mcp?: boolean
  readOnly?: boolean; destructive?: boolean; humanAttention?: true | string
}
const AGENTS_DENIED = Symbol.for('tvine.denyAgents')   // warp security/permissions.ts static tag

// widget-contract.md §ActionHandle: the signed-bind seam, server only (needs the signer). Plain JSON, so
// it crosses the RSC boundary as a prop. Bind-only params are never advertised. `agent:false` for
// denyAgents / mcp:false actions is a static UX tag — dispatch still enforces the permission.
export function bindAction(def: ActionDef, bind?: Record<string, unknown>): ActionHandle {
  const r = (def.rules ?? {}) as HandleRules
  const denied = r.mcp === false || !!r.permissions?.some((p) => !!(p as { [AGENTS_DENIED]?: true })?.[AGENTS_DENIED])
  return {
    id: def.id,
    params: paramSpecs(def.schema).filter((p) => !r.bind?.includes(p.name)),
    bind: bindFor(pairBind(def.id, bind)),
    agent: !denied,
    ...(r.readOnly && { ro: true as const }),
    ...(r.destructive && { danger: true as const }),
    ...(r.humanAttention && { attention: r.humanAttention }),
  }
}

// `<` → < so no data string can close the tag.
function fragment(body: Record<string, unknown>): ReactElement {
  const json = JSON.stringify({ v: 1, ...body }).replace(/</g, '\\u003c')
  return <script type="text/tvine" dangerouslySetInnerHTML={{ __html: json }} />
}

// Returns the fragment element; the caller renders it.
export function register({ id, type, data, actions = [], ...f }: RegisterInput): ReactElement {
  const node: Node = {
    id, type, data,
    // rules.bind keys come only from the signed bind: not advertised (as warp's paramSpecs and MCP)
    actions: actions.map((a) => ({ id: a.def.id, params: paramSpecs(a.def.schema).filter((p) => !a.def.rules?.bind?.includes(p.name)), bind: bindFor(pairBind(a.def.id, a.bindPayload)) })),
  }
  return fragment({ k: 'node', node, ...flags(f) })
}

export function registerLink(link: Link, opts: CacheFlags = {}): ReactElement {
  return fragment({ k: 'link', link, ...flags(opts) })
}

export function pageFragment({ page, title, ...f }: { page: string; title: string } & CacheFlags): ReactElement {
  return fragment({ k: 'page', page, title, ...flags(f) })
}
