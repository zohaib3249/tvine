// tvine.shield panel actions (contract §Panel actions). Every one: logged in + staffGuard (settings.admin hardening:
// allowIps / require2fa / idleMs) + the panel access condition (default superuser only) on the user row. Writes are
// audited (non-readOnly actions go through tvine.audit when it is on) and bump the rules version (hot reload).
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, Permission, Settings, TvineUser } from '../../core/types.js'
import { staffGuard } from '../admin/hardening.js'
import { conditionProblem, evaluate } from './conditions.js'
import { asnKind, botCatalog, ipdb, isTor, lookupIp, rangesStatus } from './data.js'
import { botRule, botRuleId, customRules, decide, ruleContext, runtimeOf, state, LEVELS } from './engine.js'
import { ShieldConfig, ShieldEvent, ShieldList, ShieldRule } from './models.js'
import { collectSignals, ipNetOf, scoreParts } from './signals.js'
import { changed, ruleProblem, saveConfig, toRule } from './store.js'
import { pruneEvents, updateIpdb } from './tasks.js'
import type { BotCategory, Condition } from './types.js'
import { counters, ipHash } from './events.js'

// the user row the access condition sees: the user's own fields + groups (names)
export async function userRow(u: TvineUser): Promise<Record<string, unknown>> {
  const g = (u as { groups?: () => Promise<string[]> }).groups
  const groups = typeof g === 'function' ? await g.call(u) : []
  return { ...Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v !== 'function')), groups }
}
export async function panelAllowed(u: TvineUser, settings: Settings): Promise<boolean> {
  if (!u.isAuthenticated || u.isActive === false) return false
  return evaluate(runtimeOf(settings).access, await userRow(u))
}
// one guard for every shield.* action: staff hardening + the access condition; refused = DomainError 'forbidden'
const access: Permission = async (ctx) => {
  const { loadedSettings } = await import('../../security/signing.js')
  if (!(await staffGuard(ctx)) || !(await panelAllowed(ctx.user, loadedSettings() as Settings))) throw new DomainError('forbidden', 'forbidden: the Shield panel access condition does not include you')
  return true
}
const read = { permissions: [access], readOnly: true, mcp: false }
const write = { permissions: [access], mcp: false }
const bad = (msg: string, param?: string) => new DomainError('invalid_param', msg, param)

// ---- overview (admin_stat rollups, never a ShieldEvent scan) + events ------------------------------------------------
type StatRow = { bucket: Date; key: string; dims: Record<string, string>; count: number; sum: number }
const SERIES = [{ name: 'pass', label: 'Passed' }, { name: 'log', label: 'Logged' }, { name: 'challenge', label: 'Challenged' }, { name: 'block', label: 'Blocked' }]
const bucketOf = (d: string) => (d === 'block' || d === 'rateLimit' || d === 'challenge-failed' ? 3 : d === 'challenge' ? 2 : d === 'log' ? 1 : 0)
const topOfRows = (rows: StatRow[], dim: string, n = 10, label?: (k: string) => string | undefined) => {
  const m = new Map<string, number>()
  for (const r of rows) { const k = r.dims[dim]; if (k && k !== '(other)') m.set(k, (m.get(k) ?? 0) + r.count) }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count, ...(label?.(key) && { label: label(key) }) }))
}
function totals(rows: StatRow[]) {
  let requests = 0, blocked = 0, challenged = 0, passed = 0, failed = 0, sum = 0
  for (const r of rows) {
    const d = r.dims.d ?? 'pass', blk = bucketOf(d) === 3 || (r.dims.m === 'log' && d !== 'pass' && d !== 'allow' && d !== 'log')
    requests += r.count; sum += r.sum
    if (blk && d !== 'challenge') blocked += r.count
    if (d === 'challenge') challenged += r.count
    if (d === 'challenge-passed') passed += r.count
    if (d === 'challenge-failed') failed += r.count
  }
  return { requests, blocked, challenged, passRate: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 10 : 0, avgScore: requests ? Math.round(sum / requests) : 0 }
}
export const overview = defineAction('shield.overview', z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h') }), async ({ range }, ctx) => {
  if (!ctx.settings.installedApps.includes('tvine.admin')) return { totals: totals([]), series: { series: SERIES, points: [] }, top: { ips: [], asns: [], countries: [], bots: [] }, histogram: Array(10).fill(0), note: "charts need 'tvine.admin' installed (its hourly rollups)" }
  const { statRows } = await import('../admin/system.js')
  const span = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[range]
  const now = Date.now()
  const get = async (key: string, from: number, to: number) => (await statRows(key, { from: new Date(from).toISOString(), to: new Date(to).toISOString() })).rows as StatRow[]
  const main = await get('shield', now - span, now), prev = await get('shield', now - 2 * span, now - span)
  // display bucket: the configured stats.bucket, coarsened so a range shows at most ~200 points
  const BUCKET = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 } as const
  const step = [60_000, 300_000, 900_000, 3_600_000, 86_400_000].find((b) => b >= BUCKET[runtimeOf(ctx.settings).stats.bucket] && span / b <= 200) ?? 86_400_000
  const buckets = new Map<number, number[]>()
  for (const r of main) {
    const x = Math.floor(+new Date(r.bucket) / step) * step
    const v = buckets.get(x) ?? [0, 0, 0, 0]
    v[r.dims.m === 'log' && r.dims.d !== 'pass' && r.dims.d !== 'allow' ? 1 : bucketOf(r.dims.d ?? 'pass')]! += r.count
    buckets.set(x, v)
  }
  const hist = Array(10).fill(0) as number[]
  for (const r of await get('shield_score', now - span, now)) hist[Number(r.dims.b) || 0]! += r.count
  const asns = await get('shield_asn', now - span, now), countries = await get('shield_country', now - span, now)
  return {
    totals: { ...totals(main), previous: totals(prev) },
    series: { groupBy: step >= 86_400_000 ? 'day' : 'hour', series: SERIES, points: [...buckets].sort((a, b) => a[0] - b[0]).map(([x, values]) => ({ x: new Date(x).toISOString(), values })) },
    // rollups hold no ips (owner policy): the top-ip list comes from the sampled event rows of the range
    top: { ips: await topNotable(now - span, 'ipNet'), asns: topOfRows(asns, 'a', 10, (k) => ipdb.orgs.get(Number(k))).map((c) => ({ ...c, key: `AS${c.key}` })), countries: topOfRows(countries, 'g'), bots: await topNotable(now - span, 'botName') },
    histogram: hist,
  }
}, read)
// rollups hold no ips / bot names: the top lists of the blocked requests come from the event rows of the range
async function topNotable(since: number, col: 'ipNet' | 'botName') {
  const rows = await ShieldEvent.objects.filter({ ts__gte: new Date(since), decision__in: ['block', 'rateLimit', 'would-block', 'would-rateLimit'] }).order('-ts').limit(5000).valuesList(col, { flat: true }).all() as (string | null)[]   // scope: ok (indexed, capped)
  const m = new Map<string, number>()
  for (const k of rows) if (k) m.set(k, (m.get(k) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count }))
}

// ---- analytics: Cloudflare-style security analytics (rollups when unfiltered = exact, else the stored events) ---------
const H = 3_600_000, D = 24 * H, CAP = 50_000
const SPAN = { '1h': H, '24h': D, '7d': 7 * D, '30d': 30 * D } as const
const STEP = { minute: 60_000, hour: H, day: D } as const
const FIELDS = ['decision', 'country', 'asn', 'botCategory', 'botName', 'path', 'method', 'ipNet', 'ruleId', 'uaFamily', 'status', 'mode', 'tlsJa4', 'host'] as const
const filterIn = z.object({ field: z.enum(FIELDS), op: z.enum(['eq', 'neq']), value: z.string().max(500) })
const filtersIn = z.array(filterIn).max(20).default([])
type Filter = z.infer<typeof filterIn>
const isoIn = z.string().datetime({ offset: true }).optional()
type QS = ReturnType<typeof ShieldEvent.objects.filter>
// one filter → one ORM condition ('path' eq = startsWith, 'ipNet' given a plain ip = that exact ip by its hash, 'mode' log = would-*)
function applyFilters(qs: QS, filters: Filter[]): QS {
  for (const f of filters) {
    const v = f.value.trim()
    let op = f.op, w: Record<string, unknown>
    const num = (x: string) => { const n = Number(x); if (!Number.isInteger(n)) throw bad(`filters: ${f.field} takes a number`, 'filters'); return n }
    switch (f.field) {
      case 'path': w = { path__startswith: v }; break
      case 'country': w = { country: v.toUpperCase() }; break
      case 'method': w = { method: v.toUpperCase() }; break
      case 'asn': w = { asn: num(v.replace(/^AS/i, '')) }; break
      case 'status': w = { status: num(v) }; break
      case 'ipNet': w = v.includes('/') ? { ipNet: v } : { ipHash: ipHash(v) }; break
      case 'mode': w = { decision__startswith: 'would-' }; if (v !== 'log') op = op === 'eq' ? 'neq' : 'eq'; break
      default: w = { [f.field]: v }
    }
    qs = op === 'eq' ? qs.filter(w) : qs.exclude(w)
  }
  return qs
}
function windowOf(p: { range: keyof typeof SPAN; from?: string; to?: string }) {
  const custom = !!(p.from || p.to)
  const to = p.to ? new Date(p.to) : new Date(), from = p.from ? new Date(p.from) : new Date(+to - SPAN[p.range])
  if (!(from < to)) throw bad('from must be before to', 'from')
  if (+to - +from > 90 * D) throw bad('a custom range is at most 90 days', 'from')
  const span = +to - +from
  return { from, to, span, custom, step: (span <= 3 * H ? 'minute' : span <= 3 * D ? 'hour' : 'day') as keyof typeof STEP }
}
type Row = { ts: Date; ip?: string | null; ipNet: string; country?: string | null; asn?: number | null; asnOrg?: string | null; botName?: string | null; botCategory: string; path: string; method: string; ruleId?: string | null; uaFamily?: string | null; status?: number | null; tlsJa4?: string | null; host: string; decision: string; score: number; solveMs?: number | null }
const SCAN_COLS = ['ts', 'ip', 'ipNet', 'country', 'asn', 'asnOrg', 'botName', 'botCategory', 'path', 'method', 'ruleId', 'uaFamily', 'status', 'tlsJa4', 'host', 'decision', 'score', 'solveMs']
async function scan(from: Date, to: Date, filters: Filter[]): Promise<{ rows: Row[]; capped: boolean }> {
  const rows = await applyFilters(ShieldEvent.objects.filter({ ts__gte: from, ts__lt: to }), filters).order('-ts').limit(CAP + 1).values(...SCAN_COLS).all() as Row[]   // scope: ok (indexed ts, capped)
  return { rows: rows.slice(0, CAP), capped: rows.length > CAP }
}
const SERVED = new Set(['pass', 'allow', 'log']), MIT = new Set(['block', 'challenge', 'rateLimit'])
const DEC = ['pass', 'allow', 'log', 'challenge', 'block', 'rateLimit']
const DEC_SERIES = [{ name: 'pass', label: 'Passed' }, { name: 'allow', label: 'Allowed' }, { name: 'log', label: 'Logged' }, { name: 'challenge', label: 'Challenged' }, { name: 'block', label: 'Blocked' }, { name: 'rateLimit', label: 'Rate limited' }]
// a stored decision → the decision + whether it ran in log mode ('would-block' in events, d:'block' m:'log' in rollups)
const normDec = (d: string, m?: string) => (d.startsWith('would-') ? { d: d.slice(6), log: true } : { d, log: m === 'log' && !SERVED.has(d) && !d.startsWith('challenge-') })
const isMit = (d: string, log: boolean) => !log && MIT.has(d)
const KEYS = ['requests', 'served', 'mitigated', 'blocked', 'challenged', 'rateLimited', 'solved', 'failed', 'logged'] as const
type Totals = Record<(typeof KEYS)[number], number>
function countInto(t: Totals, d: string, log: boolean, n: number) {
  t.requests += n
  if (d === 'challenge-passed') t.solved += n
  else if (d === 'challenge-failed') t.failed += n
  else if (log || SERVED.has(d)) { t.served += n; if (log || d === 'log') t.logged += n }
  else if (MIT.has(d)) { t.mitigated += n; t[d === 'block' ? 'blocked' : d === 'challenge' ? 'challenged' : 'rateLimited'] += n }
}
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0])) as Totals
const finish = (t: Totals, scoreSum: number) => ({ ...Object.fromEntries(KEYS.map((k) => [k, Math.round(t[k])])) as Totals, avgScore: t.requests ? Math.round(scoreSum / t.requests) : 0 })
type Tally = Map<string, [number, number]>
const bump = (m: Tally, k: unknown, n: number, mit: boolean) => {
  if (k === null || k === undefined || k === '' || k === '(other)') return
  const v = m.get(String(k)) ?? [0, 0]
  v[0] += n; if (mit) v[1] += n
  m.set(String(k), v)
}
const topOf = (m: Tally, label?: (k: string) => string | undefined, key = (k: string) => k) =>
  [...m].sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(([k, [count, mitigated]]) => ({ key: key(k), ...(label?.(k) && { label: label(k) }), count: Math.round(count), mitigated: Math.round(mitigated) }))
const TOPS = { countries: 'country', asns: 'asn', paths: 'path', ips: 'ip', bots: 'botName', botCategories: 'botCategory', rules: 'ruleId', methods: 'method', uaFamilies: 'uaFamily', statuses: 'status', ja4: 'tlsJa4', hosts: 'host' } as const
type TopName = keyof typeof TOPS
const tallies = () => Object.fromEntries(Object.keys(TOPS).map((k) => [k, new Map()])) as Record<TopName, Tally>
function timeline(from: Date, to: Date, step: keyof typeof STEP) {
  const ms = STEP[step], x0 = Math.floor(+from / ms) * ms, n = Math.max(1, Math.ceil((+to - x0) / ms))
  const sm = Array.from({ length: n }, () => [0, 0]), dec = Array.from({ length: n }, () => DEC.map(() => 0))
  return {
    add(t: number, d: string, log: boolean, w: number) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((t - x0) / ms)))
      if (log || SERVED.has(d)) sm[i]![0]! += w; else if (MIT.has(d)) sm[i]![1]! += w
      const j = log ? 2 : DEC.indexOf(d)
      if (j >= 0) dec[i]![j]! += w
    },
    out: () => {
      const pts = (a: number[][]) => a.map((values, i) => ({ x: new Date(x0 + i * ms).toISOString(), values: values.map(Math.round) }))
      return { series: { groupBy: step, unit: 'count', series: [{ name: 'served', label: 'Served' }, { name: 'mitigated', label: 'Mitigated' }], points: pts(sm) }, decisions: { groupBy: step, unit: 'count', series: DEC_SERIES, points: pts(dec) } }
    },
  }
}
// the event rows → totals, histogram, top-N tallies, solve times; passes weigh 1/samplePass (they were sampled)
function digest(rows: Row[], weight: (d: string) => number, tl?: ReturnType<typeof timeline>) {
  const t = zero(), hist = Array(10).fill(0) as number[], tally = tallies(), solve: number[] = [], orgs = new Map<string, string>()
  let scoreSum = 0
  for (const r of rows) {
    const { d, log } = normDec(r.decision), w = weight(r.decision), mit = isMit(d, log)
    countInto(t, d, log, w); scoreSum += r.score * w
    hist[Math.min(9, Math.max(0, Math.floor(r.score / 10)))]! += w
    tl?.add(+new Date(r.ts), d, log, w)
    for (const [k, col] of Object.entries(TOPS) as [TopName, keyof Row][]) bump(tally[k], k === 'ips' ? (r.ip ?? r.ipNet) : r[col], w, mit)
    if (r.asn && r.asnOrg) orgs.set(String(r.asn), r.asnOrg)
    if (d === 'challenge-passed' && typeof r.solveMs === 'number') solve.push(r.solveMs)
  }
  return { totals: finish(t, scoreSum), hist: hist.map(Math.round), tally, solve, orgs }
}
const quantile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]! }
const weightOf = (settings: Settings) => {
  const ev = runtimeOf(settings).events, rate = ev.logAll ? 1 : ev.samplePass
  return { rate, weight: (d: string) => ((d === 'pass' || d === 'allow') && rate > 0 && rate < 1 ? 1 / rate : 1) }
}
const hasRollups = (s: Settings) => s.installedApps.includes('tvine.admin')
async function rollups(key: string, from: Date, to: Date, minute: boolean): Promise<StatRow[]> {
  const { statRows } = await import('../admin/system.js')
  return (await statRows(key, minute ? '1h' : { from: from.toISOString(), to: to.toISOString() })).rows as StatRow[]
}

export const analytics = defineAction('shield.analytics', z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h'), from: isoIn, to: isoIn, filters: filtersIn }), async (p, ctx) => {
  const w = windowOf(p), prevFrom = new Date(+w.from - w.span)
  const { rate, weight } = weightOf(ctx.settings)
  const source = !p.filters.length && hasRollups(ctx.settings) ? 'rollups' : 'events'
  const tl = timeline(w.from, w.to, w.step)
  const cur = await scan(w.from, w.to, p.filters)
  const ev = digest(cur.rows, weight, source === 'events' ? tl : undefined)
  let totals = ev.totals, previous: Totals & { avgScore: number }, hist = ev.hist, tally = ev.tally
  if (source === 'events') previous = digest((await scan(prevFrom, w.from, p.filters)).rows, weight).totals
  else {
    const minute = p.range === '1h' && !w.custom
    const sum = (rows: StatRow[], into?: ReturnType<typeof timeline>, cats?: Tally) => {
      const t = zero(); let s = 0
      for (const r of rows) {
        const { d, log } = normDec(r.dims.d ?? 'pass', r.dims.m)
        countInto(t, d, log, r.count); s += r.sum
        into?.add(+new Date(r.bucket), d, log, r.count)
        if (cats) bump(cats, r.dims.c, r.count, isMit(d, log))
      }
      return finish(t, s)
    }
    const roll = tallies()
    totals = sum(await rollups('shield', w.from, w.to, minute), tl, roll.botCategories)
    previous = sum(await rollups('shield', prevFrom, w.from, false))
    hist = Array(10).fill(0) as number[]
    for (const r of await rollups('shield_score', w.from, w.to, minute)) hist[Math.min(9, Number(r.dims.b) || 0)]! += r.count
    // the country / asn / rule rollups carry the decision but not the mode (a log-mode block counts as mitigated)
    for (const [k, key, dim] of [['countries', 'shield_country', 'g'], ['asns', 'shield_asn', 'a'], ['rules', 'shield_rule', 'r']] as const)
      for (const r of await rollups(key, w.from, w.to, minute)) bump(roll[k], r.dims[dim], r.count, MIT.has(r.dims.d ?? ''))
    tally = { ...ev.tally, countries: roll.countries, asns: roll.asns, rules: roll.rules, botCategories: roll.botCategories }
  }
  const names = new Map(state.rules.map((r) => [r.id, r.name]))
  const top = Object.fromEntries((Object.keys(TOPS) as TopName[]).map((k) => [k,
    k === 'asns' ? topOf(tally.asns, (a) => ipdb.orgs.get(Number(a)) ?? ev.orgs.get(a), (a) => `AS${a}`)
    : k === 'rules' ? topOf(tally.rules, (r) => names.get(r)) : topOf(tally[k])])) as Record<TopName, ReturnType<typeof topOf>>
  return {
    range: { from: w.from.toISOString(), to: w.to.toISOString(), step: w.step },
    source, sampled: cur.capped || (source === 'events' && rate < 1), sampleRate: rate,
    totals: { ...totals, previous },
    ...tl.out(),
    histogram: hist,
    funnel: { issued: totals.challenged, solved: totals.solved, failed: totals.failed, solveMsP50: quantile(ev.solve, 0.5), solveMsP95: quantile(ev.solve, 0.95) },
    geo: [...tally.countries].sort((a, b) => b[1][0] - a[1][0]).map(([country, [requests, mitigated]]) => ({ country, requests: Math.round(requests), mitigated: Math.round(mitigated) })),
    top,
  }
}, read)

type Ev = Record<string, unknown> & { ts: Date; ray: string; path: string; score: number; decision: string }
const eventRow = (r: Ev) => ({ ts: new Date(r.ts).toISOString(), ray: r.ray, ...(r.ip ? { ip: r.ip as string } : { ip: r.ipNet as string }), ...(r.country ? { country: r.country } : {}), ...(r.asn ? { asn: r.asn } : {}), ...(r.asnOrg ? { asnOrg: r.asnOrg } : {}),
  path: r.path, method: r.method, host: r.host, ua: r.ua, ...(r.uaFamily ? { uaFamily: r.uaFamily } : {}), ...(r.botName ? { bot: r.botName } : {}), botCategory: r.botCategory, score: r.score, decision: r.decision,
  mode: String(r.decision).startsWith('would-') ? 'log' : 'enforce', ...(r.ruleId ? { ruleId: r.ruleId } : {}), ...(r.status ? { status: r.status } : {}), ...(r.level ? { level: r.level } : {}), reason: r.reason })
export const events = defineAction('shield.events', z.object({ filters: filtersIn, from: isoIn, to: isoIn, page: z.number().int().min(1).max(10_000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }), async ({ filters, from, to, page, pageSize }) => {
  const qs = applyFilters(ShieldEvent.objects.filter({ ...(from && { ts__gte: new Date(from) }), ...(to && { ts__lt: new Date(to) }) }), filters)   // scope: ok
  const count = await qs.count()
  return { rows: (await qs.order('-ts').offset((page - 1) * pageSize).limit(pageSize).all() as Ev[]).map(eventRow), count, page, pages: Math.max(1, Math.ceil(count / pageSize)) }
}, read)
// a stored row as Signals (what was kept: no headers, no rate counters, no clearance)
const signalsOf = (r: Ev) => ({ ip: (r.ip ?? r.ipNet) as string, ipNet: r.ipNet as string, country: r.country, asn: r.asn, asnOrg: r.asnOrg, asnKind: r.asnKind, tor: false, ua: r.ua as string, uaFamily: r.uaFamily,
  bot: { name: r.botName, category: r.botCategory, verified: r.botVerified, spoofed: r.spoofed, via: r.botVia }, headerScore: r.headerScore, ...(r.tlsJa4 ? { tls: { ja4: r.tlsJa4 } } : {}),
  path: r.path, method: r.method as string, host: r.host, rate: { ip: 0, asn: 0, path: 0 }, score: r.score })
// the stored row, its decision and its signals as stored (no header list is kept: owner data policy)
export const event = defineAction('shield.event', z.object({ ray: z.string().min(1).max(128) }), async ({ ray }) => {
  const r = await ShieldEvent.objects.filter({ ray }).order('-ts').first() as Ev | undefined   // scope: ok
  if (!r) throw new DomainError('not_found', `no shield event with ray ${ray}`)
  const decision = { action: String(r.decision).replace(/^would-/, ''), ...(r.ruleId ? { ruleId: r.ruleId } : {}), ...(r.level ? { level: r.level } : {}), ...(r.status ? { status: r.status } : {}), reason: r.reason, mode: String(r.decision).startsWith('would-') ? 'log' : 'enforce', score: r.score, ray: r.ray, ms: 0 }
  return { event: { ...eventRow(r), ...(r.outcome ? { outcome: r.outcome, solveMs: r.solveMs, sensorFlags: r.sensorFlags } : {}) }, signals: signalsOf(r), decision }
}, read)

// ---- one ip (or ipNet / cidr): where it is, the lists that cover it, its last 30 days, what a browser from it gets now --
export const ip = defineAction('shield.ip', z.object({ ip: z.string().min(2).max(64) }), async ({ ip: input }, ctx) => {
  const v = input.trim()
  if (conditionProblem({ field: 'ip', op: 'cidr', value: v })) throw bad(`"${v}" is not an IP or CIDR`, 'ip')
  const addr = v.split('/')[0]!, ipNet = v.includes('/') ? v : ipNetOf(v)
  const geo = lookupIp(addr), kind = geo.asn ? asnKind(geo.asn, geo.asnOrg) : undefined
  const lists = (await ShieldList.objects.order('id').all() as ListRow[]).filter((r) =>   // scope: ok
    r.kind === 'ip' || r.kind === 'cidr' ? evaluate({ field: 'ip', op: 'cidr', value: r.value }, { ip: addr }) : r.kind === 'country' ? r.value === geo.country : Number(r.value) === geo.asn)
    .map((r) => ({ kind: r.kind, value: r.value, list: r.list, id: String(r.id) }))
  const mine = () => ShieldEvent.objects.filter(v.includes('/') ? { ipNet: v } : { ipHash: ipHash(v) })   // scope: ok
  const decisions = await mine().filter({ ts__gte: new Date(Date.now() - 30 * D) }).order('-ts').limit(CAP).valuesList('decision', { flat: true }).all() as string[]
  const byDecision: Record<string, number> = {}
  let mitigated = 0
  for (const d of decisions) { byDecision[d] = (byDecision[d] ?? 0) + 1; const n = normDec(d); if (isMit(n.d, n.log)) mitigated++ }
  const first = await mine().order('ts').first() as Ev | undefined, last = await mine().order('-ts').first() as Ev | undefined
  const h: Record<string, string> = { 'user-agent': CHROME_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, deflate, br' }
  const signals = await collectSignals({ ip: addr, method: 'GET', path: '/', host: 'localhost', secure: true, header: (n) => h[n], count: false })
  const { decision } = await decide(signals, { settings: ctx.settings, ray: 'test', headers: h, dryRun: true })
  return {
    ip: addr, ipNet, ...(geo.country && { country: geo.country }), ...(geo.asn && { asn: geo.asn }), ...(geo.asnOrg && { asnOrg: geo.asnOrg }), ...(kind && { asnKind: kind }), tor: isTor(addr),
    lists, counts: { requests: decisions.length, mitigated, byDecision },
    ...(first && { firstSeen: new Date(first.ts).toISOString() }), ...(last && { lastSeen: new Date(last.ts).toISOString() }),
    recent: (await mine().order('-ts').limit(50).all() as Ev[]).map(eventRow),
    test: { action: decision.action, reason: decision.reason, ...(decision.ruleId && { ruleId: decision.ruleId }), score: decision.score },
  }
}, read)
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// ---- rules ------------------------------------------------------------------------------------------------------------
const ruleIn = z.object({ id: z.string().max(64).optional().or(z.literal('')).transform((v) => v || undefined), name: z.string(), enabled: z.boolean().default(true), order: z.number().int().optional(), when: z.unknown(), then: z.unknown(), ttl: z.string().max(10).optional() })
const allRules = async () => (await ShieldRule.objects.order('order').all()).map((r) => toRule(r as never))   // scope: ok
// each rule + its hits per hour over the last 24 h (the rule rollup when tvine.admin is on, else the event rows)
export const rulesList = defineAction('shield.rules.list', z.object({}), async (_p, ctx) => {
  const start = Math.floor(Date.now() / H) * H - 23 * H, spark = new Map<string, number[]>()
  const add = (rid: unknown, t: number, n: number) => { if (typeof rid !== 'string' || !rid) return; const a = spark.get(rid) ?? Array(24).fill(0) as number[]; const i = Math.floor((t - start) / H); if (i >= 0 && i < 24) a[i]! += n; spark.set(rid, a) }
  if (hasRollups(ctx.settings)) for (const r of await rollups('shield_rule', new Date(start), new Date(), false)) add(r.dims.r, +new Date(r.bucket), r.count)
  else {
    const { weight } = weightOf(ctx.settings)
    for (const r of await ShieldEvent.objects.filter({ ts__gte: new Date(start) }).order('-ts').limit(CAP).values('ruleId', 'ts', 'decision').all() as Row[]) add(r.ruleId, +new Date(r.ts), weight(r.decision))   // scope: ok (indexed ts, capped)
  }
  return (await allRules()).map((r) => { const a = (spark.get(r.id) ?? Array(24).fill(0) as number[]).map(Math.round); return { ...r, spark: a, hits24h: a.reduce((x, y) => x + y, 0) } })
}, read)
// how many stored events of the last sinceHours a condition matches (their stored signals; no headers / rate / clearance)
export const rulesPreview = defineAction('shield.rules.preview', z.object({ when: z.unknown(), sinceHours: z.number().int().min(1).max(168).default(24) }), async ({ when, sinceHours }) => {
  const problem = conditionProblem(when)
  if (problem) throw bad(`when: ${problem}`, 'when')
  const rows = await ShieldEvent.objects.filter({ ts__gte: new Date(Date.now() - sinceHours * H) }).order('-ts').limit(CAP).all() as Ev[]   // scope: ok (indexed ts, capped)
  let matched = 0
  const sample: ReturnType<typeof eventRow>[] = []
  for (const r of rows) {
    const s = signalsOf(r)
    if (!evaluate(when as Condition, ruleContext({ ...s, ip: s.ip.split('/')[0]! } as never))) continue
    matched++
    if (sample.length < 10) sample.push(eventRow(r))
  }
  return { matched, scanned: rows.length, sample }
}, read)
export const rulesSave = defineAction('shield.rules.save', z.object({ rule: ruleIn }), async ({ rule }, ctx) => {
  const problem = ruleProblem(rule as never)
  if (problem) throw bad(problem, 'rule')
  const existing = rule.id ? await ShieldRule.objects.filter({ rid: rule.id }).first() as { id: number; order: number } | undefined : undefined   // scope: ok
  const order = rule.order ?? existing?.order ?? ((await ShieldRule.objects.order('-order').first() as { order: number } | undefined)?.order ?? 0) + 10
  const data = { name: rule.name.trim(), enabled: rule.enabled, order, when: rule.when, then: rule.then, ttl: rule.ttl ?? null }
  const rid = rule.id ?? `r_${randomBytes(6).toString('hex')}`
  if (existing) await ShieldRule.update(existing.id, data as never)
  else await ShieldRule.create({ ...data, rid } as never)
  await changed(ctx.settings)
  return (await allRules()).find((r) => r.id === rid) ?? null
}, write)
export const rulesDelete = defineAction('shield.rules.delete', z.object({ id: z.string().max(64) }), async ({ id }, ctx) => {
  const n = await ShieldRule.objects.filter({ rid: id }).delete()
  if (!n) throw new DomainError('not_found', `no rule ${id}`)
  await changed(ctx.settings)
  return null
}, write)
export const rulesReorder = defineAction('shield.rules.reorder', z.object({ ids: z.array(z.string().max(64)).max(1000) }), async ({ ids }, ctx) => {
  for (const [i, rid] of ids.entries()) await ShieldRule.objects.filter({ rid }).update({ order: (i + 1) * 10 })
  await changed(ctx.settings)
  return allRules()
}, write)
export const rulesReset = defineAction('shield.rules.reset', z.object({}), async (_p, ctx) => {
  await ShieldRule.objects.delete()
  await changed(ctx.settings)   // an empty table re-seeds the defaults
  return allRules()
}, write)
export const customRulesList = defineAction('shield.customRules', z.object({}), async () => [...customRules.keys()], read)

// ---- lists ------------------------------------------------------------------------------------------------------------
type ListRow = { id: number; kind: string; value: string; list: string; note?: string | null }
const allLists = async () => (await ShieldList.objects.order('id').all() as ListRow[]).map((r) => ({ id: String(r.id), kind: r.kind, value: r.value, list: r.list, ...(r.note && { note: r.note }) }))   // scope: ok
export const listsList = defineAction('shield.lists.list', z.object({}), async () => allLists(), read)
const listIn = z.object({ kind: z.enum(['ip', 'cidr', 'country', 'asn']), value: z.string().min(1).max(64), list: z.enum(['allow', 'deny']), note: z.string().max(200).optional() })
export const listsSave = defineAction('shield.lists.save', z.object({ entries: z.array(listIn).min(1).max(5000) }), async ({ entries }, ctx) => {
  const rows = entries.map((p, i) => {
    const v = p.value.trim()
    if ((p.kind === 'ip' || p.kind === 'cidr') && conditionProblem({ field: 'ip', op: 'cidr', value: v })) throw bad(`entries[${i}]: "${v}" is not an IP or CIDR`, 'entries')
    if (p.kind === 'country' && !/^[A-Za-z]{2}$/.test(v)) throw bad(`entries[${i}]: a 2-letter country code`, 'entries')
    if (p.kind === 'asn' && !/^(AS)?\d{1,10}$/i.test(v)) throw bad(`entries[${i}]: an AS number (AS13335 or 13335)`, 'entries')
    return { kind: p.kind, value: p.kind === 'country' ? v.toUpperCase() : p.kind === 'asn' ? v.replace(/^AS/i, '') : v, list: p.list, note: p.note ?? null }
  })
  await ShieldList.objects.bulkCreate(rows)
  await changed(ctx.settings)
  return allLists()
}, write)
export const listsDelete = defineAction('shield.lists.delete', z.object({ id: z.union([z.string(), z.number()]) }), async ({ id }, ctx) => {
  await ShieldList.objects.filter({ id: Number(id) }).delete()
  await changed(ctx.settings)
  return null
}, write)

// ---- bots ------------------------------------------------------------------------------------------------------------
const CATEGORIES: BotCategory[] = ['search', 'ai-crawler', 'ai-agent', 'monitor', 'seo', 'scraper', 'scanner', 'automation', 'browser', 'unknown']
export const bots = defineAction('shield.bots', z.object({}), async () => {
  return botsView()
}, read)
function botsView() {
  const stances: Partial<Record<BotCategory, string>> = {}
  for (const c of CATEGORIES) {
    const r = state.rules.find((x) => x.id === botRuleId(c) && x.enabled)
    if (r && ['allow', 'block', 'challenge'].includes(r.then.type)) stances[c] = r.then.type
  }
  const seen = new Set<string>()
  const catalog = botCatalog().filter((b) => !seen.has(b.name) && seen.add(b.name)).map((b) => ({ name: b.name, category: b.category, verified: !!(b.rdns || b.ranges), ...((b.rdns || b.ranges) && { via: b.rdns ? 'reverse DNS' : 'IP ranges' }) }))
  return { stances, catalog }
}
export const botsSet = defineAction('shield.bots.set', z.object({ category: z.enum(CATEGORIES as [BotCategory, ...BotCategory[]]), stance: z.enum(['allow', 'challenge', 'block', 'none']) }), async ({ category, stance }, ctx) => {
  const rid = botRuleId(category)
  const existing = await ShieldRule.objects.filter({ rid }).first() as { id: number; order: number } | undefined   // scope: ok
  if (stance === 'none') { if (existing) await ShieldRule.delete(existing.id) }
  else {
    const r = botRule(category, stance, existing?.order ?? 65)
    if (existing) await ShieldRule.update(existing.id, { name: r.name, when: r.when, then: r.then, enabled: true } as never)
    else await ShieldRule.create({ rid, order: r.order, name: r.name, enabled: true, when: r.when, then: r.then } as never)
  }
  const key = category === 'search' ? 'search' : category === 'ai-agent' ? 'agents' : category === 'ai-crawler' ? 'crawlers' : undefined
  if (key && stance !== 'none') await saveConfig({ aiDefaults: { ...runtimeOf(ctx.settings).aiDefaults, [key]: stance } })
  await changed(ctx.settings)
  return botsView()
}, write)

// ---- test a request (dry run: no counters, no events, no rate-limit tokens) ---------------------------------------------
export const test = defineAction('shield.test', z.object({ ip: z.string().ip(), method: z.string().max(10).default('GET'), path: z.string().startsWith('/').max(2000).default('/'), headers: z.record(z.string().max(100), z.string().max(4000)).default({}) }), async (p, ctx) => {
  const h = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]))
  const signals = await collectSignals({ ip: p.ip, method: p.method.toUpperCase(), path: p.path, host: h.host ?? 'localhost', secure: true, header: (n) => h[n], count: false })
  const { decision, trace } = await decide(signals, { settings: ctx.settings, ray: 'test', headers: h, dryRun: true })
  const names = new Map(state.rules.map((r) => [r.id, r.name]))
  return { signals, trace: trace.map((t) => ({ ...t, ...(names.has(t.ruleId) && { name: names.get(t.ruleId) }) })), decision, scoreParts: scoreParts(signals).parts }
}, read)

// the user model's fields for the panel access editor (+ groups)
async function userFields(): Promise<{ name: string; type: string }[]> {
  const out: { name: string; type: string }[] = []
  try {
    const { getUserModel } = await import('../auth/models.js')
    for (const [name, f] of Object.entries(getUserModel().fields as Record<string, { kind: string }>)) {
      if (/password|secret|token/i.test(name)) continue
      out.push({ name, type: f.kind === 'bool' ? 'boolean' : ['int', 'float', 'id', 'decimal'].includes(f.kind) ? 'number' : 'string' })
    }
  } catch { out.push({ name: 'isStaff', type: 'boolean' }, { name: 'isSuperuser', type: 'boolean' }, { name: 'email', type: 'string' }) }
  out.push({ name: 'groups', type: 'list' })
  return out
}

// ---- settings + ipdb --------------------------------------------------------------------------------------------------
export const settingsGet = defineAction('shield.settings.get', z.object({}), async (_p, ctx) => {
  const rt = runtimeOf(ctx.settings)
  return { mode: rt.mode, clearanceTtl: rt.clearanceTtl, levels: rt.levels, access: rt.access, userFields: await userFields(), aiDefaults: rt.aiDefaults, prefix: ctx.settings.shield.prefix, panelPath: ctx.settings.shield.panel.path,
    events: rt.events, stats: rt.stats, cleanup: rt.cleanup, dropped: counters.dropped }
}, read)
export const settingsSave = defineAction('shield.settings.save', z.object({
  mode: z.enum(['off', 'log', 'enforce']).optional(), clearanceTtl: z.string().regex(/^\d+[smhd]$/).optional(),
  levels: z.array(z.enum(LEVELS as ['pow', 'checkbox', 'captcha'])).min(1).optional(), access: z.unknown().optional(),
  events: z.object({ logAll: z.boolean(), samplePass: z.number().min(0).max(1), maxPerMinute: z.number().int().min(0).max(1_000_000), hardCapPerMinute: z.number().int().min(0).max(10_000_000), retentionDays: z.number().int().min(1).max(3650), storeIp: z.boolean() }).partial().strict().optional(),
  stats: z.object({ bucket: z.enum(['1m', '5m', '15m', '1h', '1d']), retentionDays: z.number().int().min(1).max(3650) }).partial().strict().optional(),
  cleanup: z.object({ enabled: z.boolean() }).partial().strict().optional(),
}), async (p, ctx) => {
  if (p.access !== undefined) {
    const problem = conditionProblem(p.access)
    if (problem) throw bad(`access: ${problem}`, 'access')
    // never lock yourself out: the saving user must still pass the new condition
    if (!evaluate(p.access as Condition, await userRow(ctx.request.user))) throw bad('access: this condition would lock you out of the panel', 'access')
  }
  const { events: ev, stats, cleanup, ...rest } = p
  const cur = (await ShieldConfig.objects.order('id').first() as { options?: Record<string, object> } | undefined)?.options ?? {}   // scope: ok
  const options = { events: { ...cur.events, ...ev }, stats: { ...cur.stats, ...stats }, cleanup: { ...cur.cleanup, ...cleanup } }
  await saveConfig({ ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...((ev || stats || cleanup) && { options }) })
  await changed(ctx.settings)
  return settingsGet.run({}, ctx as ActionCtx)
}, write)
export const ipdbStatus = defineAction('shield.ipdb.status', z.object({}), async (_p, ctx) => {
  const rows = ipdb.country.size + ipdb.asn.size, r = rangesStatus(), now = new Date()
  return {
    source: ctx.settings.shield.ipdb.source, ok: rows > 0, rows, ...(ipdb.loadedAt && { updatedAt: ipdb.loadedAt }),
    next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 3, 4)).toISOString(),
    message: rows ? `IP Geolocation by DB-IP (CC BY 4.0). ${r.prefixes} AI-crawler prefixes, ${r.torExits} Tor exits.` : `No DB-IP Lite files in ${ctx.settings.shield.ipdb.dir} yet: run "update now" (or the ipdb.update task). Country / ASN signals are empty until then.`,
  }
}, read)
export const ipdbUpdateNow = defineAction('shield.ipdb.update', z.object({}), async (_p, ctx) => {
  try { return { started: true, ...(await updateIpdb(ctx.settings.shield.ipdb.dir)) } } catch (e) { throw new DomainError('ipdb_update_failed', (e as Error).message.slice(0, 300)) }
}, write)

// "Delete events older than <date> / now": superuser only (on top of the panel access), audited (a write), batched
const superuser: Permission = (ctx) => { if (ctx.user.isSuperuser !== true) throw new DomainError('forbidden', 'forbidden: deleting events needs a superuser'); return true }
export const eventsPurge = defineAction('shield.events.purge', z.object({ before: z.string().datetime({ offset: true }).optional() }), async ({ before }) => {
  const cut = before ? +new Date(before) : Date.now() + 1000
  return { deleted: await pruneEvents((Date.now() - cut) / 86_400_000) }
}, { permissions: [access, superuser], mcp: false })
