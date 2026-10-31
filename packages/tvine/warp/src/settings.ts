import { randomBytes } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import { env, fromDotenv, isProduction } from './env.js'
import { LEVELS } from './log.js'
import type { AuthSettings, CacheSettings, Settings, Permission, Middleware, PasswordHasher, PasswordValidator, TvineUser, Request } from './core/types.js'

// Canonical shape: docs/design/conventions/settings.md. Validated at boot.
type Fn = (...args: never[]) => unknown
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Fn | unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}
export type SettingsInput = DeepPartial<Settings>

export const DEFAULT_DB_URL = 'file:./tvine.db'

// THE db url precedence, used by defineSettings and db.ts: explicit setting > DATABASE_URL > default.
export function resolveDbUrl(explicit?: string): string {
  if (explicit !== undefined) return explicit
  const env = process.env.DATABASE_URL
  if (env === undefined) return DEFAULT_DB_URL
  // set-but-blank must never silently land on local sqlite
  if (!env.trim()) throw new Error('DATABASE_URL is set but empty')
  return env
}

// REDIS_URL fills settings.redis.default (same precedence as db.url: explicit setting > env > none).
export function redisFromEnv(): Settings['redis'] {
  const env = process.env.REDIS_URL
  if (env === undefined) return {}
  if (!env.trim()) throw new Error('REDIS_URL is set but empty')
  return { default: { url: env } }
}

// Django MIDDLEWARE defaults: secure without configuring anything (middleware/index.ts has the catalog)
export const DEFAULT_MIDDLEWARE = ['RequestId', 'AllowedHosts', 'Security', 'Cors', 'GZip'].map((n) => `tvine.middleware.${n}`)
// Django's DEBUG ALLOWED_HOSTS: what dev (and tests) accept when settings.allowedHosts is empty
export const DEV_HOSTS = ['localhost', '.localhost', '127.0.0.1', '[::1]']

export const CACHE_DEFAULTS: CacheSettings = { backend: 'memory', redis: 'default', timeout: 300, keyPrefix: '', version: 1, maxEntries: 300 }

export const DEFAULTS: Omit<Settings, 'secret' | 'auth'> = {
  site: { name: 'tvine app', description: '' },
  header: 'x-tvine',
  formats: { default: 'json', notationPath: true },
  trustProxy: 0,
  redis: {},
  session: { ttlMs: 86_400_000, cookieName: 'tvine_s', max: 100_000, backend: 'memory', redis: 'default', secure: false, sameSite: 'lax', maxAgeMs: 1_209_600_000 },
  channels: { backend: 'memory', redis: 'default' },
  limits: {
    bodyBytes: 65_536,
    handlerMs: 10_000,
    rate: { limit: 60, windowMs: 60_000 },
    sseConnPerIp: 20,
    backend: 'memory',
    redis: 'default',
  },
  socket: true,
  mcp: { tools: 'both', exclude: [], maxTools: 40 },
  middleware: DEFAULT_MIDDLEWARE,
  actionMiddleware: [],
  allowedHosts: [],
  dev: { allowedHosts: [] },
  debug: false,
  guards: [],
  media: { dir: './media', route: '/media' },
  snapshotCache: { ttlMs: 60_000, backend: 'memory', redis: 'default' },
  data: { defaultPageSize: 25, maxPageSize: 100 },
  // Relative to process.cwd() (Django-style), not to the settings file. Real value is resolved in defineSettings.
  db: { url: DEFAULT_DB_URL, pool: { max: 10, acquireMs: 5_000, idleMs: 30_000 }, atomicRequests: true, slowQueryMs: 500 },
  logging: 'json',
  agent: { shape: 'v2', budget: 1500, rowsL1: 10, inTab: 'on' },
  frontend: { boundary: 'error' },
  audit: { enabled: false, actions: 'writes', retentionDays: 90, redact: [] },
  security: {
    headers: {
      enabled: true,
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
      csp: { reportOnly: false, directives: {}, reportUri: '/tvine/csp-report', staticPages: 'relaxed' },
      referrerPolicy: 'strict-origin-when-cross-origin',
      coop: 'same-origin',
      corp: 'same-origin',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [], 'display-capture': [], 'browsing-topics': [], 'clipboard-read': [] },
    },
  },
  cors: {
    origins: [], methods: ['GET', 'POST'],
    allowHeaders: ['content-type', 'authorization', 'x-tvine', 'x-tvine-sid', 'x-tvine-view', 'x-tvine-expand', 'x-tvine-offset', 'x-tvine-limit', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
    exposeHeaders: ['x-request-id', 'etag', 'retry-after', 'mcp-session-id'],
    credentials: false, maxAge: 600, routes: [],
  },
  compression: { enabled: true, threshold: 1024, brotli: true, gzipLevel: 6, brotliQuality: 4 },
  tasks: { leaseMs: 30_000, pollMs: 500, relayMs: 250, graceMs: 30_000, resultTtlMs: 86_400_000, redis: 'default', file: './tasks.db', durable: false, claimBatch: 10 },
  admin: { path: '/admin', theme: { dark: 'auto' }, dashboard: { widgets: [], autoCharts: true }, stats: { enabled: true, retentionDays: 30, flushMs: 60_000, searches: { enabled: true, minCount: 3 }, pages: { enabled: true, keepParams: [] } } },
  caches: { default: CACHE_DEFAULTS },
  // backend: 'console' in dev, 'memory' under tests (Django's locmem swap), 'smtp' in production (defineSettings)
  email: { backend: 'console', host: 'localhost', port: 25, user: '', password: '', useTls: false, useSsl: false, allowPlainAuth: false, timeoutMs: 10_000,
    defaultFrom: 'webmaster@localhost', serverEmail: 'root@localhost', admins: [], subjectPrefix: '[Tvine] ', filePath: './mail' },
  metrics: { enabled: false, path: '/tvine/metrics', allowIps: [] },
  robots: { allow: [], disallow: [], extra: [] },
  installedApps: [],
  encryption: { keys: [] },
}

const corsPolicy = z.object({
  origins: z.array(z.union([z.string(), z.instanceof(RegExp)])),
  methods: z.array(z.string().regex(/^[A-Za-z]+$/)),
  allowHeaders: z.array(z.string().regex(/^[\w-]+$/)),
  exposeHeaders: z.array(z.string().regex(/^[\w-]+$/)),
  credentials: z.boolean(),
  maxAge: z.number().int().min(0),
})
const fn = <T>() => z.custom<T>((v) => typeof v === 'function', { message: 'must be a function' })
const posInt = z.number().int().min(0)
const backend = z.enum(['memory', 'redis'])
const alias = z.string().regex(/^[A-Za-z_][\w-]*$/, 'a connection alias is a plain name (letters, digits, _ -)')
// never echo the url in a validation error: it may carry a password
const redisUrl = z.string().refine((u) => /^rediss?:\/\/./.test(u.trim()), 'redis url must start with redis:// or rediss://')

const schema: z.ZodType<Settings> = z.object({
  site: z.object({ name: z.string(), description: z.string() }),
  siteUrl: z.string().regex(/^https?:\/\/[^/\s]+\/?$/, 'an origin like https://shop.example').optional(),
  health: z.object({ token: z.string().min(16, 'health.token: at least 16 characters').optional() }).strict().optional(),
  header: z.string(),
  formats: z.object({ default: z.enum(['json', 'notation']), notationPath: z.boolean() }),
  trustProxy: posInt,
  redis: z.record(alias, z.object({
    url: redisUrl, tls: z.boolean().optional(),
    prefix: z.string().max(64).regex(/^[^\s*?[\]]*$/, 'prefix may not hold spaces or glob characters').optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
  }).strict()),
  session: z.object({ ttlMs: z.number().positive(), cookieName: z.string(), max: z.number().int().positive(), backend, redis: alias,
    secure: z.boolean(), sameSite: z.enum(['lax', 'strict', 'none']), maxAgeMs: z.number().min(0) }).refine((s) => s.sameSite !== 'none' || s.secure, 'session.sameSite none needs session.secure'),
  channels: z.object({ backend, redis: alias }),
  limits: z.object({
    bodyBytes: posInt,
    handlerMs: z.number().positive(),
    rate: z.object({ limit: posInt, windowMs: z.number().positive() }),
    sseConnPerIp: posInt,
    backend, redis: alias,
  }),
  socket: z.boolean(),
  mcp: z.object({ tools: z.enum(['both', 'generic', 'typed']), exclude: z.array(z.string()), maxTools: posInt }),
  middleware: z.array(z.custom<unknown>((v) => typeof v === 'string' || typeof v === 'function' || (Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'object' || typeof v[0] === 'function') && isPlain(v[1])) || isPlain(v),
    { message: "a middleware entry is 'tvine.middleware.<Name>', defineMiddleware({...}), a class, or [one of those, options]" })),
  actionMiddleware: z.array(fn<Middleware>()),
  allowedHosts: z.array(z.string().regex(/^(\*|\.?[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i, "a host name, '.example.com' (with subdomains), an [ipv6] or '*'")),
  dev: z.object({ allowedHosts: z.array(z.string().regex(/^(\*|(\*\.|\.)?[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i, "a host name, '.example.com' or '*.example.com' (with subdomains), an [ipv6] or '*'")) }),
  debug: z.boolean(),
  guards: z.array(z.object({ path: z.string(), permissions: z.array(fn<Permission>()) })),
  media: z.object({ dir: z.string(), route: z.string(), auditAccess: z.boolean().optional() }),
  snapshotCache: z.object({ ttlMs: posInt, backend, redis: alias }),
  data: z.object({ defaultPageSize: posInt, maxPageSize: posInt }),
  db: z.object({
    url: z.string().refine((u) => u.trim() !== '', 'database url is empty'),
    pool: z.object({ max: posInt, acquireMs: posInt, idleMs: posInt }),
    atomicRequests: z.boolean(),
    slowQueryMs: posInt,
  }),
  logging: z.union([z.enum(['json', 'pretty', 'none']), z.object({
    level: z.enum(LEVELS), format: z.enum(['json', 'pretty']),
    handlers: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('console'), level: z.enum(LEVELS).optional(), format: z.enum(['json', 'pretty']).optional(), stream: z.enum(['stdout', 'stderr']).optional() }).strict(),
      z.object({ type: z.literal('file'), path: z.string().min(1), level: z.enum(LEVELS).optional(), format: z.enum(['json', 'pretty']).optional(),
        maxBytes: z.number().int().positive().optional(), daily: z.boolean().optional(), keep: z.number().int().min(0).optional() }).strict(),
      z.object({ type: z.literal('custom'), level: z.enum(LEVELS).optional(), write: fn<(r: never) => void>() }).strict(),
      z.object({ type: z.literal('memory'), level: z.enum(LEVELS).optional(), size: z.number().int().min(1).max(100_000).optional() }).strict(),
    ])),
    loggers: z.record(z.string(), z.enum([...LEVELS, 'off'])),
    redact: z.array(z.string()),
  }).partial().strict()]),
  agent: z.object({ shape: z.enum(['v1', 'v2']), budget: posInt, rowsL1: posInt, inTab: z.enum(['on', 'off']) }),
  frontend: z.object({ boundary: z.enum(['error', 'warn']) }),
  audit: z.object({ enabled: z.boolean(), actions: z.enum(['writes', 'all']), retentionDays: z.number().int().positive(), redact: z.array(z.string()) }),
  security: z.object({
    headers: z.object({
      enabled: z.boolean(),
      hsts: z.union([z.literal(false), z.object({ maxAge: z.number().int().min(0), includeSubDomains: z.boolean(), preload: z.boolean() })
        .refine((h) => !h.preload || (h.maxAge >= 31_536_000 && h.includeSubDomains), 'hsts.preload needs maxAge >= 31536000 and includeSubDomains')]),
      csp: z.union([z.literal(false), z.object({
        reportOnly: z.boolean(),
        directives: z.record(z.string().regex(/^[a-z-]+$/, 'directive names are lowercase'), z.union([z.array(z.string().regex(/^[^;,\s]+$/, 'one source per entry, no ; , or spaces')), z.literal(false)])),
        reportUri: z.union([z.string().regex(/^(\/|https:\/\/)[^;,\s"]*$/, 'a path or an https URL'), z.literal(false)]),
        staticPages: z.enum(['relaxed', 'strict']),
      })]),
      referrerPolicy: z.enum(['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url']),
      coop: z.union([z.literal(false), z.enum(['same-origin', 'same-origin-allow-popups', 'unsafe-none'])]),
      corp: z.union([z.literal(false), z.enum(['same-origin', 'same-site', 'cross-origin'])]),
      permissionsPolicy: z.record(z.string().regex(/^[a-z-]+$/), z.union([z.array(z.string().regex(/^(self|\*|https?:\/\/[^\s"()]+)$/, "'self', '*' or an origin")), z.literal(false)])),
      coep: z.union([z.literal(false), z.enum(['require-corp', 'credentialless'])]).optional(),
      trustedTypes: z.union([z.literal(false), z.literal('report-only')]).optional(),
    }),
  }),
  cors: corsPolicy.extend({ routes: z.array(corsPolicy.partial().extend({ path: z.string().startsWith('/') })) }),
  compression: z.object({ enabled: z.boolean(), threshold: posInt, brotli: z.boolean(), gzipLevel: z.number().int().min(1).max(9), brotliQuality: z.number().int().min(0).max(11) }),
  tasks: z.object({ leaseMs: z.number().int().min(1000), pollMs: z.number().int().min(10), relayMs: z.number().int().min(10), graceMs: posInt, resultTtlMs: posInt,
    broker: z.enum(['db', 'file', 'memory', 'redis']).optional(), redis: alias, file: z.string().min(1), durable: z.boolean(), claimBatch: z.number().int().min(1).max(100) }),
  admin: z.object({ path: z.string().regex(/^\/[\w\-/]*$/, 'a path starting with /'), title: z.string().optional(),
    theme: z.object({ brand: z.string().optional(), radius: z.string().optional(), dark: z.enum(['auto', 'on', 'off']) }),
    allowIps: z.array(z.string().refine(validCidr, 'an address or CIDR (e.g. 10.0.0.0/8)')).optional(), require2fa: z.boolean().optional(), idleMs: z.number().int().positive().optional(),
    dashboard: z.object({ widgets: z.array(z.string().max(100)).max(100), autoCharts: z.boolean() }),
    stats: z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(3650), flushMs: z.number().int().min(1000),
      searches: z.object({ enabled: z.boolean(), minCount: z.number().int().min(1).max(1000) }),
      pages: z.object({ enabled: z.boolean(), keepParams: z.array(z.string().max(40)).max(20) }) }) }),
  caches: z.record(alias, z.object({
    backend: z.enum(['memory', 'redis', 'file', 'dummy']), redis: alias, location: z.string().min(1).optional(),
    timeout: z.number().min(0).nullable(), keyPrefix: z.string().max(64), version: z.number().int(), maxEntries: z.number().int().positive(),
  }).strict().refine((c) => c.backend !== 'file' || !!c.location, 'a file cache needs location (a directory)')),
  email: z.object({
    backend: z.enum(['console', 'smtp', 'file', 'memory', 'dummy']), host: z.string(), port: z.number().int().min(1).max(65_535),
    user: z.string(), password: z.string(), useTls: z.boolean(), useSsl: z.boolean(), allowPlainAuth: z.boolean(), timeoutMs: z.number().int().positive(),
    defaultFrom: z.string(), serverEmail: z.string(), admins: z.array(z.string()), subjectPrefix: z.string(), filePath: z.string().min(1),
  }).strict().refine((e) => !(e.useTls && e.useSsl), 'email.useTls and email.useSsl are mutually exclusive'),
  metrics: z.object({ enabled: z.boolean(), path: z.string().regex(/^\/[\w\-/.]*$/, 'a path starting with /'),
    token: z.string().min(16, 'metrics.token: at least 16 chars').optional(), allowIps: z.array(z.string().min(1)) }).strict(),
  robots: z.object({ allow: z.array(z.string().regex(/^\/\S*$/, 'a path')), disallow: z.array(z.string().regex(/^\/\S*$/, 'a path')), extra: z.array(z.string().regex(/^[^\r\n]*$/, 'one line per entry')),
    sitemap: z.string().regex(/^https?:\/\/\S+$/, 'an absolute http(s) url').optional() }).strict(),
  installedApps: z.array(z.string().regex(/^(tvine\.)?[a-z][a-z0-9_]*$/, "a project app 'blog' (apps/blog/) or a built-in app 'tvine.<name>'")),
  rootUrlconf: z.string().min(1).optional(),
  tasksModule: z.string().min(1).optional(),
  encryption: z.object({ keys: z.array(z.string().min(32, 'encryption.keys: each key at least 32 chars')).refine((k) => new Set(k).size === k.length, 'encryption.keys: duplicate key') }).strict(),
  secret: z.union([z.string(), z.array(z.string())]),
  auth: z.object({
    user: fn<(req: Request) => Promise<TvineUser | null>>().optional(),
    userModel: z.string().regex(/^[a-z][a-z0-9_]*\.[A-Za-z]\w*$/, "'app.Model', e.g. 'accounts.User'").optional(),
    backends: z.array(z.unknown()).min(1).optional(),
    hashers: z.array(z.object({ algorithm: z.string(), encode: fn<PasswordHasher['encode']>(), verify: fn<PasswordHasher['verify']>(), mustUpdate: fn<PasswordHasher['mustUpdate']>() })).min(1).optional(),
    validators: z.array(fn<PasswordValidator>()).optional(),
    login: z.object({ maxFailures: z.number().int().positive(), accountMaxFailures: z.number().int().positive(), ipMaxFailures: z.number().int().positive(), windowMs: z.number().positive(), lockoutMs: z.number().positive() }).partial().optional(),
    resetTimeoutMs: z.number().positive().optional(),
    resetUrl: z.string().optional(),
    sendPasswordReset: fn<NonNullable<AuthSettings['sendPasswordReset']>>().optional(),
    objectPermission: fn<NonNullable<AuthSettings['objectPermission']>>().optional(),
    tokens: z.object({ defaultDays: z.number().positive(), maxDays: z.number().positive() }).partial().optional(),
    totp: z.object({ issuer: z.string() }).partial().optional(),
    breachCheck: z.boolean().optional(),
    notify: z.object({ newLogin: z.boolean(), passwordChanged: z.boolean(), twoFactorDisabled: z.boolean(), tokenCreated: z.boolean(), emailChanged: z.boolean() }).partial().strict().optional(),
  }).strict().optional(),
}).refine((s) => !s.audit.enabled || s.installedApps.includes('tvine.audit'), { message: "settings.audit.enabled needs 'tvine.audit' in settings.installedApps (its table and admin)", path: ['audit'] }) as z.ZodType<Settings>

// admin.allowIps entries must parse at boot (a typo must not silently lock everyone out, or let everyone in)
function validCidr(e: string): boolean {
  const [a, p, extra] = e.split('/'), v = isIP(a ?? '')
  if (!v || extra !== undefined) return false
  if (p === undefined) return true
  try { new BlockList().addSubnet(a!, Number(p), v === 6 ? 'ipv6' : 'ipv4'); return /^\d{1,3}$/.test(p) } catch { return false }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Deep-merge plain objects; arrays, functions and scalars from `over` replace.
export function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k] as Record<string, unknown>, v) : v
  }
  return out
}

export function defineSettings(input: SettingsInput & { secret?: string | string[] }): Settings {
  const prod = process.env.NODE_ENV === 'production'
  const { secret: given, ...rest } = input
  // explicit > TVINE_SECRET > (dev only) a random per-boot key; prod without one fails loudly below
  // TVINE_SECRET may be a comma-separated rotation list (new first): `new,old`
  const fromEnv = env.has('TVINE_SECRET') ? env.list('TVINE_SECRET') : undefined
  const secret = given ?? (fromEnv && (fromEnv.length === 1 ? fromEnv[0] : fromEnv)) ?? (prod ? undefined : randomBytes(32).toString('hex'))
  const keys = secret === undefined ? [] : [secret].flat()
  const ok = keys.length > 0 && keys.every((k) => k.length >= 32) && new Set(keys).size === keys.length
  if (!ok && given !== undefined) throw new Error(SECRET_HELP)   // a wrong value in code: no reason to wait
  // settings.md: logging defaults to json in prod, pretty otherwise; explicit input wins.
  const email = { ...DEFAULTS.email, backend: emailBackendDefault() }
  const base = { ...DEFAULTS, session: { ...DEFAULTS.session, secure: env.bool('TVINE_SESSION_SECURE', prod) }, db: { ...DEFAULTS.db, url: resolveDbUrl() }, redis: redisFromEnv(), email, secret: ok ? secret : 'x'.repeat(32), logging: prod ? 'json' : 'pretty' }
  const merged = merge(base as Record<string, unknown>, rest as Record<string, unknown>)
  // every named cache (not only `default`) is completed from the cache defaults
  if (isPlain(merged.caches)) merged.caches = Object.fromEntries(Object.entries(merged.caches).map(([k, c]) => [k, { ...CACHE_DEFAULTS, ...(c as object) }]))
  // back compat: functions in settings.middleware are action middleware (the old form); strings / objects / classes
  // are HTTP middleware. A list of only functions keeps the default HTTP list.
  if (Array.isArray(rest.middleware)) {
    const action = rest.middleware.filter((m) => typeof m === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(m)))
    const http = rest.middleware.filter((m) => !action.includes(m as never))
    merged.actionMiddleware = [...((rest.actionMiddleware as unknown[] | undefined) ?? []), ...action]
    merged.middleware = http.length || !action.length ? http : DEFAULT_MIDDLEWARE
  }
  if ((rest as { encryption?: { keys?: unknown } }).encryption?.keys === undefined && env.has('TVINE_ENCRYPTION_KEYS')) merged.encryption = { keys: env.list('TVINE_ENCRYPTION_KEYS') }
  if (rest.allowedHosts === undefined && env.has('TVINE_ALLOWED_HOSTS')) merged.allowedHosts = env.list('TVINE_ALLOWED_HOSTS')
  // production: DEBUG only from the real environment, never from a .env file that shipped with the code
  const debugEnv = env.has('TVINE_DEBUG') && !(prod && fromDotenv.has('TVINE_DEBUG'))
  if (rest.debug === undefined) merged.debug = debugEnv ? env.bool('TVINE_DEBUG') : ['development', 'test'].includes(process.env.NODE_ENV ?? '')
  // Django: with DEBUG and no ALLOWED_HOSTS, localhost works; in production an empty list is a boot error (checkHosts)
  if (!(merged.allowedHosts as string[]).length && !prod) merged.allowedHosts = DEV_HOSTS
  // settings.admin.allowIps also guards the panel's pages (the admin actions check it themselves: contrib/admin/hardening.ts)
  const adminIps = (merged.admin as { allowIps?: string[]; path?: string } | undefined)
  if (adminIps?.allowIps?.length && Array.isArray(merged.middleware)) merged.middleware = [...merged.middleware as unknown[], ['tvine.middleware.IpFilter', { paths: [adminIps.path ?? '/admin'], allow: adminIps.allowIps }]]
  const settings = schema.parse(merged)
  // secreview M2: a Secure cookie on Path=/ with no Domain is a __Host- cookie (a subdomain or http page cannot plant it)
  if (settings.session.secure && !settings.session.cookieName.startsWith('__')) settings.session.cookieName = `__Host-${settings.session.cookieName}`
  // A missing (or bad env) secret fails at boot (loadSettings) or at its first use, never at import: a page
  // module may import settings.ts during `next build`, where no secret exists. Non-enumerable, so
  // merging these settings again (loadSettings) re-resolves the secret instead of tripping here.
  if (!ok) Object.defineProperty(settings, 'secret', { enumerable: false, get: () => { throw new Error(SECRET_HELP) } })
  return settings
}

// Django parity: smtp in production, the in-memory outbox under tests (locmem), console in dev
export function emailBackendDefault(): 'smtp' | 'memory' | 'console' {
  if (process.env.NODE_ENV === 'production') return 'smtp'
  return process.env.NODE_ENV === 'test' || process.env.VITEST ? 'memory' : 'console'
}

const SECRET_HELP = 'TVINE_SECRET must be a random string of at least 32 chars; a rotation list (comma-separated, new first) needs each key >= 32 chars and no duplicates (fix: export TVINE_SECRET=$(openssl rand -hex 32))'

// Every subsystem whose backend is 'redis' must name a configured connection. Run at boot (loadSettings,
// tvine check), not in defineSettings: a page may import settings.ts during `next build` with no REDIS_URL.
export function redisUsers(s: Settings): { key: string; alias: string }[] {
  const out: { key: string; alias: string }[] = []
  for (const k of ['session', 'channels', 'limits', 'snapshotCache'] as const) if (s[k].backend === 'redis') out.push({ key: `settings.${k}.backend`, alias: s[k].redis })
  for (const [k, c] of Object.entries(s.caches ?? {})) if (c.backend === 'redis') out.push({ key: `settings.caches.${k}.backend`, alias: c.redis })
  if (s.tasks.broker === 'redis') out.push({ key: 'settings.tasks.broker', alias: s.tasks.redis })
  return out
}
// AllowedHosts on, production, no hosts: every request would be a 400 — fail at boot instead (Django check --deploy)
export function checkHosts(s: Settings): void {
  const on = s.middleware.some((m) => m === 'tvine.middleware.AllowedHosts' || (Array.isArray(m) && m[0] === 'tvine.middleware.AllowedHosts'))
  if (on && isProduction() && !s.allowedHosts.length) throw new Error("settings.allowedHosts is empty in production: list your domains (e.g. ['shop.example.com', '.example.com']) or set TVINE_ALLOWED_HOSTS=shop.example.com")
}

export function checkBackends(s: Settings): void {
  for (const u of redisUsers(s)) {
    if (!s.redis[u.alias]) {
      throw new Error(`${u.key} is 'redis' but settings.redis.${u.alias} is not configured (set settings.redis.${u.alias}.url${u.alias === 'default' ? ' or REDIS_URL' : ''})`)
    }
  }
}
