import type { IncomingMessage } from 'node:http'
import type { z } from 'zod'
import type { WidgetFrag } from '../shape/disclose.js'

export type { Paginated } from '../data/queryset.js'   // Weft consumes it from here

// Canonical shared types: docs/design/00-overview.md (+ amendments).
// Types plus one runtime constant (ANONYMOUS).

export type Sid = string            // 21-char nanoid
export type Rev = number            // monotonic per-session
export type NodeId = string         // `${route}:${type}:${key}` or explicit
export type ActionId = string       // `${app}.${name}`, e.g. "cart.addToCart"

export interface Node {
  id: NodeId
  type: string                      // 'product' | 'input' | 'link' | custom
  data: Record<string, unknown>     // incl. {value, currency} money, image URLs
  actions: ActionRef[]
}
export interface ActionRef {
  id: ActionId
  params: { name: string; type: string; required: boolean }[]  // derived from zod
  bind: string                      // HMAC-signed opaque context (security/sign)
}
export interface Link { id: NodeId; href: string; label: string; params?: string[] }

export interface Snapshot {
  page: string; title: string
  sid: Sid; rev: Rev
  nodes: Node[]; links: Link[]
  widgets?: WidgetFrag[]            // v2 `k:"w"` fragments (snapshot-format.md); absent on v1-only pages
  folds?: Record<string, string>    // link id → entity node it directly followed (v2 `href` folding)
}

export interface Command {
  action: ActionId
  params: Record<string, unknown>
  sid?: Sid                         // absent → err expired_sid + fresh snapshot
  bind?: string
  cmdId?: string                    // idempotency key
  rev?: Rev                         // optimistic concurrency (stale_rev)
  auth?: string                     // RESERVED v2
  // control-protocol.md: a client marks a request it sends FOR an agent. Downgrade-only: it can make a
  // request agent (is=true), never human. via: 'webmcp' (in-browser agent) | 'channel' (remote agent via a tab)
  agentCmd?: { cmdId?: string; via?: string }
}

export type Event =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'ok'; action: ActionId; result?: unknown }
  | { kind: 'err'; code: ErrCode; field?: string; message: string; snapshot?: Snapshot
      reason?: string               // the DomainError code behind err domain/invalid_param/internal ('forbidden', 'not_found', …)
      retryAfterMs?: number }       // rate_limited
  | { kind: 'goto'; url: string }
  | { kind: 'update'; rev: Rev; sid: Sid; source: 'human' | 'agent'; action?: ActionId }   // v2 live; action: an agent's server action (presence outlines its widget)
  | { kind: 'patch'; rev: Rev; changes: unknown }                       // v2 live

export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal'

// channels.md: named pub/sub groups. Implementation: core/channels.ts (MemoryChannelLayer).
export interface ChannelLayer {
  group(name: string): {
    add(subscriber: (e: Event) => void): () => void   // returns unsubscribe
    send(e: Event): void
    size(): number                                    // live subscribers
    since(cursor: number): Event[]                    // ring events after a cursor (Last-Event-ID)
  }
  head(): number                                      // cursor of the latest event on any group
  drop(name: string): void                            // remove a group's ring and subscribers
}

// request.md: the per-call request object.
export interface ReadonlyHeaders {
  get(name: string): string | null     // read-only: no set/delete
}

// request.md: request.user (Django request.user). Always present on Request.
export interface TvineUser {
  isAuthenticated: boolean
  id?: string
  name?: string
  claims?: Record<string, unknown>      // whatever the dev's resolver returns
}
export const ANONYMOUS: TvineUser = Object.freeze({ isAuthenticated: false })

export interface UploadedFile { field: string; key: string; url: string; type: string; size: number }

export interface Request {
  method: 'GET' | 'POST'
  path: string                          // '/product/42'
  route: string                         // '/product/[id]' (Next pattern)
  params: Record<string, string>        // route params: { id: '42' }
  query: URLSearchParams
  headers: ReadonlyHeaders
  ip: string                            // derived via settings.trustProxy; never raw XFF
  id: string                            // request id (x-request-id / traceparent trace-id)
  agent: {
    is: boolean
    via: 'http' | 'mcp' | 'webmcp' | 'channel' | 'inspector' | 'human'   // inspector: dev gallery try-it (dev only)
    client?: string                     // UA string or MCP clientInfo.name
    verified?: { directory: string; keyid: string }   // v1.1: Web Bot Auth
  }
  files: UploadedFile[]                 // media uploads (empty unless multipart)
  user: TvineUser                      // ALWAYS present; anonymous = ANONYMOUS
  raw?: IncomingMessage                 // escape hatch, http transport only
}

export interface Session {
  sid: Sid; rev: Rev
  data: Map<string, unknown>        // app state: cart, etc.
  createdAt: number; lastSeen: number
  controller?: string               // RESERVED v2 claim mode
}

export interface ActionCtx {
  request: Request
  session: Session
  sid: Sid
  settings: Settings
  channels: ChannelLayer
}

// Permission / Middleware: conventions/permissions.md, conventions/middleware-hooks.md.
// Declared here (not imported) because core/ may not depend on security/ or middleware modules.
// security/permissions will re-export both.
export interface PermissionCtx {
  sid: Sid; session: Session
  action?: ActionId                  // absent on route guards
  route: string
  user: TvineUser                   // from request.user (always present)
  agent?: Request['agent']           // request.agent; denyAgents reads agent.is
  auth?: unknown                     // RESERVED v2 (claims from Command.auth)
  ip: string
}
export type Permission = (ctx: PermissionCtx) => boolean | Promise<boolean>
export type Middleware = (cmd: Command, ctx: ActionCtx,
  next: () => AsyncIterable<Event>) => AsyncIterable<Event>

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  id: ActionId
  name?: string                     // defineAction's name, before discovery qualifies the id
  defaultRules?: Pick<ActionRules, 'rate'>   // the def's own defaults: above settings, BELOW apps/<app>/rules.ts (e.g. uploads 5/min)
  schema: S
  run(params: z.infer<S>, ctx: ActionCtx): Promise<unknown>
  rules?: ActionRules
  rawParams?: boolean               // run() validates its own params (class views); dispatch passes them unparsed
}
export interface ActionRules {
  anonymous?: boolean               // default true in v1
  rate?: { limit: number; windowMs: number }
  permissions?: Permission[]
  mcp?: boolean                     // transport-mcp.md
  priority?: boolean                // transport-mcp.md: kept in trimmed MCP tool list
  readOnly?: boolean                // MCP readOnlyHint
  destructive?: boolean             // MCP destructiveHint
  atomic?: boolean                  // false = opt out of the per-request transaction (core-dispatch.md)
  bind?: string[]                   // params that may ONLY come from the signed bind (bind then required)
  humanAttention?: true | string    // RESERVED placeholder (BACKLOG #2): carried to ActionHandle.attention + hook events; no behaviour
}

// Canonical shape: docs/design/conventions/settings.md (zod schema arrives in Task 2).
export interface Settings {
  site: { name: string; description: string }
  header: string                    // default 'x-tvine' (also Accept: text/tvine)
  formats: { default: 'json' | 'notation'; notationPath: boolean }
  trustProxy: number                // XFF hops to trust
  session: { ttlMs: number; cookieName: string; max: number }   // max: live sessions kept; past it the least recently used is evicted
  limits: {
    bodyBytes: number
    handlerMs: number
    rate: { limit: number; windowMs: number }
    sseConnPerIp: number
  }
  socket: boolean
  mcp: { tools: 'both' | 'generic' | 'typed'; exclude: string[]; maxTools: number }
  middleware: Middleware[]
  guards: { path: string; permissions: Permission[] }[]
  media: { dir: string; route: string }
  snapshotCache: { ttlMs: number }      // shared snapshots of non-personal, non-live pages; 0 = off. Any committed write also clears it
  data: { defaultPageSize: number; maxPageSize: number }
  db: {
    url: string
    pool: { max: number; acquireMs: number; idleMs: number }
    atomicRequests: boolean         // Django ATOMIC_REQUESTS: each non-readOnly action = one transaction
  }
  logging: 'json' | 'pretty' | 'none'
  // snapshot shape (progressive-disclosure.md): v2 default; 'v1' = the pre-v2 bytes, kept for one release
  // inTab (security.md): 'on' = agents may control a human's tab (WebMCP in-tab, remote after one Allow); 'off' = never
  agent: { shape: 'v1' | 'v2'; budget: number /* tokens */; rowsL1: number; inTab: 'on' | 'off' }
  frontend: { boundary: 'error' | 'warn' }   // W2b reads it: FE/DB boundary violations fail (error) or warn
  audit: boolean                    // v1.1
  secret: string | string[]         // HMAC key, min 32 chars enforced at boot; array = rotation
  auth?: { user?: (req: Request) => Promise<TvineUser | null> }   // settings.md; null/absent → ANONYMOUS
}
