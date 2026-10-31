import type { LoggingSetting } from '../log.js'
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
      retryAfterMs?: number         // rate_limited
      confirm?: ConfirmAsk }        // confirm_required
  | { kind: 'goto'; url: string }
  | { kind: 'update'; rev: Rev; sid: Sid; source: 'human' | 'agent' | 'job'   // v2 live; 'job': tvine.tasks progress
      action?: ActionId                                                // an agent's server action (presence outlines its widget)
      job?: JobUpdate }                                                // tvine.tasks: a background job of this session moved
  | { kind: 'patch'; rev: Rev; changes: unknown }                       // v2 live

// rules.confirm's first answer (core/confirm.ts). token: absent when the caller cannot confirm (an agent, by 'human')
export interface ConfirmAsk { token?: string; message: string; summary: Record<string, unknown>; expiresIn: number /* s */; by: 'anyone' | 'human' }

// tvine.tasks progress / completion carried on an `update` event (docs/design/contrib/tasks.md §Results)
export interface JobUpdate { id: string; task: string; status: string; progress?: number; message?: string }

export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal' | 'human_only'
  | 'confirm_required'   // rules.confirm: nothing ran; resend with the token (core/confirm.ts)

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
  isAnonymous?: boolean
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
export const ANONYMOUS: TvineUser = Object.freeze({ isAuthenticated: false, isAnonymous: true })

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
  locale?: string                       // the Locale middleware's pick from Accept-Language
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
  multipart?: { maxBytes: number; partBytes?: number }  // POST /tvine/api/<id> may be multipart: a `params` JSON part + file parts (all files ≤ maxBytes, each ≤ partBytes, default maxBytes)
}
export type ConfirmRule = true | { message?: string | ((params: any, ctx: ActionCtx) => string); by?: 'anyone' | 'human' }

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
  // BACKLOG #2: the first call runs nothing and answers confirm_required + a single-use token (sid + action + params,
  // ~2 min); the same call again with params.$confirm = token runs. by 'human': only a human's request may confirm
  // a function decides per call (undefined = no confirm), e.g. admin's agents = 'confirm' asks only agent-marked writes
  confirm?: ConfirmRule | ((params: any, ctx: ActionCtx) => ConfirmRule | undefined)
  audit?: boolean                   // false = never write a tvine.audit row for this action (settings.audit)
  search?: string                   // the param that is a visitor's search term (admin dashboard Top searches): e.g. 'q'
  humanAttention?: true | string    // RESERVED placeholder (BACKLOG #2): carried to ActionHandle.attention + hook events; no behaviour
  // Django cache_page (conventions/cache.md): readOnly actions only (boot error otherwise). timeout in seconds;
  // varyOn default ['user']; 'session' | 'query' | a header name add to the key. Errors are never cached.
  cache?: { timeout: number; varyOn?: string[]; cache?: string; tags?: string[] }   // tags: cache.invalidateTags([...]) drops them
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
  coep?: false | 'require-corp' | 'credentialless'      // opt-in Cross-Origin-Embedder-Policy (cross-origin isolation)
  trustedTypes?: false | 'report-only'                  // opt-in: CSP-Report-Only require-trusted-types-for 'script' on HTML
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
  siteUrl?: string                  // the public origin ('https://shop.example') for links the server builds; else the Host
  health?: { token?: string }      // /tvine/health details for `Authorization: Bearer <token>`; anonymous gets { ok } only
  header: string                    // default 'x-tvine' (also Accept: text/tvine)
  formats: { default: 'json' | 'notation'; notationPath: boolean }
  trustProxy: number                // XFF hops to trust
  // Named connections (docs/design/conventions/backends.md). `default` falls back to REDIS_URL. Every subsystem
  // whose backend is 'redis' names one of these (its `redis` key, default 'default').
  redis: Record<string, RedisConnection>
  session: { ttlMs: number; cookieName: string; max: number   // max: live sessions kept; past it the least recently used is evicted
    backend: Backend; redis: string
    // the cookie's Secure flag (default: true in production). On, the name gets the __Host- prefix (Path=/, no Domain).
    secure: boolean
    sameSite: 'lax' | 'strict' | 'none'
    maxAgeMs: number                // absolute lifetime on top of the idle ttlMs (default 14 days; 0 = none)
  }
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
  // HTTP middleware (Django MIDDLEWARE), outermost first: 'tvine.middleware.<Name>', a defineMiddleware({...}), a class,
  // or [one of those, options] (middleware/index.ts). Only listed ones run. Action middleware: actionMiddleware.
  middleware: unknown[]
  actionMiddleware: Middleware[]    // around dispatch (core/middleware.ts); settings.middleware functions land here
  allowedHosts: string[]            // Django ALLOWED_HOSTS ('*', '.example.com'); required in production
  dev: { allowedHosts: string[] }   // debug only, never production: extra hosts (port forwarding: '*.devtunnels.ms') on top of localhost / LAN IPs / hostname
  debug: boolean                    // Django DEBUG: dev CSP, inspector feed, ServerTiming. TVINE_DEBUG; on under tvine dev
  guards: { path: string; permissions: Permission[] }[]
  media: { dir: string; route: string; auditAccess?: boolean }   // auditAccess: an audit row per private-file read
  snapshotCache: { ttlMs: number; backend: Backend; redis: string }   // shared snapshots of non-personal, non-live pages; 0 = off. Any committed write also clears it
  data: { defaultPageSize: number; maxPageSize: number }
  db: {
    url: string
    pool: { max: number; acquireMs: number; idleMs: number }
    atomicRequests: boolean         // Django ATOMIC_REQUESTS: each non-readOnly action = one transaction
    slowQueryMs: number             // a statement slower than this is logged on tvine.db (warn); 0 = off
  }
  logging: LoggingSetting           // 'json' | 'pretty' | 'none' or Django LOGGING (log.ts)
  // snapshot shape (progressive-disclosure.md): v2 default; 'v1' = the pre-v2 bytes, kept for one release
  // inTab (security.md): 'on' = agents may control a human's tab (WebMCP in-tab, remote after one Allow); 'off' = never
  agent: { shape: 'v1' | 'v2'; budget: number /* tokens */; rowsL1: number; inTab: 'on' | 'off' }
  frontend: { boundary: 'error' | 'warn' }   // W2b reads it: FE/DB boundary violations fail (error) or warn
  // tvine.audit (BACKLOG #1): one row per audited command, written in the command's transaction. actions: 'writes' =
  // every non-readOnly action, 'all' = reads too; redact: extra param names blanked (secret-looking names always are)
  audit: { enabled: boolean; actions: 'writes' | 'all'; retentionDays: number; redact: string[] }
  security: { headers: SecurityHeaders }
  cors: CorsSettings                // default closed: no routes
  compression: CompressionSettings
  // tvine.tasks (docs/design/contrib/tasks.md §Settings): lease / visibility timeout, claim poll, progress relay poll,
  // SIGTERM grace, how long final job rows are kept
  // broker: the job store (tvine.tasks picks the default: 'file'); redis: the settings.redis alias a 'redis' broker
  // uses; file / durable: the file broker's tasks.db path and power-cut durability; claimBatch: jobs per claim
  // conventions/cache.md: named caches (Django CACHES). timeout in seconds (null = forever); location: the file
  // backend's directory; redis: the settings.redis alias of a 'redis' cache
  caches: Record<string, CacheSettings>
  email: EmailSettings              // conventions/email.md (Django EMAIL_*)
  tasks: { leaseMs: number; pollMs: number; relayMs: number; graceMs: number; resultTtlMs: number
    broker?: 'db' | 'file' | 'memory' | 'redis'; redis: string; file: string; durable: boolean; claimBatch: number }
  // tvine.admin (docs/design/contrib/admin.md §1): where the panel mounts, its title, its theme
  // allowIps: addresses / CIDRs that may use the admin (panel + actions); require2fa: staff need TOTP; idleMs: staff idle timeout
  admin: {
    path: string; title?: string; theme: { brand?: string; radius?: string; dark: 'auto' | 'on' | 'off' }; allowIps?: string[]; require2fa?: boolean; idleMs?: number
    // dashboard: widget ids in display order (others follow) + the automatic per-model charts; stats: the hourly rollups
    dashboard: { widgets: string[]; autoCharts: boolean }
    stats: { enabled: boolean; retentionDays: number; flushMs: number; searches: { enabled: boolean; minCount: number }; pages: { enabled: boolean; keepParams: string[] } }
  }
  // BACKLOG #9: Prometheus text at `path`, off by default. Guard: a bearer `token`, or the client ip in `allowIps`;
  // neither set = loopback only. Never listed in agent discovery.
  metrics: { enabled: boolean; path: string; token?: string; allowIps: string[] }
  // BACKLOG #11: /robots.txt when the app ships none (public/robots.txt or an app/robots route wins). allow/disallow:
  // extra path rules for every agent; extra: raw lines appended; sitemap: an absolute url (else /sitemap.xml if the app has one)
  robots: { allow: string[]; disallow: string[]; extra: string[]; sitemap?: string }
  installedApps: string[]           // Django INSTALLED_APPS: project apps 'blog' (apps/blog/) and built-in 'tvine.auth', … (core/apps.ts)
  rootUrlconf?: string              // Django ROOT_URLCONF, a path from the project root without extension (default config/urls, else urls)
  tasksModule?: string              // queues / beatSchedule for tvine worker (default config/tasks)
  // encrypted model fields: AES-256-GCM root keys, newest first (rotation); empty = derived from secret (HKDF)
  encryption: { keys: string[] }
  secret: string | string[]         // HMAC key, min 32 chars enforced at boot; array = rotation
  auth?: AuthSettings
}

export type Backend = 'memory' | 'redis'
export interface CacheSettings {
  backend: 'memory' | 'redis' | 'file' | 'dummy'; redis: string; location?: string
  timeout: number | null; keyPrefix: string; version: number; maxEntries: number
}
export interface EmailSettings {
  backend: 'console' | 'smtp' | 'file' | 'memory' | 'dummy'
  host: string; port: number; user: string; password: string; useTls: boolean; useSsl: boolean; allowPlainAuth: boolean; timeoutMs: number
  defaultFrom: string; serverEmail: string; admins: string[]; subjectPrefix: string; filePath: string
}
// settings.redis.<alias>. url: redis:// or rediss:// (TLS); prefix: every key this connection writes starts with it.
export interface RedisConnection { url: string; tls?: boolean; prefix?: string; connectTimeoutMs?: number }

// settings.auth: `user` is the BYO resolver (overrides everything); the rest configures tvine.auth
// (docs/design/contrib/auth.md). Typed loosely here: core does not depend on contrib.
export interface AuthSettings {
  user?: (req: Request) => Promise<TvineUser | null>   // null/absent → tvine.auth (if installed) or ANONYMOUS
  // Django AUTH_USER_MODEL: 'app.Model' (default 'auth.User'); pick it before the first migrate
  userModel?: string
  // Django AUTHENTICATION_BACKENDS, tried in order: 'tvine.auth.ModelBackend' (default), 'tvine.auth.EmailBackend', a
  // dotted path 'accounts.backends.LdapBackend' (an export of apps/accounts/backends.ts), or the object / class
  backends?: unknown[]
  hashers?: PasswordHasher[]           // first = preferred; others verify (and get upgraded on login)
  validators?: PasswordValidator[]
  login?: { maxFailures?: number; accountMaxFailures?: number; ipMaxFailures?: number; windowMs?: number; lockoutMs?: number }
  resetTimeoutMs?: number
  resetUrl?: string                    // default reset mail link: '{uid}' and '{token}' are filled in
  sendPasswordReset?: (e: { user: { id: string; username: string; email: string }; email: string; uid: string; token: string; request: Request }) => unknown
  objectPermission?: (user: TvineUser, perm: string, obj: unknown) => boolean | Promise<boolean>
  tokens?: { defaultDays?: number; maxDays?: number }
  totp?: { issuer?: string }
  breachCheck?: boolean                // new passwords are checked against Have I Been Pwned (k-anonymity), off by default
  // security notices by mail (contrib/auth/notify.ts); each defaults to on when settings.email.backend is not 'dummy'
  notify?: { newLogin?: boolean; passwordChanged?: boolean; twoFactorDisabled?: boolean; tokenCreated?: boolean; emailChanged?: boolean }
}
export interface PasswordHasher {
  algorithm: string
  encode(password: string): Promise<string>
  verify(password: string, encoded: string): Promise<boolean>
  mustUpdate(encoded: string): boolean   // weaker parameters than this hasher's: rehash on next login
}
// Returns the problems (empty = ok). user: the attributes similarity checks look at.
export type PasswordValidator = (password: string, user?: Record<string, unknown>) => string[]
