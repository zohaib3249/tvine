import 'server-only'
import { cache, type ReactNode } from 'react'
import type { ActionDef, ActionRef, Link, Node } from '../types.js'

export type Signer = (payload: Record<string, unknown>) => string

export interface RegisteredAction {
  def: ActionDef
  bindPayload?: Record<string, unknown>
}

export type RegisterInput = Omit<Node, 'actions'> & { actions?: RegisteredAction[]; personal?: boolean }

// Per-request collector: Map keeps insertion order and dedups by id.
export class Collector {
  page = ''
  title = ''
  personal = false
  rooted = false
  nodes = new Map<string, Node>()
  links = new Map<string, Link>()
}

const defaultScope = cache(() => new Collector())
let scope: () => Collector = defaultScope
let signer: Signer | undefined

// Server wiring calls this once at boot with `(p) => signBind(p, settings)`.
// `scope` defaults to React.cache (one Collector per RSC request); tests outside RSC
// pass their own because React.cache does not memoize in the plain react build.
export function configureRegistry(opts: { sign?: Signer; scope?: () => Collector }): void {
  if ('sign' in opts) signer = opts.sign
  if ('scope' in opts) scope = opts.scope ?? defaultScope
}

type ZodLike = { isOptional?: () => boolean; _def?: { typeName?: string; innerType?: ZodLike } }
const TYPES: Record<string, string> = { ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodEnum: 'enum' }

// Same output as warp's ActionManifest.paramSpecs (not exported publicly), duck-typed so
// weft does not depend on zod. ponytail: replace with warp's export when it exists.
function paramSpecs(schema: unknown): ActionRef['params'] {
  const shape = (schema as { shape?: Record<string, ZodLike> } | null)?.shape
  if (!shape || typeof shape !== 'object') return []
  return Object.entries(shape).map(([name, f]) => {
    let inner = f
    while (inner._def?.innerType) inner = inner._def.innerType
    return { name, type: TYPES[inner._def?.typeName ?? ''] ?? 'json', required: !f.isOptional?.() }
  })
}

function bindFor(payload?: Record<string, unknown>): string {
  if (!payload) return ''
  if (!signer) throw new Error('tvine: bindPayload given but no signer configured (configureRegistry({ sign }))')
  return signer(payload)
}

export function register({ actions = [], personal, ...node }: RegisterInput): void {
  const c = scope()
  if (personal) c.personal = true
  if (c.nodes.has(node.id)) return
  c.nodes.set(node.id, {
    ...node,
    actions: actions.map((a) => ({ id: a.def.id, params: paramSpecs(a.def.schema), bind: bindFor(a.bindPayload) })),
  })
}

export function registerLink(link: Link): void {
  const c = scope()
  if (!c.links.has(link.id)) c.links.set(link.id, link)
}

export function currentPage(): string {
  return scope().page
}

export function TvineProvider({ children, page = '', title = '' }: { children: ReactNode; page?: string; title?: string }) {
  const c = scope()
  if (c.rooted) return <>{children}</>
  c.rooted = true
  c.page = page
  c.title = title
  return <>{children}<TvineEmbed /></>
}

// Rendered last by the root TvineProvider. `<` → < so no data string can close the tag.
export function TvineEmbed() {
  const c = scope()
  const json = JSON.stringify({
    v: 1, page: c.page, title: c.title, personal: c.personal,
    nodes: [...c.nodes.values()], links: [...c.links.values()],
  }).replace(/</g, '\\u003c')
  return <script type="text/tvine" dangerouslySetInnerHTML={{ __html: json }} />
}
