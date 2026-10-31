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

// one bad field of an err (Django ValidationError: field → messages). code: the validator ('invalid_type', 'too_small', 'unknown', …)
export interface FieldError { field: string; code?: string; message: string }

export type Event =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'ok'; action: ActionId; result?: unknown }
  | { kind: 'err'; code: ErrCode; field?: string; message: string; snapshot?: Snapshot
      errors?: FieldError[]         // every bad field (Django ValidationError dict); `field` = the first, kept for compatibility
      reason?: string               // the DomainError code behind err domain/invalid_param/internal ('forbidden', 'not_found', …)
      retryAfterMs?: number }       // rate_limited
  | { kind: 'goto'; url: string }
  | { kind: 'update'; rev: Rev; sid: Sid; source: 'human' | 'agent' | 'job'   // v2 live; 'job': tvine.tasks progress
      action?: ActionId                                                // an agent's server action (presence outlines its widget)
      job?: JobUpdate }                                                // tvine.tasks: a background job of this session moved
  | { kind: 'patch'; rev: Rev; changes: unknown }                       // v2 live

// tvine.tasks progress / completion carried on an `update` event (docs/design/contrib/tasks.md §Results)
export interface JobUpdate { id: string; task: string; status: string; progress?: number; message?: string }

export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal' | 'human_only'

// channels.md: named pub/sub groups. Implementations: core/channels.ts (memory), backends/redis.ts (redis:
// fan-out across servers, replay from a stream). seq = the event's cursor (SSE `id:`); one counter for the layer.
export interface ChannelLayer {
  group(name: string): {
    add(subscriber: (e: Event, seq: number) => void): () => void   // returns unsubscribe
    send(e: Event): void                                          // fire and forget; delivery may be async
    size(): number                                                // live subscribers in this process
    since(cursor: number): Replayed[] | Promise<Replayed[]>       // ring events after a cursor (Last-Event-ID)
  }
  head(): number                                      // cursor of the latest event this process has seen
  drop(name: string): void                            // remove a group's ring and subscribers
}
export interface Replayed { seq: number; e: Event }

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
  // Filled by tvine.auth (docs/design/contrib/auth.md §4); a BYO resolver may set them too.
  isActive?: boolean
  isStaff?: boolean
  isSuperuser?: boolean
  scopes?: readonly string[]            // token-authenticated: what the token may run ('*', 'read', 'app.*', 'app.x')
  hasPerm?(perm: string, obj?: unknown): Promise<boolean>
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
  raw?: IncomingMessage                 // escape hatch: http + api (browser) transports
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
  readOnly?: boolean                 // the action is rules.readOnly (token scope 'read')
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
  multipart?: { maxBytes: number }  // POST /tvine/api/<id> may be multipart: a `params` JSON part + file parts (all files ≤ maxBytes)
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
  secretResult?: boolean            // the result is a one-time secret (a new API token, TOTP secret): blanked in hook payloads
  humanOnly?: true | string         // widgets/human-only.md: dispatch refuses every agent-marked request (human_only); no typed MCP tool
  humanAttention?: true | string    // RESERVED placeholder (BACKLOG #2): carried to ActionHandle.attention + hook events; no behaviour
}

// Canonical shape: docs/design/conventions/settings.md (zod schema arrives in Task 2).
// server/security-headers.md
export interface SecurityHeaders {
  enabled: boolean
  hsts: false | { maxAge: number; includeSubDomains: boolean; preload: boolean }   // https only
  csp: false | {
    reportOnly: boolean
    directives: Record<string, string[] | false>   // over the built-in defaults; false drops one
    reportUri: string | false                      // '/tvine/csp-report' = ours (mounted); another URL = external
    staticPages: 'relaxed' | 'strict'              // prerendered (nonce-less) HTML: 'self' 'unsafe-inline' scripts, or keep the nonce policy
  }
  referrerPolicy: string
  coop: false | 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none'
  corp: false | 'same-origin' | 'same-site' | 'cross-origin'
  permissionsPolicy: Record<string, string[] | false>   // feature → allowlist ([] = nobody, ['self'], origins)
}
export type CorsOrigin = string | RegExp   // exact origin, '*' (never with credentials), or an anchored RegExp
export interface CorsPolicy {
  origins: CorsOrigin[]
  methods: string[]
  allowHeaders: string[]
  exposeHeaders: string[]
  credentials: boolean
  maxAge: number
}
export interface CorsSettings extends CorsPolicy { routes: ({ path: string } & Partial<CorsPolicy>)[] }
export interface CompressionSettings { enabled: boolean; threshold: number; brotli: boolean; gzipLevel: number; brotliQuality: number }

export interface Settings {
  site: { name: string; description: string }
  header: string                    // default 'x-tvine' (also Accept: text/tvine)
  formats: { default: 'json' | 'notation'; notationPath: boolean }
  trustProxy: number                // XFF hops to trust
  // Named connections (docs/design/conventions/backends.md). `default` falls back to REDIS_URL. Every subsystem
  // whose backend is 'redis' names one of these (its `redis` key, default 'default').
  redis: Record<string, RedisConnection>
  session: { ttlMs: number; cookieName: string; max: number   // max: live sessions kept; past it the least recently used is evicted
    backend: Backend; redis: string }
  channels: { backend: Backend; redis: string }                 // pub/sub fan-out + Last-Event-ID replay
  limits: {
    bodyBytes: number
    handlerMs: number
    rate: { limit: number; windowMs: number }
    sseConnPerIp: number
    backend: Backend; redis: string                               // rate limits, idempotency, login throttle, tab agent marks
  }
  socket: boolean
  mcp: { tools: 'both' | 'generic' | 'typed'; exclude: string[]; maxTools: number }
  middleware: Middleware[]
  guards: { path: string; permissions: Permission[] }[]
  media: { dir: string; route: string }
  snapshotCache: { ttlMs: number; backend: Backend; redis: string }   // shared snapshots of non-personal, non-live pages; 0 = off. Any committed write also clears it
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
  security: { headers: SecurityHeaders }
  cors: CorsSettings                // default closed: no routes
  compression: CompressionSettings
  // tvine.tasks (docs/design/contrib/tasks.md §Settings): lease / visibility timeout, claim poll, progress relay poll,
  // SIGTERM grace, how long final job rows are kept
  // broker: the job store (tvine.tasks picks the default: 'file'); redis: the settings.redis alias a 'redis' broker
  // uses; file / durable: the file broker's tasks.db path and power-cut durability; claimBatch: jobs per claim
  tasks: { leaseMs: number; pollMs: number; relayMs: number; graceMs: number; resultTtlMs: number
    broker?: 'db' | 'file' | 'memory' | 'redis'; redis: string; file: string; durable: boolean; claimBatch: number }
  // tvine.admin (docs/design/contrib/admin.md §1): where the panel mounts, its title, its theme
  admin: { path: string; title?: string; theme: { brand?: string; radius?: string; dark: 'auto' | 'on' | 'off' } }
  installedApps: string[]           // Django INSTALLED_APPS for built-in apps: 'tvine.auth', … (core/apps.ts)
  secret: string | string[]         // HMAC key, min 32 chars enforced at boot; array = rotation
  auth?: AuthSettings
}

export type Backend = 'memory' | 'redis'
// settings.redis.<alias>. url: redis:// or rediss:// (TLS); prefix: every key this connection writes starts with it.
export interface RedisConnection { url: string; tls?: boolean; prefix?: string; connectTimeoutMs?: number }

// settings.auth: `user` is the BYO resolver (overrides everything); the rest configures tvine.auth
// (docs/design/contrib/auth.md). Typed loosely here: core does not depend on contrib.
export interface AuthSettings {
  user?: (req: Request) => Promise<TvineUser | null>   // null/absent → tvine.auth (if installed) or ANONYMOUS
  hashers?: PasswordHasher[]           // first = preferred; others verify (and get upgraded on login)
  validators?: PasswordValidator[]
  login?: { maxFailures?: number; accountMaxFailures?: number; ipMaxFailures?: number; windowMs?: number; lockoutMs?: number }
  resetTimeoutMs?: number
  sendPasswordReset?: (e: { user: { id: string; username: string; email: string }; email: string; uid: string; token: string; request: Request }) => unknown
  objectPermission?: (user: TvineUser, perm: string, obj: unknown) => boolean | Promise<boolean>
  tokens?: { defaultDays?: number; maxDays?: number }
  totp?: { issuer?: string }
}
export interface PasswordHasher {
  algorithm: string
  encode(password: string): Promise<string>
  verify(password: string, encoded: string): Promise<boolean>
  mustUpdate(encoded: string): boolean   // weaker parameters than this hasher's: rehash on next login
}
// Returns the problems (empty = ok). user: the attributes similarity checks look at.
export type PasswordValidator = (password: string, user?: Record<string, unknown>) => string[]
