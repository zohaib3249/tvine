// tvine.shield engine: the rules snapshot (hot reload), the default rule set, custom rules, decide() with its trace,
// the clearance cookie, the signed single-use challenge nonce + PoW check.
import { createHash, randomBytes } from 'node:crypto'
import type { Settings, ShieldStance } from '../../core/types.js'
import { limiterFor } from '../../backends/index.js'
import type { Limiter } from '../../security/ratelimit.js'
import { BadSignature, SignatureExpired, dumps, loads } from '../../security/signing.js'
import { AGENT_SURFACE, blockList, ipIn } from '../../middleware/index.js'
import { evaluate } from './conditions.js'
import { decrypt, encrypt } from '../../security/encryption.js'
import { claims } from './claims.js'
import { securityEvent } from '../../core/audit.js'
import { loadedSettings } from '../../security/signing.js'
import { sha } from './signals.js'
import type { Action, BotCategory, ChallengeLevel, Condition, Decision, Rule, Signals } from './types.js'

// '30s' | '30m' | '24h' | '7d' → ms
export function dur(s: string | undefined, dflt = 1_800_000): number {
  const m = /^(\d+)([smhd])$/.exec(s ?? '')
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's']! : dflt
}
export const LEVELS: ChallengeLevel[] = ['pow', 'checkbox', 'captcha']
const rank = (l: ChallengeLevel) => LEVELS.indexOf(l)

// ---- custom rules (app code): shield.registerRule('name', (req, signals) => Action | undefined) -------------------------
export type CustomRule = (req: unknown, signals: Signals) => Action | undefined | Promise<Action | undefined>
export const customRules = new Map<string, CustomRule>()
export function registerRule(name: string, fn: CustomRule): void {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`shield.registerRule: "${name}" is not a plain name`)
  if (typeof fn !== 'function') throw new Error(`shield.registerRule(${name}): needs a function`)
  customRules.set(name, fn)
}

// ---- default rule set (owner decisions; editable, shield.rules.reset restores it) -------------------------------------
export const stanceAction = (s: ShieldStance): Action => (s === 'allow' ? { type: 'allow' } : s === 'block' ? { type: 'block', status: 403 } : { type: 'challenge', level: 'auto' })
export const botRuleId = (c: BotCategory) => `bot:${c}`
// an ALLOW stance needs a VERIFIED bot (rDNS, published IP ranges, allowlisted Web Bot Auth, a Tvine token): an
// unverified UA claim gets no allow and is an ordinary request (score + challenge rules). Search is verified-only always.
export function botRule(category: BotCategory, stance: ShieldStance, order: number): Rule {
  const when: Condition = category === 'search' || stance === 'allow'
    ? { all: [{ field: 'bot.category', op: 'eq', value: category }, { field: 'bot.verified', op: 'eq', value: true }] }
    : { field: 'bot.category', op: 'eq', value: category }
  return { id: botRuleId(category), name: `${category} bots: ${stance}`, enabled: true, order, when, then: stanceAction(stance) }
}
export function defaultRules(ai: Settings['shield']['aiDefaults']): Rule[] {
  return [
    { id: 'default:rate', name: 'Rate limit 300/min per ip', enabled: true, order: 5, when: { all: [] }, then: { type: 'rateLimit', limit: 300, window: '1m', key: 'ip' } },
    { id: 'default:spoofed', name: 'Block spoofed bots (claims a verified bot, fails verification)', enabled: true, order: 10, when: { field: 'bot.spoofed', op: 'eq', value: true }, then: { type: 'block', status: 403, message: 'spoofed bot' } },
    botRule('search', ai.search, 20),
    botRule('ai-agent', ai.agents, 40),
    botRule('scanner', 'block', 50),
    botRule('ai-crawler', ai.crawlers, 60),
    { id: 'default:low-score', name: 'Challenge low scores on pages', enabled: true, order: 80, when: { all: [{ field: 'page', op: 'eq', value: true }, { field: 'score', op: 'lt', value: 30 }] }, then: { type: 'challenge', level: 'auto' } },
  ]
}

// ---- the live snapshot ------------------------------------------------------------------------------------------------
export interface ListRow { kind: 'ip' | 'cidr' | 'country' | 'asn'; value: string; list: 'allow' | 'deny' }
type SS = Settings['shield']
export interface Runtime { mode: 'off' | 'log' | 'enforce'; clearanceTtl: string; levels: ChallengeLevel[]; aiDefaults: SS['aiDefaults']; access: Condition; events: SS['events']; stats: SS['stats']; cleanup: SS['cleanup'] }
interface Lists { ips: { allow: ReturnType<typeof blockList>; deny: ReturnType<typeof blockList> }; countries: Map<string, 'allow' | 'deny'>; asns: Map<number, 'allow' | 'deny'> }
export const state = {
  rules: [] as Rule[],
  lists: undefined as Lists | undefined,
  runtime: undefined as Runtime | undefined,
  version: 0,
  checkedAt: 0,
}
export function setRules(rules: Rule[]): void { state.rules = [...rules].sort((a, b) => a.order - b.order) }
export function setLists(rows: ListRow[]): void {
  const ips = (l: 'allow' | 'deny') => { try { return blockList(rows.filter((r) => (r.kind === 'ip' || r.kind === 'cidr') && r.list === l).map((r) => r.value), 'shield list') } catch { return blockList([], '') } }
  state.lists = {
    ips: { allow: ips('allow'), deny: ips('deny') },
    countries: new Map(rows.filter((r) => r.kind === 'country').map((r) => [r.value.toUpperCase(), r.list])),
    asns: new Map(rows.filter((r) => r.kind === 'asn').map((r) => [Number(String(r.value).replace(/^AS/i, '')), r.list])),
  }
}
export const runtimeOf = (s: Settings): Runtime => state.runtime ?? { mode: s.shield.mode, clearanceTtl: s.shield.clearance.ttl, levels: LEVELS, aiDefaults: s.shield.aiDefaults, access: s.shield.panel.access as Condition, events: s.shield.events, stats: s.shield.stats, cleanup: s.shield.cleanup }

// lists run before the rules: deny (ip/cidr, then country, then asn) blocks, allow passes
export function listVerdict(s: Signals): { list: 'allow' | 'deny'; via: string } | undefined {
  const l = state.lists
  if (!l) return undefined
  if (ipIn(l.ips.deny, s.ip)) return { list: 'deny', via: 'ip' }
  if (ipIn(l.ips.allow, s.ip)) return { list: 'allow', via: 'ip' }
  const c = s.country && l.countries.get(s.country)
  if (c) return { list: c, via: 'country' }
  const a = s.asn !== undefined ? l.asns.get(s.asn) : undefined
  if (a) return { list: a, via: 'asn' }
  return undefined
}

// the field names rules see: Signals flattened under the contract's names + header.<x> + page + clearance
export function ruleContext(s: Signals, headers: Record<string, string | string[] | undefined> = {}): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    ...s, cidr: s.ip, 'asn.kind': s.asnKind, 'bot.name': s.bot.name, 'bot.category': s.bot.category, 'bot.verified': s.bot.verified,
    'bot.spoofed': s.bot.spoofed, 'bot.via': s.bot.via, 'rate.ip': s.rate.ip, 'rate.asn': s.rate.asn, 'rate.path': s.rate.path,
    'tls.ja3': s.tls?.ja3, 'tls.ja4': s.tls?.ja4, clearance: !!s.clearance?.valid, 'clearance.level': s.clearance?.valid ? s.clearance.level : undefined,
    page: (s.method === 'GET' || s.method === 'HEAD') && !AGENT_SURFACE(s.path),
  }
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) ctx[`header.${k.toLowerCase()}`] = Array.isArray(v) ? v.join(', ') : v
  return ctx
}

export const limiters = new Map<string, Limiter>()
export function limiter(settings: Settings, limit: number, windowMs: number): Limiter {
  const k = `${limit}/${windowMs}`
  let l = limiters.get(k)
  if (!l) limiters.set(k, (l = limiterFor(settings, { limit: Math.max(1, limit), windowMs: Math.max(1000, windowMs) })))
  return l
}

// a limiter backend error (redis down) fails OPEN for rate limits: logged on tvine.security, never a 500 (review M5)
export async function safeCheck(l: Limiter, sid: string, settings: Settings): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  try { return await l.check({ sid }) } catch (e) {
    securityEvent('shield_limiter_error', { key: sid.split(':')[0], error: String(e).slice(0, 200) }, { settings, audit: false })
    return { ok: true }
  }
}

export interface Trace { ruleId: string; matched: boolean; ms: number; action?: Action['type'] }
export interface DecideOpts { settings: Settings; ray: string; req?: unknown; headers?: Record<string, string | string[] | undefined>; dryRun?: boolean; mode?: 'log' | 'enforce' }
// first terminal match wins; 'log' and an un-exceeded 'rateLimit' are non-terminal; a valid clearance at or above the
// asked level satisfies a challenge (never a block)
export async function decide(s: Signals, o: DecideOpts): Promise<{ decision: Decision; trace: Trace[]; action?: Action; rule?: Rule; retryAfterMs?: number }> {
  const t0 = performance.now()
  const rt = runtimeOf(o.settings)
  const mode = o.mode ?? (rt.mode === 'enforce' ? 'enforce' : 'log')
  const trace: Trace[] = []
  const done = (action: Decision['action'], reason: string, extra: Partial<Decision> = {}, more: { action?: Action; rule?: Rule; retryAfterMs?: number } = {}) =>
    ({ decision: { action, reason, mode, score: s.score, ray: o.ray, ms: Math.round((performance.now() - t0) * 100) / 100, ...extra }, trace, ...more })
  const lv = listVerdict(s)
  if (lv) {
    trace.push({ ruleId: `list:${lv.list}`, matched: true, ms: 0, action: lv.list === 'deny' ? 'block' : 'allow' })
    return lv.list === 'deny' ? done('block', `deny list (${lv.via})`, { ruleId: `list:deny`, status: 403 }) : done('allow', `allow list (${lv.via})`, { ruleId: 'list:allow' })
  }
  const ctx = ruleContext(s, o.headers)
  // rate limits ALWAYS run first, whatever their order: an allow never skips them, unless an enabled matching admin rule
  // says { type: 'allow', rateExempt: true }
  const exemptRule = state.rules.find((r) => r.enabled && r.then.type === 'allow' && r.then.rateExempt === true && evaluate(r.when, ctx))
  if (!exemptRule) {
    for (const r of state.rules) {
      if (!r.enabled || r.then.type !== 'rateLimit') continue
      const a = r.then, r0 = performance.now(), matched = evaluate(r.when, ctx)
      trace.push({ ruleId: r.id, matched, ms: Math.round((performance.now() - r0) * 1000) / 1000, ...(matched && { action: a.type }) })
      if (!matched || o.dryRun) continue
      const key = a.key === 'ip' ? s.ipNet.endsWith('/64') ? s.ipNet : s.ip : a.key === 'asn' ? String(s.asn ?? s.ip) : a.key === 'path' ? s.path : `${s.ip}|${s.path}`
      const got = await safeCheck(limiter(o.settings, a.limit, dur(a.window, 60_000)), `shield-${a.key}:${key}`, o.settings)
      if (!got.ok) return done('rateLimit', `rate limit ${a.limit}/${a.window} per ${a.key}`, { ruleId: r.id, status: 429 }, { action: a, rule: r, retryAfterMs: got.retryAfterMs })
    }
  }
  let logged: Rule | undefined
  for (const r of state.rules) {
    if (!r.enabled || r.then.type === 'rateLimit') continue
    const r0 = performance.now()
    const matched = evaluate(r.when, ctx)
    let action: Action | undefined = matched ? r.then : undefined
    if (action?.type === 'custom') {
      const fn = customRules.get(action.name)
      try { action = fn ? await fn(o.req, s) : undefined } catch { action = undefined }
      if (action?.type === 'custom') action = undefined   // no recursion
    }
    trace.push({ ruleId: r.id, matched, ms: Math.round((performance.now() - r0) * 1000) / 1000, ...(action && { action: action.type }) })
    if (!action) continue
    if (action.type === 'log') { logged ??= r; continue }
    if (action.type === 'rateLimit') {
      if (o.dryRun) continue
      const key = action.key === 'ip' ? s.ipNet.endsWith('/64') ? s.ipNet : s.ip : action.key === 'asn' ? String(s.asn ?? s.ip) : action.key === 'path' ? s.path : `${s.ip}|${s.path}`
      const got = await safeCheck(limiter(o.settings, action.limit, dur(action.window, 60_000)), `shield-${action.key}:${key}`, o.settings)
      if (got.ok) continue
      return done('rateLimit', `rate limit ${action.limit}/${action.window} per ${action.key}`, { ruleId: r.id, status: 429 }, { action, rule: r, retryAfterMs: got.retryAfterMs })
    }
    if (action.type === 'challenge') {
      const level = levelFor(action.level, s, rt.levels)
      if (s.clearance?.valid && rank(s.clearance.level) >= rank(level)) { trace[trace.length - 1]!.action = 'allow'; return done('pass', `clearance (${s.clearance.level}) satisfies ${r.name}`, { ruleId: r.id }) }
      return done('challenge', r.name, { ruleId: r.id, level }, { action, rule: r })
    }
    if (action.type === 'block') return done('block', action.message ?? r.name, { ruleId: r.id, status: action.status ?? 403 }, { action, rule: r })
    return done('allow', r.name, { ruleId: r.id }, { action, rule: r })
  }
  return logged ? done('log', logged.name, { ruleId: logged.id }) : done('pass', 'no rule matched')
}
// 'auto': harder the lower the score; never a level the settings turned off (falls to the nearest enabled one)
export function levelFor(l: 'auto' | ChallengeLevel, s: Signals, enabled: ChallengeLevel[] = LEVELS): ChallengeLevel {
  const want: ChallengeLevel = l !== 'auto' ? l : s.score >= 40 ? 'pow' : s.score >= 15 ? 'checkbox' : 'captcha'
  if (enabled.includes(want)) return want
  return enabled.find((x) => rank(x) > rank(want)) ?? enabled[enabled.length - 1] ?? 'pow'
}

// ---- clearance cookie -------------------------------------------------------------------------------------------------
const CLEARANCE_SALT = 'tvine.shield.clearance'
export const cookieName = (secure: boolean) => (secure ? '__Host-tvine_shield' : 'tvine_shield')
export const uaHash = (ua: string) => sha(ua)
export const fpHash = (r?: { canvas?: string; webgl?: string; audio?: string }) => (r ? sha(`${r.canvas ?? ''}|${r.webgl ?? ''}|${r.audio ?? ''}`) : '')
export interface ClearancePayload { n: string; u: string; f: string; s: number; l: ChallengeLevel; e: number }
// AES-256-GCM (authenticated) under a key derived from settings.secret: tamper-proof AND the score / level are not readable
export const issueClearance = (p: ClearancePayload) => encrypt(JSON.stringify(p), CLEARANCE_SALT)
export function checkClearance(token: string | undefined, ipNet: string, ua: string, now = Date.now()): Signals['clearance'] {
  if (!token) return undefined
  let p: ClearancePayload
  try { p = JSON.parse(decrypt(token, CLEARANCE_SALT)) as ClearancePayload } catch { return { valid: false, level: 'pow', score: 1, reason: 'bad-signature' } }
  const level = LEVELS.includes(p.l) ? p.l : 'pow'
  if (typeof p.e !== 'number' || p.e < now) return { valid: false, level, score: p.s, reason: 'expired' }
  if (p.n !== ipNet || p.u !== uaHash(ua)) return { valid: false, level, score: p.s, reason: 'mismatch' }
  return { valid: true, level, score: Math.max(1, Math.min(99, Number(p.s) || 1)) }
}
export function clearanceCookie(value: string, secure: boolean, maxAgeMs: number): string {
  return `${cookieName(secure)}=${value}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

// ---- challenge nonce + PoW --------------------------------------------------------------------------------------------
const NONCE_SALT = 'tvine.shield.challenge'
export interface NoncePayload { id: string; d: number; l: ChallengeLevel; exp: number; ipNet: string; r?: string; c?: string }
export const difficultyFor = (score: number) => (score >= 60 ? 14 : score >= 30 ? 16 : 18)   // leading zero bits
export function issueNonce(p: Omit<NoncePayload, 'id' | 'exp'>, ttlMs = 300_000): { nonce: string; payload: NoncePayload } {
  const payload = { id: randomBytes(12).toString('base64url'), exp: Date.now() + ttlMs, ...p }
  return { nonce: dumps(payload, { salt: NONCE_SALT }), payload }
}
export function readNonce(nonce: unknown, ipNet: string, now = Date.now()): NoncePayload | undefined {
  if (typeof nonce !== 'string' || nonce.length > 2048) return undefined
  try {
    const p = loads<NoncePayload>(nonce, { salt: NONCE_SALT })
    return p.exp >= now && p.ipNet === ipNet && LEVELS.includes(p.l) ? p : undefined
  } catch (e) { if (e instanceof BadSignature || e instanceof SignatureExpired) return undefined; throw e }
}
// single use on every server (claims.ts: never evicted; throws on a backend error = the caller fails closed)
export const claimNonce = async (id: string) => claims.claim(loadedSettings() as Settings | undefined, `nonce:${id}`, 600_000)
export function leadingZeroBits(buf: Buffer): number {
  let n = 0
  for (const b of buf) { if (b === 0) { n += 8; continue } n += Math.clz32(b) - 24; break }
  return n
}
export const powOk = (nonce: string, counter: unknown, d: number) =>
  (typeof counter === 'number' || typeof counter === 'string') && String(counter).length <= 20 && leadingZeroBits(createHash('sha256').update(`${nonce}:${counter}`).digest()) >= d

// ---- hot reload: ShieldConfig.version (the DB row) is the version; every server polls it every 3 s (store.ts) ----------
export const VERSION_KEY = 'shield:rules'
