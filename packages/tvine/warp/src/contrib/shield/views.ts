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
import { botCatalog, ipdb, rangesStatus } from './data.js'
import { botRule, botRuleId, customRules, decide, runtimeOf, state, LEVELS } from './engine.js'
import { ShieldEvent, ShieldList, ShieldRule } from './models.js'
import { collectSignals, scoreParts } from './signals.js'
import { changed, ruleProblem, saveConfig, toRule } from './store.js'
import { updateIpdb } from './tasks.js'
import type { BotCategory, Condition } from './types.js'
import { ipHash } from './events.js'

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

// ---- overview + events ----------------------------------------------------------------------------------------------
const RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const
type Ev = { at: Date; ray: string; ipHash: string; ip?: string | null; country?: string | null; asn?: number | null; path: string; bot?: string | null; category: string; score: number; decision: string; ruleId?: string | null; mode: string }
const top = (rows: Ev[], key: (r: Ev) => string | null | undefined, n = 10) => {
  const m = new Map<string, number>()
  for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => ({ key: k, count }))
}
const SERIES = [{ name: 'pass', label: 'Passed' }, { name: 'log', label: 'Logged' }, { name: 'challenge', label: 'Challenged' }, { name: 'block', label: 'Blocked' }]
const bucketOf = (d: string) => (d === 'block' || d === 'rateLimit' || d === 'challenge-failed' ? 3 : d === 'challenge' ? 2 : d === 'log' || d.startsWith('would-') ? 1 : 0)
function totals(rows: Ev[]) {
  const passed = rows.filter((r) => r.decision === 'challenge-passed').length, failed = rows.filter((r) => r.decision === 'challenge-failed').length
  return {
    requests: rows.length, blocked: rows.filter((r) => bucketOf(r.decision) === 3).length, challenged: rows.filter((r) => r.decision === 'challenge').length,
    passRate: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 10 : 0, avgScore: rows.length ? Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length) : 0,
  }
}
export const overview = defineAction('shield.overview', z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h') }), async ({ range }) => {
  // ponytail: aggregates up to 50k (sampled) event rows in JS; SQL GROUP BY if a site keeps millions
  const span = RANGES[range], now = Date.now()
  const all = await ShieldEvent.objects.filter({ at__gte: new Date(now - 2 * span) }).order('-at').limit(100_000).all() as Ev[]   // scope: ok
  const rows = all.filter((r) => +new Date(r.at) >= now - span), prev = all.filter((r) => +new Date(r.at) < now - span)
  const step = range === '1h' ? 300_000 : range === '24h' ? 3_600_000 : 86_400_000
  const n = Math.round(span / step), first = Math.floor((now - span) / step) * step + step
  const points = Array.from({ length: n }, (_, i) => ({ x: new Date(first + i * step).toISOString(), values: [0, 0, 0, 0] }))
  for (const r of rows) { const i = Math.min(n - 1, Math.max(0, Math.floor((+new Date(r.at) - first) / step) + 1)); points[i]!.values[bucketOf(r.decision)]!++ }
  const blocked = rows.filter((r) => bucketOf(r.decision) === 3)
  const histogram = Array.from({ length: 10 }, () => 0)
  for (const r of rows) histogram[Math.min(9, Math.floor(r.score / 10))]!++
  return {
    totals: { ...totals(rows), previous: totals(prev) },
    series: { groupBy: step >= 86_400_000 ? 'day' : 'hour', series: SERIES, points },
    top: { ips: top(blocked, (r) => r.ip ?? r.ipHash.slice(0, 12)), asns: top(blocked, (r) => (r.asn ? `AS${r.asn}` : null)).map((c) => ({ ...c, label: ipdb.orgs.get(Number(c.key.slice(2))) })), countries: top(blocked, (r) => r.country), bots: top(rows, (r) => r.bot) },
    histogram,
  }
}, read)

const eventRow = (r: Ev) => ({ ts: new Date(r.at).toISOString(), ray: r.ray, ...(r.ip && { ip: r.ip }), ...(r.country && { country: r.country }), ...(r.asn && { asn: r.asn }), path: r.path, ...(r.bot && { bot: r.bot }), score: r.score, decision: r.mode === 'log' && !['pass', 'allow', 'log'].includes(r.decision) ? `would-${r.decision}` : r.decision, ...(r.ruleId && { ruleId: r.ruleId }) })
const eventFilters = z.object({ decision: z.string().max(40).optional(), category: z.string().max(40).optional(), country: z.string().max(2).optional(), bot: z.string().max(100).optional(), path: z.string().max(200).optional(), ray: z.string().max(128).optional(), ip: z.string().max(64).optional(), rule: z.string().max(64).optional(), scoreLt: z.number().optional() })
export const events = defineAction('shield.events', z.object({ filters: eventFilters.default({}), page: z.number().int().min(1).max(1000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }), async ({ filters, page, pageSize }) => {
  const f: Record<string, unknown> = {}
  if (filters.decision) f.decision = filters.decision.replace(/^would-/, '')
  if (filters.category) f.category = filters.category
  if (filters.country) f.country = filters.country.toUpperCase()
  if (filters.bot) f.bot = filters.bot
  if (filters.ray) f.ray = filters.ray
  if (filters.rule) f.ruleId = filters.rule
  if (filters.path) f.path__startswith = filters.path
  if (filters.scoreLt !== undefined) f.score__lt = filters.scoreLt
  if (filters.ip) f.ipHash = ipHash(filters.ip)
  const qs = ShieldEvent.objects.filter(f)   // scope: ok
  const count = await qs.count()
  return { rows: (await qs.order('-at').offset((page - 1) * pageSize).limit(pageSize).all() as Ev[]).map(eventRow), count, page, pages: Math.max(1, Math.ceil(count / pageSize)) }
}, read)
// signals + headers are not stored per event (privacy, size): the row and its decision only
export const event = defineAction('shield.event', z.object({ ray: z.string().min(1).max(128) }), async ({ ray }) => {
  const r = await ShieldEvent.objects.filter({ ray }).order('-at').first() as Ev | undefined   // scope: ok
  if (!r) throw new DomainError('not_found', `no shield event with ray ${ray}`)
  return { event: eventRow(r), decision: { action: r.decision, ...(r.ruleId && { ruleId: r.ruleId }), reason: r.ruleId ? `rule ${r.ruleId}` : r.decision, mode: r.mode, score: r.score, ray: r.ray, ms: 0 } }
}, read)

// ---- rules ------------------------------------------------------------------------------------------------------------
const ruleIn = z.object({ id: z.string().max(64).optional().or(z.literal('')).transform((v) => v || undefined), name: z.string(), enabled: z.boolean().default(true), order: z.number().int().optional(), when: z.unknown(), then: z.unknown(), ttl: z.string().max(10).optional() })
const allRules = async () => (await ShieldRule.objects.order('order').all()).map((r) => toRule(r as never))   // scope: ok
export const rulesList = defineAction('shield.rules.list', z.object({}), async () => allRules(), read)
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
  return { mode: rt.mode, clearanceTtl: rt.clearanceTtl, levels: rt.levels, access: rt.access, userFields: await userFields(), aiDefaults: rt.aiDefaults, prefix: ctx.settings.shield.prefix, panelPath: ctx.settings.shield.panel.path }
}, read)
export const settingsSave = defineAction('shield.settings.save', z.object({
  mode: z.enum(['off', 'log', 'enforce']).optional(), clearanceTtl: z.string().regex(/^\d+[smhd]$/).optional(),
  levels: z.array(z.enum(LEVELS as ['pow', 'checkbox', 'captcha'])).min(1).optional(), access: z.unknown().optional(),
}), async (p, ctx) => {
  if (p.access !== undefined) {
    const problem = conditionProblem(p.access)
    if (problem) throw bad(`access: ${problem}`, 'access')
    // never lock yourself out: the saving user must still pass the new condition
    if (!evaluate(p.access as Condition, await userRow(ctx.request.user))) throw bad('access: this condition would lock you out of the panel', 'access')
  }
  await saveConfig(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)))
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
