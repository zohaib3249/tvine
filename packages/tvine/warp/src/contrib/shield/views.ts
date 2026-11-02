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
import { collectSignals } from './signals.js'
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
const access: Permission = async (ctx) => {
  const { loadedSettings } = await import('../../security/signing.js')
  return panelAllowed(ctx.user, loadedSettings() as Settings)
}
const read = { permissions: [staffGuard, access], readOnly: true, mcp: false }
const write = { permissions: [staffGuard, access], mcp: false }
const bad = (msg: string, param?: string) => new DomainError('invalid_param', msg, param)

// ---- overview + events ----------------------------------------------------------------------------------------------
const RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const
type Ev = { at: Date; ray: string; ipHash: string; ip?: string | null; country?: string | null; asn?: number | null; path: string; bot?: string | null; category: string; score: number; decision: string; ruleId?: string | null; mode: string }
const top = (rows: Ev[], key: (r: Ev) => string | null | undefined, n = 10) => {
  const m = new Map<string, number>()
  for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => ({ key: k, count }))
}
export const overview = defineAction('shield.overview', z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h') }), async ({ range }, ctx) => {
  // ponytail: aggregates up to 50k sampled event rows in JS; SQL GROUP BY if a site keeps millions
  const rows = await ShieldEvent.objects.filter({ at__gte: new Date(Date.now() - RANGES[range]) }).order('-at').limit(50_000).all() as Ev[]   // scope: ok
  const blocked = rows.filter((r) => r.decision === 'block' || r.decision === 'rateLimit')
  const passed = rows.filter((r) => r.decision === 'challenge-passed').length, failed = rows.filter((r) => r.decision === 'challenge-failed').length
  const hist = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 9}`, count: rows.filter((r) => Math.min(9, Math.floor(r.score / 10)) === i).length }))
  return {
    range, total: rows.length, mode: runtimeOf(ctx.settings).mode,
    byDecision: top(rows, (r) => r.decision, 20), byCategory: top(rows, (r) => r.category, 20),
    topBlockedIps: top(blocked, (r) => r.ip ?? r.ipHash), topBlockedAsns: top(blocked, (r) => (r.asn ? `AS${r.asn}` : null)),
    topBlockedCountries: top(blocked, (r) => r.country), topBots: top(rows, (r) => r.bot),
    challengePassRate: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 10 : null, scoreHistogram: hist,
  }
}, read)

const eventFilters = z.object({ decision: z.string().max(40).optional(), category: z.string().max(40).optional(), country: z.string().max(2).optional(), path: z.string().max(200).optional(), ray: z.string().max(128).optional(), ip: z.string().max(64).optional() }).strict()
export const events = defineAction('shield.events', z.object({ filters: eventFilters.default({}), page: z.number().int().min(1).max(1000).default(1) }), async ({ filters, page }) => {
  const f: Record<string, unknown> = {}
  if (filters.decision) f.decision = filters.decision
  if (filters.category) f.category = filters.category
  if (filters.country) f.country = filters.country.toUpperCase()
  if (filters.ray) f.ray = filters.ray
  if (filters.path) f.path__startswith = filters.path
  if (filters.ip) f.ipHash = ipHash(filters.ip)
  const qs = ShieldEvent.objects.filter(f)   // scope: ok
  const size = 50
  return { rows: await qs.order('-at').offset((page - 1) * size).limit(size).all(), total: await qs.count(), page, pageSize: size }
}, read)
export const event = defineAction('shield.event', z.object({ ray: z.string().min(1).max(128) }), async ({ ray }) => {
  const row = await ShieldEvent.objects.filter({ ray }).order('-at').first()   // scope: ok
  if (!row) throw new DomainError('not_found', `no shield event for ray ${ray}`)
  return row
}, read)

// ---- rules ------------------------------------------------------------------------------------------------------------
const ruleIn = z.object({ id: z.string().max(64).optional(), name: z.string(), enabled: z.boolean().default(true), order: z.number().int().optional(), when: z.unknown(), then: z.unknown(), ttl: z.string().max(10).optional() })
export const rulesList = defineAction('shield.rules.list', z.object({}), async () => ({ rules: (await ShieldRule.objects.order('order').all()).map((r) => toRule(r as never)), custom: [...customRules.keys()] }), read)   // scope: ok
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
  return { rule: state.rules.find((r) => r.id === rid) ?? null }
}, write)
export const rulesDelete = defineAction('shield.rules.delete', z.object({ id: z.string().max(64) }), async ({ id }, ctx) => {
  const n = await ShieldRule.objects.filter({ rid: id }).delete()
  if (!n) throw new DomainError('not_found', `no rule ${id}`)
  await changed(ctx.settings)
  return { deleted: n }
}, write)
export const rulesReorder = defineAction('shield.rules.reorder', z.object({ ids: z.array(z.string().max(64)).max(1000) }), async ({ ids }, ctx) => {
  for (const [i, rid] of ids.entries()) await ShieldRule.objects.filter({ rid }).update({ order: (i + 1) * 10 })
  await changed(ctx.settings)
  return { rules: state.rules }
}, write)
export const rulesReset = defineAction('shield.rules.reset', z.object({}), async (_p, ctx) => {
  await ShieldRule.objects.delete()
  await changed(ctx.settings)   // an empty table re-seeds the defaults
  return { rules: state.rules }
}, write)
export const customRulesList = defineAction('shield.customRules', z.object({}), async () => ({ names: [...customRules.keys()] }), read)

// ---- lists ------------------------------------------------------------------------------------------------------------
export const listsList = defineAction('shield.lists.list', z.object({}), async () => ({ rows: await ShieldList.objects.order('id').all() }), read)   // scope: ok
const listIn = z.object({ id: z.number().int().optional(), kind: z.enum(['ip', 'cidr', 'country', 'asn']), value: z.string().min(1).max(64), list: z.enum(['allow', 'deny']), note: z.string().max(200).optional() })
export const listsSave = defineAction('shield.lists.save', listIn, async (p, ctx) => {
  const v = p.value.trim()
  if ((p.kind === 'ip' || p.kind === 'cidr') && conditionProblem({ field: 'ip', op: 'cidr', value: v })) throw bad(`"${v}" is not an IP or CIDR`, 'value')
  if (p.kind === 'country' && !/^[A-Za-z]{2}$/.test(v)) throw bad('a 2-letter country code', 'value')
  if (p.kind === 'asn' && !/^(AS)?\d{1,10}$/i.test(v)) throw bad('an AS number (AS13335 or 13335)', 'value')
  const data = { kind: p.kind, value: p.kind === 'country' ? v.toUpperCase() : v, list: p.list, note: p.note ?? null }
  const row = p.id ? await ShieldList.update(p.id, data as never) : await ShieldList.create(data as never)
  await changed(ctx.settings)
  return { row }
}, write)
export const listsDelete = defineAction('shield.lists.delete', z.object({ id: z.number().int() }), async ({ id }, ctx) => {
  await ShieldList.delete(id)
  await changed(ctx.settings)
  return { deleted: 1 }
}, write)

// ---- bots ------------------------------------------------------------------------------------------------------------
const CATEGORIES: BotCategory[] = ['search', 'ai-crawler', 'ai-agent', 'monitor', 'seo', 'scraper', 'scanner', 'automation', 'browser', 'unknown']
export const bots = defineAction('shield.bots', z.object({}), async () => {
  const stance = Object.fromEntries(CATEGORIES.map((c) => {
    const r = state.rules.find((x) => x.id === botRuleId(c) && x.enabled)
    return [c, !r ? 'none' : r.then.type === 'allow' ? 'allow' : r.then.type === 'block' ? 'block' : r.then.type === 'challenge' ? 'challenge' : 'none']
  }))
  return { catalog: botCatalog().map((b) => ({ pattern: b.re.source, name: b.name, category: b.category, verify: b.rdns ? 'rdns' : b.ranges ? 'ip-range' : null })), stance, categories: CATEGORIES }
}, read)
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
  return { category, stance }
}, write)

// ---- test a request (dry run: no counters, no events, no rate-limit tokens) ---------------------------------------------
export const test = defineAction('shield.test', z.object({ ip: z.string().ip(), method: z.string().max(10).default('GET'), path: z.string().startsWith('/').max(2000).default('/'), headers: z.record(z.string().max(100), z.string().max(4000)).default({}) }), async (p, ctx) => {
  const h = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]))
  const signals = await collectSignals({ ip: p.ip, method: p.method.toUpperCase(), path: p.path, host: h.host ?? 'localhost', secure: true, header: (n) => h[n], count: false })
  const { decision, trace } = await decide(signals, { settings: ctx.settings, ray: 'test', headers: h, dryRun: true })
  return { signals, trace, decision }
}, read)

// ---- settings + ipdb --------------------------------------------------------------------------------------------------
export const settingsGet = defineAction('shield.settings.get', z.object({}), async (_p, ctx) => {
  const rt = runtimeOf(ctx.settings)
  return { mode: rt.mode, clearanceTtl: rt.clearanceTtl, levels: rt.levels, aiDefaults: rt.aiDefaults, access: rt.access, prefix: ctx.settings.shield.prefix, panelPath: ctx.settings.shield.panel.path }
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
export const ipdbStatus = defineAction('shield.ipdb.status', z.object({}), async (_p, ctx) => ({
  source: ctx.settings.shield.ipdb.source, dir: ctx.settings.shield.ipdb.dir, loadedAt: ipdb.loadedAt ?? null,
  countryRanges: ipdb.country.size, asnRanges: ipdb.asn.size, ranges: rangesStatus(), attribution: 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0',
}), read)
export const ipdbUpdateNow = defineAction('shield.ipdb.update', z.object({}), async (_p, ctx) => {
  try { return await updateIpdb(ctx.settings.shield.ipdb.dir) } catch (e) { throw new DomainError('ipdb_update_failed', (e as Error).message.slice(0, 300)) }
}, write)
