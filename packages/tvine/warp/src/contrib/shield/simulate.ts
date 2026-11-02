// `tvine shield simulate [--count N] [--hours H] | --clear` (dev only): synthetic traffic from random public IPs of the
// loaded ipdb, run through the real signals + rules (dry run: no rate limiter keys), stored as ShieldEvent rows back-dated
// over the last H hours and, with tvine.admin, as admin_stat rollups (its own Collector on a fake clock, node 'sim-…').
// Every row has host simulated.tvine (filter `host neq simulated.tvine` to hide it); --clear deletes rows + rollups.
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Settings } from '../../core/types.js'
import { ipdb, loadIpdb, rangesSeed, setRanges } from './data.js'
import { decide } from './engine.js'
import { eventRow, statOf } from './events.js'
import { ShieldEvent } from './models.js'
import { collectSignals, resolver } from './signals.js'
import { loadAll } from './store.js'

export const SIM_HOST = 'simulated.tvine'
const COMMON = 'US CN DE GB FR IN BR JP CA RU NL KR AU IT ES SE PL PK ID TR MX VN SG UA ZA'.split(' ')
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!
const BROWSERS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
]
const BOTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'curl/8.7.1', 'python-requests/2.32.3',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
  'sqlmap/1.8.9#stable (https://sqlmap.org)',
]
const PATHS = ['/', '/', '/', '/products', '/products/linen-shirt', '/products/oak-table', '/products/ceramic-mug', '/cart', '/checkout', '/search', '/api/products', '/api/cart', '/wp-login.php', '/.env', '/admin/login']
const POSTS = new Set(['/checkout', '/api/cart', '/wp-login.php'])

const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
// country → its v4 range indexes in the ipdb (DB-IP never lists private ranges: they are ZZ, skipped at load)
function ipPicker(): () => string {
  const by = new Map<string, number[]>()
  ipdb.country.v4.forEach((c, i) => { let l = by.get(c); if (!l) by.set(c, (l = [])); l.push(i) })
  const common = COMMON.filter((c) => by.has(c)), all = [...by.keys()]
  return () => {
    const c = common.length && Math.random() < 0.75 ? pick(common) : pick(all)
    const i = pick(by.get(c)!), s = ipdb.country.s4[i]!, e = ipdb.country.e4[i]!
    return dotted(s + Math.floor(Math.random() * (e - s + 1)))
  }
}

export async function simulate(settings: Settings, o: { count?: number; hours?: number; clear?: boolean }): Promise<string> {
  const admin = settings.installedApps.includes('tvine.admin')
  if (o.clear) {
    const n = await ShieldEvent.objects.filter({ host: SIM_HOST }).delete()   // scope: ok (dev command)
    let r = 0
    if (admin) { const { AdminStat } = await import('../admin/models.js'); r = await AdminStat.objects.filter({ node__startswith: 'sim-' }).delete() }   // scope: ok
    return `deleted ${n} simulated event(s)${admin ? ` and ${r} simulated rollup row(s)` : ''}`
  }
  if (!settings.debug) throw new Error('refusing: settings.debug is false. simulate writes fake traffic into the shield tables; run it on a dev database (TVINE_DEBUG=1)')
  const count = o.count ?? 300, hours = o.hours ?? 24
  if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error('--count: 1..100000')
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new Error('--hours: up to 2160 (90 days)')
  if (!ipdb.country.v4.length) await loadIpdb(resolve(settings.shield.ipdb.dir))
  if (!ipdb.country.v4.length) throw new Error(`no ipdb in ${settings.shield.ipdb.dir}: run the shield.ipdb_update task (or "update now" in /shield Settings) first`)
  setRanges(rangesSeed())
  await loadAll(settings)
  const nextIp = ipPicker(), now = Date.now(), storeIp = settings.shield.events.storeIp
  const times = Array.from({ length: count }, () => now - Math.floor(Math.random() * hours * 3_600_000)).sort((a, b) => a - b)
  let clock = now
  const col = admin ? new (await import('../admin/stats.js')).Collector({ slowMs: 100, retentionDays: settings.admin.stats.retentionDays, now: () => clock }) : undefined
  if (col) (col as { node: string }).node = `sim-${randomBytes(5).toString('hex')}`
  const real = resolver.r
  resolver.r = { reverse: async () => [], lookup: async () => [] }   // no DNS for fake IPs: a bot UA from one is unverified (spoofed)
  const rows: Record<string, unknown>[] = [], by = new Map<string, number>()
  try {
    for (const ts of times) {
      const ua = Math.random() < 0.7 ? pick(BROWSERS) : pick(BOTS), path = pick(PATHS), browser = BROWSERS.includes(ua)
      const ver = /Chrome\/(\d+)/.exec(ua)?.[1]
      const h: Record<string, string> = browser
        ? { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, br', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...(ver && { 'sec-ch-ua': `"Chromium";v="${ver}", "Google Chrome";v="${ver}"` }) }
        : { 'user-agent': ua, accept: '*/*' }
      const s = await collectSignals({ ip: nextIp(), method: POSTS.has(path) && Math.random() < 0.5 ? 'POST' : 'GET', path, host: SIM_HOST, secure: true, header: (n) => h[n], count: false,
        ...(browser && Math.random() < 0.8 && { clearance: { valid: true, level: 'pow' as const, score: 80 } }) })   // most browsers already solved one
      const { decision: d } = await decide(s, { settings, ray: randomBytes(8).toString('hex'), headers: h, dryRun: true })
      rows.push({ ...eventRow(s, d, d.action, storeIp), ts: new Date(ts) })
      by.set(s.country ?? '?', (by.get(s.country ?? '?') ?? 0) + 1)
      clock = ts
      col?.record(statOf(s, d, d.action))
    }
  } finally { resolver.r = real }
  await ShieldEvent.objects.bulkCreate(rows, { batchSize: 200 })
  clock = now
  await col?.flush()
  const decisions = new Map<string, number>()
  for (const r of rows) decisions.set(String(r.decision), (decisions.get(String(r.decision)) ?? 0) + 1)
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c} ${n}`).join(', ')
  return [`simulated ${count} request(s) over the last ${hours} h from ${by.size} countries (host ${SIM_HOST})`,
    `  decisions: ${[...decisions].map(([k, n]) => `${k} ${n}`).join(', ')}`, `  top countries: ${top}`,
    admin ? '  rollups: written (unfiltered /shield analytics includes them)' : '  rollups: tvine.admin not installed, events only',
    `  undo: tvine shield simulate --clear`].join('\n')
}
