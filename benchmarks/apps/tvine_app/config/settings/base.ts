import type { SettingsInput } from 'tvine'

// BENCH_SHIELD=1 → the Shield variant (same app, tvine.shield installed + middleware, enforce, trustProxy 1).
const shieldOn = process.env.BENCH_SHIELD === '1'
const mw = ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Security', 'tvine.middleware.Cors', 'tvine.middleware.GZip']

export const base = {
  site: { name: 'Bench', description: 'benchmark app' },
  installedApps: shieldOn ? ['tvine.auth', 'tvine.tasks', 'tvine.shield', 'items'] : ['items'],
  middleware: shieldOn ? ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Shield', ...mw.slice(2)] : mw,
  trustProxy: process.env.BENCH_TRUST_PROXY ? Number(process.env.BENCH_TRUST_PROXY) : 0,
  ...(shieldOn ? { shield: { mode: 'enforce' } } : {}),
  // lifted for the benchmark: general action rate limit (also every action's default own rate)
  limits: { rate: { limit: 1e9, windowMs: 60_000 }, handlerMs: 10_000 },
  redis: { default: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6391' } },
  caches: { redis: { backend: 'redis', redis: 'default', timeout: 60 } },
  admin: { stats: { enabled: false } },
  db: { slowQueryMs: 0 },
} satisfies SettingsInput
