import type { IncomingMessage } from 'node:http'
import type { z } from 'zod'

// Canonical shared types: docs/design/00-overview.md (+ amendments).
// Type-only module: no runtime code.

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
}

export interface Command {
  action: ActionId
  params: Record<string, unknown>
  sid?: Sid                         // absent → err expired_sid + fresh snapshot
  bind?: string
  cmdId?: string                    // idempotency key
  rev?: Rev                         // optimistic concurrency (stale_rev)
  auth?: string                     // RESERVED v2
}

export type Event =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'ok'; action: ActionId; result?: unknown }
  | { kind: 'err'; code: ErrCode; field?: string; message: string; snapshot?: Snapshot }
  | { kind: 'goto'; url: string }
  | { kind: 'update'; rev: Rev; sid: Sid; source: 'human' | 'agent' }   // v2 live
  | { kind: 'patch'; rev: Rev; changes: unknown }                       // v2 live

export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal'

// channels.md: named pub/sub groups (interface only; implementation comes later).
export interface ChannelLayer {
  group(name: string): {
    add(subscriber: (e: Event) => void): () => void   // returns unsubscribe
    send(e: Event): void
    size(): number
  }
}

// request.md: the per-call request object.
export interface ReadonlyHeaders {
  get(name: string): string | null     // read-only: no set/delete
}

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
    via: 'http' | 'mcp' | 'webmcp' | 'channel' | 'human'
    client?: string                     // UA string or MCP clientInfo.name
    verified?: { directory: string; keyid: string }   // v1.1: Web Bot Auth
  }
  files: UploadedFile[]                 // media uploads (empty unless multipart)
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
  auth?: unknown                     // RESERVED v2 (claims from Command.auth)
  ip: string
}
export type Permission = (ctx: PermissionCtx) => boolean | Promise<boolean>
export type Middleware = (cmd: Command, ctx: ActionCtx,
  next: () => AsyncIterable<Event>) => AsyncIterable<Event>

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  id: ActionId
  schema: S
  run(params: z.infer<S>, ctx: ActionCtx): Promise<unknown>
  rules?: ActionRules
}
export interface ActionRules {
  anonymous?: boolean               // default true in v1
  rate?: { limit: number; windowMs: number }
  permissions?: Permission[]
  mcp?: boolean                     // transport-mcp.md
  priority?: boolean                // transport-mcp.md: kept in trimmed MCP tool list
  readOnly?: boolean                // MCP readOnlyHint
  destructive?: boolean             // MCP destructiveHint
}

// Canonical shape: docs/design/conventions/settings.md (zod schema arrives in Task 2).
export interface Settings {
  site: { name: string; description: string }
  header: string                    // default 'x-tvine' (also Accept: text/tvine)
  formats: { default: 'json' | 'notation'; notationPath: boolean }
  trustProxy: number                // XFF hops to trust
  session: { ttlMs: number; cookieName: string }
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
  data: { defaultPageSize: number; maxPageSize: number }
  db: {
    url: string
    pool: { max: number; acquireMs: number; idleMs: number }
  }
  logging: 'json' | 'pretty' | 'none'
  audit: boolean                    // v1.1
  secret: string | string[]         // HMAC key, min 32 chars enforced at boot; array = rotation
}
