import 'server-only'
import type { ReactElement } from 'react'
import type { ActionDef, ActionRef, Link, Node } from '../types.js'

// Inline-fragment contract (runtime-registry.md banner): every registration renders its own
// <script type="text/tvine"> next to itself. The server extractor collects all fragments in
// document order and dedups by id (first wins); weft does not dedup.

export type Signer = (payload: Record<string, unknown>) => string

export interface RegisteredAction {
  def: ActionDef
  bindPayload?: Record<string, unknown>
}

export type RegisterInput = Omit<Node, 'actions'> & { actions?: RegisteredAction[]; personal?: boolean }

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

// `<` → < so no data string can close the tag.
function fragment(body: Record<string, unknown>): ReactElement {
  const json = JSON.stringify({ v: 1, ...body }).replace(/</g, '\\u003c')
  return <script type="text/tvine" dangerouslySetInnerHTML={{ __html: json }} />
}

// Returns the fragment element; the caller renders it.
export function register({ id, type, data, actions = [], personal }: RegisterInput): ReactElement {
  const node: Node = {
    id, type, data,
    actions: actions.map((a) => ({ id: a.def.id, params: paramSpecs(a.def.schema), bind: bindFor(a.bindPayload) })),
  }
  return fragment({ k: 'node', node, ...(personal && { personal: true }) })
}

// personal: per-session content (e.g. "Cart (2)") — marks the snapshot uncacheable.
export function registerLink(link: Link, opts: { personal?: boolean } = {}): ReactElement {
  return fragment({ k: 'link', link, ...(opts.personal && { personal: true }) })
}

// For the future <Page> primitive.
export function pageFragment({ page, title, personal }: { page: string; title: string; personal?: boolean }): ReactElement {
  return fragment({ k: 'page', page, title, ...(personal && { personal: true }) })
}
