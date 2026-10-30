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
  return explicit ?? (process.env.DATABASE_URL?.trim() ? process.env.DATABASE_URL : DEFAULT_DB_URL)
}

export const DEFAULTS: Omit<Settings, 'secret' | 'auth'> = {
  site: { name: 'tvine app', description: '' },
  header: 'x-tvine',
  formats: { default: 'json', notationPath: true },
  trustProxy: 0,
  session: { ttlMs: 86_400_000, cookieName: 'tvine_s' },
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
  data: { defaultPageSize: 25, maxPageSize: 100 },
  // Relative to process.cwd() (Django-style), not to the settings file. Real value is resolved in defineSettings.
  db: { url: DEFAULT_DB_URL, pool: { max: 10, acquireMs: 5_000, idleMs: 30_000 } },
  logging: 'json',
  audit: false,
}

const fn = <T>() => z.custom<T>((v) => typeof v === 'function', { message: 'must be a function' })
const posInt = z.number().int().min(0)

const schema: z.ZodType<Settings> = z.object({
  site: z.object({ name: z.string(), description: z.string() }),
  header: z.string(),
  formats: z.object({ default: z.enum(['json', 'notation']), notationPath: z.boolean() }),
  trustProxy: posInt,
  session: z.object({ ttlMs: z.number().positive(), cookieName: z.string() }),
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
  data: z.object({ defaultPageSize: posInt, maxPageSize: posInt }),
  db: z.object({
    url: z.string(),
    pool: z.object({ max: posInt, acquireMs: posInt, idleMs: posInt }),
  }),
  logging: z.enum(['json', 'pretty', 'none']),
  audit: z.boolean(),
  secret: z.union([z.string(), z.array(z.string())]),
  auth: z.object({ user: fn<(req: Request) => Promise<TvineUser | null>>().optional() }).optional(),
})

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Deep-merge plain objects; arrays, functions and scalars from `over` replace.
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
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
  const secret = given ?? (prod ? undefined : randomBytes(32).toString('hex'))
  const keys = secret === undefined ? [] : [secret].flat()
  if (!keys.length || keys.some((k) => k.length < 32)) {
    throw new Error(
      'TVINE_SECRET must be a random string of at least 32 chars (fix: export TVINE_SECRET=$(openssl rand -hex 32))',
    )
  }
  // settings.md: logging defaults to json in prod, pretty otherwise; explicit input wins.
  const base = { ...DEFAULTS, db: { ...DEFAULTS.db, url: resolveDbUrl() }, secret, logging: prod ? 'json' : 'pretty' }
  const merged = merge(base as Record<string, unknown>, rest as Record<string, unknown>)
  return schema.parse(merged)
}
