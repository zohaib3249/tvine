// tvine.shield persistence: rules / lists / config rows ⇄ the in-memory snapshot (engine.state), hot reload, rule hits.
import { F } from '../../data/expressions.js'
import type { Settings } from '../../core/types.js'
import { conditionProblem, evaluate } from './conditions.js'
import { LEVELS, ruleContext, customRules, defaultRules, setLists, setRules, state, type Runtime } from './engine.js'
import { ShieldConfig, ShieldList, ShieldRule } from './models.js'
import type { Action, ChallengeLevel, Condition, Rule } from './types.js'

type RuleRow = { id: number; rid: string; order: number; name: string; enabled: boolean; when: unknown; then: unknown; ttl?: string | null; hits: number }
export const toRule = (r: RuleRow): Rule => ({ id: r.rid, name: r.name, enabled: r.enabled, order: r.order, when: r.when as Condition, then: r.then as Action, ...(r.ttl && { ttl: r.ttl }), hits: r.hits + (hits.get(r.rid) ?? 0) })

let configRow: Record<string, unknown> | undefined
export async function loadAll(settings: Settings): Promise<void> {
  let rows = await ShieldRule.objects.order('order').all() as RuleRow[]   // scope: ok (shield's own tables)
  if (!rows.length) { await seedDefaults(settings); rows = await ShieldRule.objects.order('order').all() as RuleRow[] }
  setRules(rows.map(toRule))
  setLists(await ShieldList.objects.all() as never)   // scope: ok
  configRow = await ShieldConfig.objects.order('id').first() as Record<string, unknown> | undefined   // scope: ok
  state.runtime = runtimeFrom(settings, configRow)
  state.version = Number(configRow?.version ?? 0)
  state.checkedAt = Date.now()
}
export function runtimeFrom(settings: Settings, c: Record<string, unknown> | undefined): Runtime {
  const s = settings.shield
  const mode = c?.mode === 'off' || c?.mode === 'log' || c?.mode === 'enforce' ? c.mode : s.mode
  const levels = Array.isArray(c?.levels) ? (c.levels as string[]).filter((l): l is ChallengeLevel => (LEVELS as string[]).includes(l)) : LEVELS
  const access = c?.access && !conditionProblem(c.access) ? c.access as Condition : s.panel.access as Condition
  const o = (c?.options ?? {}) as { events?: object; stats?: object; cleanup?: object }
  return { mode, clearanceTtl: typeof c?.clearanceTtl === 'string' ? c.clearanceTtl : s.clearance.ttl, levels: levels.length ? levels : LEVELS, aiDefaults: { ...s.aiDefaults, ...(c?.aiDefaults as object | undefined) }, access,
    events: { ...s.events, ...o.events }, stats: { ...s.stats, ...o.stats }, cleanup: { ...s.cleanup, ...o.cleanup } }
}
export async function seedDefaults(settings: Settings): Promise<void> {
  const ai = runtimeFrom(settings, configRow).aiDefaults
  for (const r of defaultRules(ai)) await ShieldRule.create({ rid: r.id, order: r.order, name: r.name, enabled: r.enabled, when: r.when, then: r.then } as never)
}
// every 3 s at most (per process, never per request): did a save on any server, or the CLI, bump ShieldConfig.version?
export async function maybeReload(settings: Settings): Promise<void> {
  if (Date.now() - state.checkedAt < 3000) return
  state.checkedAt = Date.now()
  try {
    const row = await ShieldConfig.objects.order('id').first() as { version?: number } | undefined   // scope: ok (one small row / 3 s)
    if (Number(row?.version ?? 0) !== state.version) await loadAll(settings)
  } catch { /* db down: keep serving the snapshot we have */ }
}
// after any write: bump the version (other servers reload within 3 s) and reload here now
export async function changed(settings: Settings): Promise<void> {
  const row = await ShieldConfig.objects.order('id').first() as { id: number; version?: number } | undefined   // scope: ok
  const version = Math.max(Date.now(), Number(row?.version ?? 0) + 1)
  if (row) await ShieldConfig.update(row.id, { version } as never)
  else await ShieldConfig.create({ version } as never)
  await loadAll(settings)
}

export async function saveConfig(patch: Record<string, unknown>): Promise<void> {
  const row = await ShieldConfig.objects.order('id').first() as { id: number } | undefined   // scope: ok
  if (row) await ShieldConfig.update(row.id, patch as never)
  else await ShieldConfig.create(patch as never)
}

const PROBE = (path: string) => ({ ip: '192.0.2.1', ipNet: '192.0.2.0/24', tor: false, ua: '', bot: { category: 'unknown' as const, verified: false, spoofed: false }, headerScore: 0, path, method: 'GET', host: 'x', rate: { ip: 0, asn: 0, path: 0 }, score: 50 })
// rule saves are validated here (the panel's condition builder is not trusted)
export function ruleProblem(r: Partial<Rule>): string | undefined {
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 200) return 'name: 1..200 characters'
  const c = conditionProblem(r.when)
  if (c) return `when: ${c}`
  const a = r.then as Action | undefined
  if (!a || typeof a !== 'object') return 'then: an action'
  // a challenge / block that matches any request (an empty condition, path startsWith "/") is refused (review M2)
  if ((a.type === 'challenge' || a.type === 'block') && ['/', '/x/y', '/tvine/api/a.b'].every((path) => evaluate(r.when as Condition, ruleContext(PROBE(path)))))
    return 'when: this condition matches every request; narrow it (a path, a bot category, a score…)'
  switch (a.type) {
    case 'allow': case 'log': return undefined
    case 'challenge': return ['auto', ...LEVELS].includes(a.level) ? (a.ttl === undefined || /^\d+[smhd]$/.test(a.ttl) ? undefined : "then.ttl: a duration like '24h'") : 'then.level: auto | pow | checkbox | captcha'
    case 'block': return a.status === undefined || [403, 404, 429, 451].includes(a.status) ? (a.message === undefined || (typeof a.message === 'string' && a.message.length <= 200) ? undefined : 'then.message: at most 200 chars') : 'then.status: 403 | 404 | 429 | 451'
    case 'rateLimit': return Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= 1_000_000 && /^\d+[smhd]$/.test(a.window) && ['ip', 'asn', 'path', 'ip+path'].includes(a.key) ? undefined : "then: rateLimit needs limit 1..1000000, window like '1m', key ip | asn | path | ip+path"
    case 'custom': return customRules.has(a.name) ? undefined : `then.name: no custom rule "${String(a.name)}" (shield.registerRule)`
    default: return `then.type: unknown action "${String((a as { type?: unknown }).type)}"`
  }
}

// ---- rule hits: counted in memory, flushed every 30 s (one UPDATE per rule that fired) --------------------------------------
export const hits = new Map<string, number>()
export const countHit = (rid: string | undefined) => { if (rid && !rid.startsWith('list:')) hits.set(rid, (hits.get(rid) ?? 0) + 1) }
export async function flushHits(): Promise<void> {
  const all = [...hits]
  hits.clear()
  for (const [rid, n] of all) await ShieldRule.objects.filter({ rid }).update({ hits: F('hits').add(n) } as never).catch(() => undefined)
}

// `tvine shield mode off|log|enforce` / `tvine shield rules disable <id>|--all`: straight to the DB + a version bump, so a
// locked-out owner gets back in without the panel (running servers reload within 3 s)
export async function shieldCommand(settings: Settings, args: string[], o: { all?: boolean }): Promise<string> {
  const [what, a, b] = args
  if (what === 'mode' && (a === 'off' || a === 'log' || a === 'enforce') && b === undefined) {
    await saveConfig({ mode: a }); await changed(settings)
    return `shield mode: ${a}`
  }
  if (what === 'rules' && a === 'disable' && (o.all ? b === undefined : !!b)) {
    const n = await (o.all ? ShieldRule.objects.filter({}) : ShieldRule.objects.filter({ rid: b })).update({ enabled: false })
    if (!n) throw new Error(`no rule ${b}`)
    await changed(settings)
    return `disabled ${n} rule(s)`
  }
  throw new Error('usage: tvine shield mode off|log|enforce | tvine shield rules disable <id>|--all')
}
