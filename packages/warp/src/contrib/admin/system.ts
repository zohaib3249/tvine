// The admin's System section (docs/design/contrib/admin.md §As built: dashboard + system): health, logs, agents,
// metrics, traffic, queries, jobs, security. Read-only views over in-process state (stats.ts Collector, the memory
// log ring, the tab hub, ServerCtx.health) and the AdminStat rollups. Staff only; logs + security are superuser only;
// jobs need tasks' view permission. Nothing here returns a secret, a raw sid, a bound SQL value or a param.
import { performance } from 'node:perf_hooks'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import type { ServerCtx } from '../../core/dispatch.js'
import { DomainError } from '../../core/errors.js'
import type { Permission } from '../../core/types.js'
import { connections } from '../../data/db.js'
import { showMigrations } from '../../data/migrate.js'
import { isProduction } from '../../env.js'
import { memoryLog, LEVELS, type Level } from '../../log.js'
import { isStaff } from '../../security/permissions.js'
import { AdminStat } from './models.js'
import {
  AGENT_VIA, Collector, merge, newAcc, quantile, rangeOf, round, timeSeries, topOf, type Acc, type ChartData, type Range, type StatRow, type Table,
} from './stats.js'
import { rangeParam } from './stats.js'

// set by hooks.ts ready(): the server this admin runs in and its collector
export const runtime: { ctx?: ServerCtx; collector?: Collector; startedAt: number; lag?: ReturnType<typeof monitorEventLoopDelay> } = { startedAt: Date.now() }

const isSuperuser: Permission = (c) => c.user.isSuperuser === true && c.user.isActive !== false
const staff = { permissions: [isStaff], readOnly: true }
const superuser = { permissions: [isStaff, isSuperuser], readOnly: true }
const forbidden = () => new DomainError('forbidden', 'forbidden: not allowed')
const col = () => runtime.collector ?? new Collector()
const ms = (n: number) => Math.round(n * 10) / 10

// ---- rollup reads: the last hour from memory (this process), longer ranges from AdminStat (every process) ------------
export async function statRows(key: string, range: Range | undefined): Promise<{ rows: StatRow[]; r: ReturnType<typeof rangeOf> }> {
  const r = rangeOf(range)
  if (r.groupBy === 'minute') return { rows: col().memoryRows(key, +r.from), r }
  if (runtime.ctx && !runtime.ctx.settings.admin.stats.enabled) return { rows: [], r }
  const hourStart = new Date(Math.floor(+r.from / 3_600_000) * 3_600_000)
  const got = await AdminStat.objects.filter({ key, bucket__gte: hourStart, bucket__lte: r.to }).all(200_000)   // scope: ok (internal rollup table)
  return { rows: got.map((x) => ({ bucket: x.bucket, key, dims: (x.dims ?? {}) as Record<string, string>, count: x.count, sum: x.sum, max: x.max, hist: (x.hist ?? []) as number[] })), r }
}
const table = (columns: string[], rows: (string | number)[][]): Table => ({ columns, rows })
const p95 = (a: Acc) => ms(quantile(a, 0.95))
const avg = (a: Acc) => (a.count ? ms(a.sum / a.count) : 0)

// ---- health ------------------------------------------------------------------------------------------------------------
type Status = 'ok' | 'warn' | 'error'
type Section = { name: string; title: string; status: Status; summary: string; details: Record<string, string | number | boolean | null> }
let migCache: { at: number; pending: number | null } | undefined
async function pendingMigrations(ctx: ServerCtx): Promise<number | null> {
  if (migCache && Date.now() - migCache.at < 60_000) return migCache.pending
  let pending: number | null = null
  try { if (ctx.appsDir) pending = (await showMigrations(connections.get(), ctx.appsDir, { installed: ctx.settings.installedApps })).filter((m) => !m.applied).length } catch { pending = null }
  migCache = { at: Date.now(), pending }
  return pending
}
const flat = (o: unknown, pre = '', out: Record<string, string | number | boolean | null> = {}) => {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && Object.keys(out).length < 40) flat(v, `${pre}${k}.`, out)
    else out[`${pre}${k}`] = typeof v === 'number' || typeof v === 'boolean' || v === null ? v : String(v).slice(0, 200)
  }
  return out
}
const worst = (xs: Status[]): Status => (xs.includes('error') ? 'error' : xs.includes('warn') ? 'warn' : 'ok')

export function configWarnings(s: ServerCtx['settings']): string[] {
  const w: string[] = [], prod = isProduction()
  if (prod && s.debug) w.push('settings.debug is on in production')
  if (prod && !s.allowedHosts?.length) w.push('settings.allowedHosts is empty in production')
  if (prod && /^file:|\.db$|\.sqlite3?$/i.test(s.db.url)) w.push('SQLite database in production (one process only)')
  if (prod && !s.session.secure) w.push('session cookie is not Secure in production')
  if (prod && s.email.backend === 'console') w.push("email backend 'console' in production (mail is not delivered)")
  if (!s.audit.enabled) w.push('audit trail is off (settings.audit.enabled)')
  if (s.agent.inTab === 'off') w.push('in-tab agent control is off (settings.agent.inTab)')
  return w
}

export const systemHealth = defineAction('admin.system.health', z.object({}), async (_p, actx) => {
  const ctx = runtime.ctx, c = col(), sections: Section[] = []
  const settings = actx.settings
  // database: a round trip, the dialect, pending migrations
  try {
    const conn = connections.get(), t0 = performance.now()
    await conn.driver.query('SELECT 1', [])
    const latency = ms(performance.now() - t0)
    const pending = ctx ? await pendingMigrations(ctx) : null
    sections.push({ name: 'db', title: 'Database', status: pending ? 'warn' : latency > 200 ? 'warn' : 'ok', summary: `${conn.dialect.name} · ${latency} ms${pending ? ` · ${pending} migration(s) pending` : ''}`,
      details: { dialect: conn.dialect.name, latencyMs: latency, migrationsPending: pending, slowQueryMs: settings.db.slowQueryMs ?? null } })
  } catch (e) {
    sections.push({ name: 'db', title: 'Database', status: 'error', summary: 'unreachable', details: { error: (e as Error).message.slice(0, 200) } })
  }
  const extra = new Map<string, unknown>()
  for (const [name, fn] of ctx?.health ?? []) { try { extra.set(name, fn()) } catch (e) { extra.set(name, { error: (e as Error).message }) } }
  // backends + redis connections (backendHealth: no urls, no passwords)
  const backends = (extra.get('backends') ?? {}) as Record<string, unknown>
  const redis = backends.redis as Record<string, unknown> | undefined
  if (redis) {
    const bad = Object.values(redis).some((v) => /down|error|closed|reconnect/i.test(JSON.stringify(v)))
    sections.push({ name: 'redis', title: 'Redis', status: bad ? 'error' : 'ok', summary: `${Object.keys(redis).length} connection(s)`, details: flat(redis) })
  }
  // broker
  const tasks = extra.get('tasks') as Record<string, number | boolean> | undefined
  if (tasks) {
    const st: Status = tasks.error ? 'error' : Number(tasks.dead) > 0 || Number(tasks.staleWorkers) > 0 ? 'warn' : 'ok'
    sections.push({ name: 'broker', title: 'Task queue', status: st, summary: tasks.pending ? 'reading…' : `${tasks.queued ?? 0} queued · ${tasks.running ?? 0} running · ${tasks.dead ?? 0} failed`,
      details: { broker: settings.tasks.broker ?? 'file', ...flat(tasks) } })
  }
  // cache hit rate (this process, last hour)
  const cache = topOf(c.memoryRows('cache', Date.now() - 3_600_000), (r) => r.dims.h)
  const hits = cache.find(([h]) => h === '1')?.[1].count ?? 0, misses = cache.find(([h]) => h === '0')?.[1].count ?? 0
  const rate = hits + misses ? Math.round((hits / (hits + misses)) * 100) : null
  sections.push({ name: 'cache', title: 'Cache', status: 'ok', summary: `${settings.caches.default?.backend ?? 'memory'}${rate !== null ? ` · ${rate}% hits` : ' · no lookups yet'}`,
    details: { backend: settings.caches.default?.backend ?? 'memory', hitRatePct: rate, hits, misses } })
  // mail
  const mail = topOf(c.memoryRows('mail', Date.now() - 3_600_000), (r) => r.dims.ok)
  const sent = mail.find(([k]) => k === '1')?.[1].count ?? 0, failed = mail.find(([k]) => k === '0')?.[1].count ?? 0
  sections.push({ name: 'mail', title: 'Email', status: failed ? 'warn' : 'ok', summary: `${settings.email.backend}${failed ? ` · ${failed} failed (1h)` : ` · ${sent} sent (1h)`}`,
    details: { backend: settings.email.backend, sentLastHour: sent, failedLastHour: failed, lastFailure: c.mailFailedAt ? new Date(c.mailFailedAt).toISOString() : null } })
  // process
  const mem = process.memoryUsage(), lag = runtime.lag ? ms(runtime.lag.mean / 1e6) : null
  sections.push({ name: 'process', title: 'Process', status: lag !== null && lag > 100 ? 'warn' : 'ok', summary: `up ${fmtUptime(process.uptime())} · ${Math.round(mem.rss / 1048576)} MB${lag !== null ? ` · lag ${lag} ms` : ''}`,
    details: { uptimeSec: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), eventLoopLagMs: lag, node: process.version, pid: process.pid, sessions: ctx?.sessions.size ?? null } })
  const warnings = configWarnings(settings)
  sections.push({ name: 'config', title: 'Configuration', status: warnings.length ? 'warn' : 'ok', summary: warnings.length ? `${warnings.length} warning(s)` : 'no warnings', details: Object.fromEntries(warnings.map((w, i) => [`warning${i + 1}`, w])) })
  return { status: worst(sections.map((s) => s.status)), at: new Date().toISOString(), sections, warnings }
}, staff)
const fmtUptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`)

// ---- logs (superuser) -----------------------------------------------------------------------------------------------------
export const systemLogs = defineAction('admin.system.logs', z.object({
  level: z.enum(LEVELS).optional(), logger: z.string().max(100).optional(), q: z.string().max(200).optional(),
  requestId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(1000).default(300), after: z.coerce.number().int().min(0).optional(),
}), async (p) => {
  const rank = (l: Level) => LEVELS.indexOf(l)
  const q = p.q?.toLowerCase()
  const out = []
  const all = memoryLog.records()
  for (let i = all.length - 1; i >= 0 && out.length < p.limit; i--) {
    const r = all[i]!
    if (p.after !== undefined && r.seq <= p.after) break
    if (p.level && rank(r.level) < rank(p.level)) continue
    if (p.logger && r.logger !== p.logger && !r.logger.startsWith(`${p.logger}.`)) continue
    if (p.requestId && r.requestId !== p.requestId) continue
    const { seq, t, level, logger, msg, ...fields } = r
    if (q && !`${msg} ${logger} ${JSON.stringify(fields)}`.toLowerCase().includes(q)) continue
    out.push({ seq, t, level, logger, msg, fields })   // records are redacted when logged (log.ts emit)
  }
  return { enabled: memoryLog.enabled(), capacity: memoryLog.capacity(), records: out.reverse() }
}, superuser)

// ---- agents ----------------------------------------------------------------------------------------------------------------
type Hub = { controlled?(): { id: string; session: string; since: number; agent: string; used: number }[]; revoke?(id: string): boolean }
const tabsOf = () => (runtime.ctx?.tabs ?? {}) as Hub
export const systemAgents = defineAction('admin.system.agents', z.object({ range: rangeParam.optional() }), async ({ range }) => {
  const c = col(), now = Date.now()
  const [act, ag, tok] = await Promise.all([statRows('action', range), statRows('agent', range), statRows('token', range)])
  const activity = timeSeries(act.rows, act.r.groupBy, act.r.from, act.r.to, [{ name: 'human', label: 'Human' }, { name: 'agent', label: 'Agent' }],
    (r) => (AGENT_VIA.has(r.dims.v ?? '') ? 'agent' : 'human'))
  const refusals: Record<string, number> = { human_only: 0, confirm: 0 }
  for (const r of act.rows) { if (r.dims.o === 'human_only') refusals.human_only! += r.count; if (r.dims.o === 'confirm_required') refusals.confirm! += r.count }
  const hubTabs = tabsOf().controlled?.() ?? []
  return {
    activity: { ...activity, title: 'Human vs agent actions', type: 'stacked', unit: 'count' } as ChartData,
    topAgents: table(['Agent (unverified)', 'Via', 'Actions'], topOf(ag.rows, (r) => `${r.dims.n}\u0000${r.dims.v}`).map(([k, a]) => [...k.split('\u0000'), a.count])),
    topTokens: table(['Token user', 'Actions'], topOf(tok.rows, (r) => r.dims.u).map(([k, a]) => [k, a.count])),
    topActions: table(['Action', 'Calls', 'Errors', 'p95 ms'], topOf(act.rows.filter((r) => AGENT_VIA.has(r.dims.v ?? '')), (r) => r.dims.a).map(([k, a]) => [k, a.count, errorsOf(act.rows, k, true), p95(a)])),
    refusals,
    sessions: [...c.sessions.values()].filter((s) => now - s.lastAt < 3_600_000).sort((x, y) => y.lastAt - x.lastAt).slice(0, 100).map((s) => ({
      id: s.id, agent: s.agent, verified: false, via: s.via, lastAction: s.lastAction, lastAt: new Date(s.lastAt).toISOString(), page: s.page ?? null,
      actions: s.actions, perMin: round(s.recent.filter((t) => t > now - 60_000).length),
    })),
    tabs: hubTabs.map((t) => ({ id: t.id, page: c.sessions.get(t.session.slice(0, 12))?.page ?? null, since: new Date(t.since).toISOString(), agent: t.agent, verified: false, lastUsed: new Date(t.used).toISOString() })),
    recent: [...c.recent].reverse().slice(0, 100),
  }
}, staff)
const errorsOf = (rows: StatRow[], action: string, agentOnly: boolean) =>
  rows.filter((r) => r.dims.a === action && r.dims.o !== 'ok' && (!agentOnly || AGENT_VIA.has(r.dims.v ?? ''))).reduce((n, r) => n + r.count, 0)

// the admin's Stop: ends an agent's control of a tab (the tab hub's own release; the agent is told it was stopped)
export const systemRevokeTab = defineAction('admin.system.revokeTab', z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }), async ({ id }) => {
  if (!tabsOf().revoke?.(id)) throw new DomainError('not_found', 'no agent controls that tab now')
  return { ok: true }
}, { permissions: [isStaff] })

// ---- metrics (10-second ticks, this process, last hour) --------------------------------------------------------------------
export const systemMetrics = defineAction('admin.system.metrics', z.object({}), async () => {
  const ticks = col().ticks, totals = { requests: 0, errors: 0, human: 0, agent: 0 }
  const points = ticks.map((k) => {
    totals.requests += k.requests; totals.errors += k.errors; totals.human += k.human; totals.agent += k.agent
    return { t: new Date(k.t).toISOString(), requests: k.requests, errors: k.errors, p50: ms(quantile(k.acc, 0.5)), p95: ms(quantile(k.acc, 0.95)), human: k.human, agent: k.agent }
  })
  return { intervalSec: 10, points, totals }
}, staff)

// ---- traffic -----------------------------------------------------------------------------------------------------------------
const TRANSPORTS = ['page', 'api', 'urls', 'mcp', 'tab', 'channel', 'other']
export async function trafficCharts(range: Range | undefined) {
  const { rows, r } = await statRows('http', range)
  const timed = rows.filter((x) => x.dims.t !== 'channel')
  const requests = timeSeries(rows, r.groupBy, r.from, r.to, TRANSPORTS.map((t) => ({ name: t, label: t === 'urls' ? 'URLs' : t.toUpperCase().length <= 3 ? t.toUpperCase() : t[0]!.toUpperCase() + t.slice(1) })), (x) => (TRANSPORTS.includes(x.dims.t!) ? x.dims.t : 'other'))
  requests.series = requests.series.filter((_, i) => requests.points.some((p) => p.values[i]))   // only transports that saw traffic
  const keep = TRANSPORTS.filter((_, i) => rows.some((x) => (TRANSPORTS.includes(x.dims.t!) ? x.dims.t : 'other') === TRANSPORTS[i]))
  requests.points = requests.points.map((p) => ({ x: p.x, values: TRANSPORTS.map((t, i) => [t, p.values[i]!] as const).filter(([t]) => keep.includes(t)).map(([, v]) => v) }))
  const status = timeSeries(rows, r.groupBy, r.from, r.to, ['2xx', '3xx', '4xx', '5xx'].map((s) => ({ name: s, label: s })), (x) => x.dims.s)
  const lat = (q: number) => timeSeries(timed, r.groupBy, r.from, r.to, [{ name: 'v', label: '' }], () => 'v', (a) => quantile(a, q))
  const l50 = lat(0.5), l95 = lat(0.95)
  const latency: ChartData = { unit: 'ms', groupBy: r.groupBy, series: [{ name: 'p50', label: 'p50' }, { name: 'p95', label: 'p95' }], points: l50.points.map((p, i) => ({ x: p.x, values: [p.values[0]!, l95.points[i]!.values[0]!] })) }
  const errs = timeSeries(rows, r.groupBy, r.from, r.to, [{ name: 'all', label: '' }, { name: '5xx', label: '' }], (x) => (x.dims.s === '5xx' ? '5xx' : 'all'))
  const errorRate: ChartData = { unit: 'percent', groupBy: r.groupBy, series: [{ name: 'errors', label: 'Error rate' }],
    points: errs.points.map((p) => { const all = p.values[0]! + p.values[1]!; return { x: p.x, values: [all ? round((p.values[1]! / all) * 100) : 0] } }) }
  const total = rows.reduce((n, x) => n + x.count, 0), fives = rows.filter((x) => x.dims.s === '5xx').reduce((n, x) => n + x.count, 0)
  const all = timed.reduce((a, x) => merge(a, x), newAcc())
  return { r, requests: { ...requests, unit: 'count' as const, total }, status: { ...status, unit: 'count' as const }, latency, errorRate: { ...errorRate, total: total ? round((fives / total) * 100) : 0 }, p95: p95(all), total }
}
export async function actionTables(range: Range | undefined) {
  const { rows } = await statRows('action', range)
  const by = topOf(rows, (r) => r.dims.a, 1000)
  const errs = new Map<string, number>()
  for (const x of rows) if (x.dims.o !== 'ok') errs.set(x.dims.a!, (errs.get(x.dims.a!) ?? 0) + x.count)
  const row = ([k, a]: [string, Acc]) => [k, a.count, errs.get(k) ?? 0, avg(a), p95(a)]
  const cols = ['Action', 'Calls', 'Errors', 'avg ms', 'p95 ms']
  return {
    top: table(cols, by.slice(0, 10).map(row)),
    slowest: table(cols, [...by].sort((x, y) => quantile(y[1], 0.95) - quantile(x[1], 0.95)).slice(0, 10).map(row)),
    failing: table(cols, by.filter(([k]) => errs.get(k)).sort((x, y) => (errs.get(y[0]) ?? 0) - (errs.get(x[0]) ?? 0)).slice(0, 10).map(row)),
  }
}
export const systemTraffic = defineAction('admin.system.traffic', z.object({ range: rangeParam.optional() }), async ({ range }) => {
  const t = await trafficCharts(range)
  const { rows } = await statRows('route', range)
  const routes = topOf(rows, (x) => x.dims.r, 15).map(([k, a]) => [k, a.count, rows.filter((x) => x.dims.r === k && x.dims.e === '1').reduce((n, x) => n + x.count, 0), avg(a), p95(a)])
  return {
    requests: { ...t.requests, title: 'Requests by transport', type: 'area' }, status: { ...t.status, title: 'Responses by status', type: 'stacked' },
    latency: { ...t.latency, title: 'Latency', type: 'line' }, errorRate: { ...t.errorRate, title: 'Error rate (5xx)', type: 'line' },
    routes: table(['Route', 'Requests', '5xx', 'avg ms', 'p95 ms'], routes), actions: await actionTables(range),
  }
}, staff)

// ---- queries -----------------------------------------------------------------------------------------------------------------
export const systemQueries = defineAction('admin.system.queries', z.object({ range: rangeParam.optional() }), async ({ range }, actx) => {
  const { rows } = await statRows('db', range)
  const top = topOf(rows, (x) => `${x.dims.f}\u0000${x.dims.d}`, 25, (a) => a.sum)
  return {
    enabled: actx.settings.admin.stats.enabled,
    top: table(['Fingerprint', 'Alias', 'Count', 'Total ms', 'p95 ms', 'Max ms'], top.map(([k, a]) => { const [f, d] = k.split('\u0000'); return [f!, d!, a.count, Math.round(a.sum), p95(a), ms(a.max)] })),
    slow: table(['Time', 'Fingerprint', 'ms', 'Alias'], [...col().slow].reverse().slice(0, 50).map((s) => [s.t, s.fingerprint, s.ms, s.alias])),
  }
}, staff)

// ---- jobs (tvine.tasks) --------------------------------------------------------------------------------------------------------
export const systemJobs = defineAction('admin.system.jobs', z.object({ range: rangeParam.optional() }), async ({ range }, actx) => {
  const u = actx.request.user
  const may = async (p: string) => !!u.isSuperuser || (!!u.hasPerm && (await u.hasPerm(p)))
  if (!actx.settings.installedApps.includes('tvine.tasks')) return { available: false, broker: null, counts: {}, queues: [], series: null, failed: [], canRetry: false }
  if (!(await may('tasks.view_job')) && !(await may('tasks.change_job'))) throw forbidden()
  const { broker, brokerKind } = await import('../tasks/broker.js')
  const b = broker()
  const r = rangeOf(range)
  const [s, recent, dead, queued] = await Promise.all([b.stats(actx.settings.tasks.leaseMs), b.list({ status: 'success', limit: 1000 }), b.list({ status: 'dead', limit: 200 }), b.list({ status: 'queued', limit: 1000 })])
  const queues = new Map<string, { name: string; queued: number; running: number; scheduled: number; dead: number }>()
  const q = (n: string) => queues.get(n) ?? (queues.set(n, { name: n, queued: 0, running: 0, scheduled: 0, dead: 0 }), queues.get(n)!)
  for (const j of queued) { const x = q(j.queue); if (Number(j.runAt ?? 0) > Date.now()) x.scheduled++; else x.queued++ }
  for (const j of dead) q(j.queue).dead++
  const asRows = (jobs: { finishedAt?: number | null; createdAt: number }[], name: string): StatRow[] =>
    jobs.map((j) => ({ bucket: new Date(Number(j.finishedAt ?? j.createdAt)), key: 'job', dims: { s: name }, ...acc1() }))
  const series = timeSeries([...asRows(recent, 'done'), ...asRows(dead, 'failed')], r.groupBy, r.from, r.to, [{ name: 'done', label: 'Done' }, { name: 'failed', label: 'Failed' }], (x) => x.dims.s)
  const canRetry = await may('tasks.change_job')
  return {
    available: true, broker: brokerKind() ?? 'file',
    counts: { queued: s.queued, scheduled: s.scheduled, running: s.running, dead: s.dead, workers: s.workers.length },
    queues: [...queues.values()],
    series: { ...series, title: 'Jobs finished', type: 'stacked', unit: 'count' },
    // the error text can carry reset links / PII (JobAdmin hides it): only its first line, only for a superuser
    failed: dead.slice(0, 50).map((j) => ({ pk: j.id, task: j.task, queue: j.queue, attempts: j.attempts, at: new Date(Number(j.finishedAt ?? j.createdAt)).toISOString(),
      error: u.isSuperuser && j.error ? String(j.error).split('\n')[0]!.slice(0, 160) : null })),
    canRetry,
  }
}, staff)
const acc1 = (): Acc => { const a = newAcc(); a.count = 1; return a }

// ---- security + logins (superuser) ---------------------------------------------------------------------------------------------
const LOGIN_SERIES = [
  { name: 'ok', label: 'Signed in' }, { name: 'failed', label: 'Failed' }, { name: 'lockout', label: 'Lockouts' },
  { name: 'reset', label: 'Password resets' }, { name: 'new_device', label: 'New device' }, { name: 'two_factor', label: '2FA used' },
]
export async function loginChart(range: Range | undefined): Promise<ChartData> {
  const [sec, act] = await Promise.all([statRows('sec', range), statRows('action', range)])
  const label = (r: StatRow): string | undefined => {
    if (r.key === 'sec') {
      const e = r.dims.e ?? ''
      return e === 'login_ok' ? 'ok' : e === 'login_failed' ? 'failed' : e === 'lockout' ? 'lockout' : /new_device/.test(e) ? 'new_device' : /reset/.test(e) ? 'reset' : /totp|2fa|two_factor|mfa/.test(e) ? 'two_factor' : undefined
    }
    if (r.dims.o !== 'ok') return undefined
    const a = r.dims.a ?? ''
    return /^auth\.(resetPassword|passwordReset(Confirm)?)$/.test(a) ? 'reset' : /^auth\..*(totp|2fa|twoFactor|mfa|otp)/i.test(a) ? 'two_factor' : undefined
  }
  const c = timeSeries([...sec.rows, ...act.rows], sec.r.groupBy, sec.r.from, sec.r.to, LOGIN_SERIES, label)
  return { ...c, title: 'Sign-ins', type: 'stacked', unit: 'count', total: c.points.reduce((n, p) => n + p.values[0]!, 0) }
}
export const systemSecurity = defineAction('admin.system.security', z.object({ range: rangeParam.optional() }), async ({ range }) => {
  const { rows, r } = await statRows('sec', range)
  const counts: Record<string, number> = {}
  for (const x of rows) counts[x.dims.e!] = (counts[x.dims.e!] ?? 0) + x.count
  const names = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]!).slice(0, 8)
  const series = timeSeries(rows, r.groupBy, r.from, r.to, names.map((n) => ({ name: n, label: n.replace(/_/g, ' ') })), (x) => x.dims.e)
  return { counts, series: { ...series, title: 'Security events', type: 'stacked', unit: 'count' }, logins: await loginChart(range), events: [...col().security].reverse().slice(0, 200) }
}, superuser)
