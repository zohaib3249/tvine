import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Settings, Permission, Middleware, TvineUser, Request } from './core/types.js'

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

export const DEFAULTS: Omit<Settings, 'secret' | 'auth'> = {
  site: { name: 'tvine app', description: '' },
  header: 'x-tvine',
  formats: { default: 'json', notationPath: true },
  trustProxy: 0,
  session: { ttlMs: 86_400_000, cookieName: 'tvine_s', max: 100_000 },
  limits: {
    bodyBytes: 65_536,
    handlerMs: 10_000,
    rate: { limit: 60, windowMs: 60_000 },
    sseConnPerIp: 20,
  },
  socket: true,
  mcp: { tools: 'both', exclude: [], maxTools: 40 },
  middleware: [],
  guards: [],
  media: { dir: './media', route: '/media' },
  snapshotCache: { ttlMs: 60_000 },
  data: { defaultPageSize: 25, maxPageSize: 100 },
  // Relative to process.cwd() (Django-style), not to the settings file. Real value is resolved in defineSettings.
  db: { url: DEFAULT_DB_URL, pool: { max: 10, acquireMs: 5_000, idleMs: 30_000 }, atomicRequests: true },
  logging: 'json',
  agent: { shape: 'v2', budget: 1500, rowsL1: 10, inTab: 'on' },
  frontend: { boundary: 'error' },
  audit: false,
  security: {
    headers: {
      enabled: true,
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
      csp: { reportOnly: false, directives: {}, reportUri: '/tvine/csp-report', staticPages: 'relaxed' },
      referrerPolicy: 'strict-origin-when-cross-origin',
      coop: 'same-origin',
      corp: 'same-origin',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [], 'display-capture': [], 'browsing-topics': [] },
    },
  },
  cors: {
    origins: [], methods: ['GET', 'POST'],
    allowHeaders: ['content-type', 'authorization', 'x-tvine', 'x-tvine-sid', 'x-tvine-view', 'x-tvine-expand', 'x-tvine-offset', 'x-tvine-limit', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
    exposeHeaders: ['x-request-id', 'etag', 'retry-after', 'mcp-session-id'],
    credentials: false, maxAge: 600, routes: [],
  },
  compression: { enabled: true, threshold: 1024, brotli: true, gzipLevel: 6, brotliQuality: 4 },
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

const schema: z.ZodType<Settings> = z.object({
  site: z.object({ name: z.string(), description: z.string() }),
  header: z.string(),
  formats: z.object({ default: z.enum(['json', 'notation']), notationPath: z.boolean() }),
  trustProxy: posInt,
  session: z.object({ ttlMs: z.number().positive(), cookieName: z.string(), max: z.number().int().positive() }),
  limits: z.object({
    bodyBytes: posInt,
    handlerMs: z.number().positive(),
    rate: z.object({ limit: posInt, windowMs: z.number().positive() }),
    sseConnPerIp: posInt,
  }),
  socket: z.boolean(),
  mcp: z.object({ tools: z.enum(['both', 'generic', 'typed']), exclude: z.array(z.string()), maxTools: posInt }),
  middleware: z.array(fn<Middleware>()),
  guards: z.array(z.object({ path: z.string(), permissions: z.array(fn<Permission>()) })),
  media: z.object({ dir: z.string(), route: z.string() }),
  snapshotCache: z.object({ ttlMs: posInt }),
  data: z.object({ defaultPageSize: posInt, maxPageSize: posInt }),
  db: z.object({
    url: z.string().refine((u) => u.trim() !== '', 'database url is empty'),
    pool: z.object({ max: posInt, acquireMs: posInt, idleMs: posInt }),
    atomicRequests: z.boolean(),
  }),
  logging: z.enum(['json', 'pretty', 'none']),
  agent: z.object({ shape: z.enum(['v1', 'v2']), budget: posInt, rowsL1: posInt, inTab: z.enum(['on', 'off']) }),
  frontend: z.object({ boundary: z.enum(['error', 'warn']) }),
  audit: z.boolean(),
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
    }),
  }),
  cors: corsPolicy.extend({ routes: z.array(corsPolicy.partial().extend({ path: z.string().startsWith('/') })) }),
  compression: z.object({ enabled: z.boolean(), threshold: posInt, brotli: z.boolean(), gzipLevel: z.number().int().min(1).max(9), brotliQuality: z.number().int().min(0).max(11) }),
  secret: z.union([z.string(), z.array(z.string())]),
  auth: z.object({ user: fn<(req: Request) => Promise<TvineUser | null>>().optional() }).optional(),
})

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
  const secret = given ?? process.env.TVINE_SECRET ?? (prod ? undefined : randomBytes(32).toString('hex'))
  const keys = secret === undefined ? [] : [secret].flat()
  const ok = keys.length > 0 && keys.every((k) => k.length >= 32)
  if (!ok && given !== undefined) throw new Error(SECRET_HELP)   // a wrong value in code: no reason to wait
  // settings.md: logging defaults to json in prod, pretty otherwise; explicit input wins.
  const base = { ...DEFAULTS, db: { ...DEFAULTS.db, url: resolveDbUrl() }, secret: ok ? secret : 'x'.repeat(32), logging: prod ? 'json' : 'pretty' }
  const settings = schema.parse(merge(base as Record<string, unknown>, rest as Record<string, unknown>))
  // A missing (or bad env) secret fails at boot (loadSettings) or at its first use, never at import: a page
  // module may import settings.ts during `next build`, where no secret exists. Non-enumerable, so
  // merging these settings again (loadSettings) re-resolves the secret instead of tripping here.
  if (!ok) Object.defineProperty(settings, 'secret', { enumerable: false, get: () => { throw new Error(SECRET_HELP) } })
  return settings
}

const SECRET_HELP = 'TVINE_SECRET must be a random string of at least 32 chars (fix: export TVINE_SECRET=$(openssl rand -hex 32))'
