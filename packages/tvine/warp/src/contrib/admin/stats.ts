// tvine.admin dashboard statistics. The core stats tap (core/metrics.ts) and the tvine.security log records feed one
// in-process collector:
//  - minute cells for the last hour, 10-second ticks for the Metrics page, small rings (agent sessions, slow queries,
//    security events) — this process only, gone on restart;
//  - hour cells, flushed every settings.admin.stats.flushMs into AdminStat rows (each process rewrites its own rows for
//    the current hour), so longer ranges survive restarts and add up across servers. Old rows go after retentionDays.
// Only low-cardinality labels are kept: route patterns, registered action ids, declared agent names (unverified), SQL
// fingerprints (literals → ?, IN lists collapsed). Never a raw path, a sid (hashed), a param or a bound value.
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { sidHash } from '../../core/audit.js'
import { stats, type Stat } from '../../core/metrics.js'
import type { Settings } from '../../core/types.js'
import { connections } from '../../data/db.js'
import type { MemoryRecord } from '../../log.js'
import { atomic } from '../../data/engine.js'
import { AdminStat } from './models.js'

export const EDGES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]   // ms; one more bucket above the last
export type Dims = Record<string, string>
export interface Acc { count: number; sum: number; max: number; hist: number[] }
export interface StatRow extends Acc { bucket: Date; key: string; dims: Dims }

const newAcc = (): Acc => ({ count: 0, sum: 0, max: 0, hist: new Array(EDGES.length + 1).fill(0) })
const slot = (ms: number) => { const i = EDGES.findIndex((e) => ms <= e); return i < 0 ? EDGES.length : i }
function addTo(a: Acc, ms?: number, by = 1): void {
  a.count += by
  if (ms === undefined) return
  a.sum += ms; a.max = Math.max(a.max, ms); a.hist[slot(ms)]!++
}
export function merge(into: Acc, a: Acc): Acc {
  into.count += a.count; into.sum += a.sum; into.max = Math.max(into.max, a.max)
  for (let i = 0; i < into.hist.length; i++) into.hist[i]! += a.hist[i] ?? 0
  return into
}
export { newAcc }
// the q-quantile from merged buckets: the bucket's upper edge (capped by the max seen)
export function quantile(a: Acc, q: number): number {
  const n = a.hist.reduce((x, y) => x + y, 0)
  if (!n) return 0
  let c = 0
  for (let i = 0; i < a.hist.length; i++) { c += a.hist[i]!; if (c >= q * n) return Math.min(EDGES[i] ?? a.max, a.max || EDGES[i]!) }
  return a.max
}

// SQL → fingerprint, by scanning (not regex-replacing) the statement: every literal becomes ?, whatever its quoting —
// '…' with '' or \' escapes, E'…', $tag$…$tag$, MySQL "…" strings (mysql: true; elsewhere "…" is an identifier),
// numbers incl. hex and 1e5 — params ($n, ?) stay ?, comments go, IN lists collapse to (?…). The ORM already sends
// params, so this mostly normalizes; an unterminated literal swallows the rest (never leaks it).
export function fingerprint(sql: string, o: { mysql?: boolean } = {}): string {
  let out = '', i = 0
  const n = sql.length
  const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c)
  const quoted = (q: string, backslash: boolean) => {   // i at the opening quote; returns the index after the closing one
    let j = i + 1
    while (j < n) {
      const c = sql[j]!
      if (backslash && c === '\\') { j += 2; continue }
      if (c === q) { if (sql[j + 1] === q) { j += 2; continue } return j + 1 }
      j++
    }
    return n
  }
  while (i < n) {
    const c = sql[i]!, prev = out[out.length - 1]
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e; continue }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue }
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'" && !isWord(prev)) { i++; i = quoted("'", true); out += '?'; continue }
    if (c === "'") { i = quoted("'", true); out += '?'; continue }
    if (c === '"') {
      if (o.mysql) { i = quoted('"', true); out += '?'; continue }
      const e = quoted('"', false); out += sql.slice(i, e); i = e; continue   // an identifier
    }
    if (c === '`') { const e = quoted('`', false); out += sql.slice(i, e); i = e; continue }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(sql.slice(i, i + 12))
      if (m) { out += '?'; i += m[0].length; continue }
      const t = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 66))
      if (t && !isWord(prev)) { const e = sql.indexOf(t[0], i + t[0].length); i = e < 0 ? n : e + t[0].length; out += '?'; continue }
    }
    if (/[0-9.]/.test(c) && !isWord(prev)) {
      const m = /^(?:0x[0-9a-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(sql.slice(i, i + 64))
      if (m) { out += '?'; i += m[0].length; continue }
    }
    out += c; i++
  }
  return out.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?…)').replace(/\s+/g, ' ').trim().slice(0, 300)
}
const clean = (s: string, n = 60) => s.replace(/[\0-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').trim().slice(0, n)
export const AGENT_VIA = new Set(['agent', 'webmcp', 'tab'])
// ---- visitor searches + page views (Top searches / Most visited pages) ------------------------------------------------
// a search term as counted: trimmed, lowercased, one space, ≤ 64 chars. undefined = not counted: empty, or it looks like
// personal data or a secret (an email, a phone / card / long digit run, a token or hex string over 20 chars)
export function searchTerm(raw: string): string | undefined {
  const t = clean(raw.normalize('NFKC'), 1000).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 64).trim()
  if (!t) return undefined
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return undefined                                  // email
  if (/\d{7,}/.test(t.replace(/(?<=\d)[\s().+\-/]+(?=\d)/g, ''))) return undefined          // phone, card, long digit run
  if (/[0-9a-f]{21,}/.test(t) || t.split(' ').some((w) => w.length > 20 && /\d/.test(w))) return undefined   // hex / token
  return t
}
const ASSET = /^\/_next\/|\.(?:m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|mp4|webm|mp3|pdf|zip)$/i
// a page view's path as counted: no fragment, no query except settings.admin.stats.pages.keepParams, never an excluded
// prefix (admin, /tvine, media) or a static asset. undefined = not counted.
export function pagePath(raw: string, keep: string[] = [], skip: string[] = ['/admin', '/tvine', '/media']): string | undefined {
  const [path = '', query = ''] = raw.split('#')[0]!.split('?')
  let p = path || '/'
  try { p = decodeURI(p) } catch { /* keep it encoded */ }
  p = p.replace(/\/{2,}/g, '/')
  if (skip.some((s) => s && (p === s || p.startsWith(s.endsWith('/') ? s : `${s}/`))) || ASSET.test(p)) return undefined
  const q = new URLSearchParams(query)
  const kept = keep.filter((k) => q.has(k)).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q.get(k)!.slice(0, 64))}`)
  return clean(p, 200) + (kept.length ? `?${kept.join('&')}` : '')
}
export const OTHER = '(other)'
const CAPS: Record<string, [dim: string, n: number]> = { search: ['term', 500], searcher: ['term', 500], page: ['p', 1000], visitor: ['p', 1000], entry: ['p', 1000], shield_country: ['g', 1000], shield_asn: ['a', 1000], shield_rule: ['r', 1000] }
const MAX_DIMS = 300                 // distinct dims per key per cell; more fold into { other: '1' }
const HOUR = 3_600_000, MIN = 60_000, TICK = 10_000

type Cells = Map<string, { key: string; dims: Dims; acc: Acc }>
export interface Tick { t: number; requests: number; errors: number; human: number; agent: number; acc: Acc }
export interface AgentSession { id: string; agent: string; via: string; lastAction: string; lastAt: number; actions: number; recent: number[]; page?: string }
export interface SecEvent { t: string; event: string; level: string; ip?: string; userId?: string; via?: string; path?: string; action?: string }

export class Collector {
  readonly node = randomBytes(6).toString('hex')
  private hour = { start: 0, cells: new Map() as Cells }
  private done: { start: number; cells: Cells }[] = []        // finished hours not yet flushed
  readonly minutes = new Map<number, Cells>()
  readonly ticks: Tick[] = []
  readonly sessions = new Map<string, AgentSession>()
  readonly recent: { t: string; agent: string; via: string; action: string; outcome: string; session: string }[] = []
  readonly slow: { t: string; fingerprint: string; ms: number; alias: string }[] = []
  readonly security: SecEvent[] = []
  mailFailedAt?: number
  private flushing?: Promise<void>
  private lastPrune = 0
  private readonly capSeen = new WeakMap<Cells, Map<string, Set<string>>>()
  private distinct = { hour: 0, seen: new Set<string>() }   // (key, term/path, visitor hash) seen this hour
  onLive?: (type: 'agent' | 'security' | 'tick' | 'shield') => void

  constructor(readonly o: {
    slowMs: number; retentionDays: number; now?: () => number
    mysql?: (alias: string) => boolean          // the alias's dialect quotes strings with "…" too
    route?: (path: string) => string | undefined // a page path → its route pattern (agent sessions show patterns)
    key?: string                                 // HMAC key for token labels (settings.secret): stable across servers
    searches?: { enabled: boolean }
    pages?: { enabled: boolean; keepParams: string[]; skip?: string[] }   // skip: path prefixes never counted (admin, media)
  } = { slowMs: 100, retentionDays: 30 }) {}
  private now(): number { return this.o.now?.() ?? Date.now() }

  private inc(key: string, dims: Dims, ms?: number, by = 1): void {
    const now = this.now()
    const h = Math.floor(now / HOUR) * HOUR
    if (h !== this.hour.start) {
      if (this.hour.cells.size) this.done.push(this.hour)
      this.hour = { start: h, cells: new Map() }
    }
    const m = Math.floor(now / MIN) * MIN
    let mc = this.minutes.get(m)
    if (!mc) {
      this.minutes.set(m, (mc = new Map()))
      for (const k of this.minutes.keys()) if (k < m - HOUR) this.minutes.delete(k)
    }
    for (const cells of [this.hour.cells, mc]) {
      const cap = CAPS[key]
      if (cap) {   // first N distinct terms / paths per cell (hour and minute), the rest fold into (other)
        let seen = this.capSeen.get(cells)
        if (!seen) this.capSeen.set(cells, (seen = new Map()))
        let s = seen.get(key)
        if (!s) seen.set(key, (s = new Set()))
        const v = dims[cap[0]]!
        if (!s.has(v)) { if (s.size >= cap[1]) dims = { ...dims, [cap[0]]: OTHER }; else s.add(v) }
      }
      let id = key + '\0' + JSON.stringify(dims)
      let c = cells.get(id)
      if (!c) {
        let n = 0
        for (const x of cells.values()) if (x.key === key) n++
        if (n >= MAX_DIMS && !cap) { id = key + '\0{"other":"1"}'; c = cells.get(id) }
        if (!c) cells.set(id, (c = { key, dims: n >= MAX_DIMS && !cap ? { other: '1' } : dims, acc: newAcc() }))
      }
      addTo(c.acc, ms, by)
    }
  }

  private tick(): Tick {
    const t = Math.floor(this.now() / TICK) * TICK
    let last = this.ticks[this.ticks.length - 1]
    if (!last || last.t !== t) {
      this.ticks.push((last = { t, requests: 0, errors: 0, human: 0, agent: 0, acc: newAcc() }))
      if (this.ticks.length > 360) this.ticks.splice(0, this.ticks.length - 360)
      this.onLive?.('tick')
    }
    return last
  }

  record(s: Stat): void {
    if (s.k === 'http') {
      const stream = s.transport === 'channel'   // SSE streams are long-lived: counted, never timed
      this.inc('http', { t: s.transport, s: s.status }, stream ? undefined : s.ms)
      this.inc('route', { r: clean(s.route, 200), e: s.status === '5xx' ? '1' : '0' }, stream ? undefined : s.ms)
      if (!stream) {
        const k = this.tick()
        k.requests++
        if (s.status === '5xx') k.errors++
        addTo(k.acc, s.ms)
      }
      return
    }
    if (s.k === 'search') {
      if (this.o.searches?.enabled === false) return
      const term = searchTerm(s.term)
      if (!term) return
      this.inc('search', { term, v: AGENT_VIA.has(s.via) ? 'a' : 'h', z: s.results === 0 ? '1' : '0' })
      if (this.first('searcher', term, s.sid)) this.inc('searcher', { term })
      return
    }
    if (s.k === 'page') {
      if (this.o.pages?.enabled === false) return
      const p = pagePath(s.path, this.o.pages?.keepParams, this.o.pages?.skip)
      if (!p) return
      this.inc('page', { p, v: s.agent ? 'a' : 'h' })
      if (s.agent) return
      if (this.first('visitor', p, s.sid)) this.inc('visitor', { p })
      if (s.entry) this.inc('entry', { p })
      return
    }
    if (s.k === 'cache') { this.inc('cache', { c: s.alias, h: s.hit ? '1' : '0' }); return }
    if (s.k === 'shield') {   // tvine.shield rollups: decisions by category, plus top-N dims of the notable ones (capped per hour)
      const d = s.decision
      this.inc('shield', { d, c: s.category, m: s.mode }, s.score)
      this.inc('shield_score', { b: String(Math.min(9, Math.floor(s.score / 10))) })
      if (d !== 'pass' && d !== 'allow') {
        if (s.country) this.inc('shield_country', { g: s.country, d })
        if (s.asn) this.inc('shield_asn', { a: String(s.asn), d })
      }
      if (s.rule) this.inc('shield_rule', { r: clean(s.rule, 64), d })
      this.onLive?.('shield')
      return
    }
    if (s.k === 'mail') {
      this.inc('mail', { ok: s.ok ? '1' : '0' }, undefined, s.n)
      if (!s.ok) this.mailFailedAt = this.now()
      return
    }
    if (s.k === 'db') {
      const f = fingerprint(s.sql, { mysql: this.o.mysql?.(s.alias) })
      if (/\badmin_stat\b/.test(f)) return   // the rollup's own writes are not the app's queries
      this.inc('db', { f, d: s.alias }, s.ms)
      if (s.ms >= this.o.slowMs) {
        this.slow.push({ t: new Date(this.now()).toISOString(), fingerprint: f, ms: Math.round(s.ms), alias: s.alias })
        if (this.slow.length > 100) this.slow.shift()
      }
      return
    }
    const agent = AGENT_VIA.has(s.via)
    this.inc('action', { a: s.action, o: s.outcome, v: s.via }, s.ms)
    const k = this.tick()
    if (agent) k.agent++; else k.human++
    if (s.token) this.inc('token', { u: `token user #${createHmac('sha256', this.o.key ?? this.node).update(s.token).digest('hex').slice(0, 10)}` })   // never the user id
    if (!agent) return
    const name = clean(s.agent ?? '') || '(unnamed)'
    this.inc('agent', { n: name, v: s.via })
    const id = (sidHash(s.sid) ?? 'none').slice(0, 12)
    const now = this.now()
    let x = this.sessions.get(id)
    if (!x) {
      if (this.sessions.size >= 500) this.prune(now, true)
      this.sessions.set(id, (x = { id, agent: name, via: s.via, lastAction: s.action, lastAt: now, actions: 0, recent: [] }))
    }
    x.agent = name; x.via = s.via; x.lastAction = s.action; x.lastAt = now; x.actions++
    x.recent.push(now)
    while (x.recent.length && x.recent[0]! < now - 5 * MIN) x.recent.shift()
    this.recent.push({ t: new Date(now).toISOString(), agent: name, via: s.via, action: s.action, outcome: s.outcome, session: id })
    if (this.recent.length > 200) this.recent.shift()
    this.onLive?.('agent')
  }

  // the first time this hour that this visitor (a keyed hash of the session, never the raw sid) hit key/value
  private first(key: string, value: string, sid: string | undefined): boolean {
    if (!sid) return false
    const h = Math.floor(this.now() / HOUR)
    if (h !== this.distinct.hour) this.distinct = { hour: h, seen: new Set() }
    const id = `${key}\0${value}\0${createHmac('sha256', this.o.key ?? this.node).update(sid).digest('base64url').slice(0, 16)}`
    if (this.distinct.seen.has(id) || this.distinct.seen.size >= 200_000) return false   // ponytail: per-hour distinct, summed across hours; HyperLogLog if exact uniques over days matter
    this.distinct.seen.add(id)
    return true
  }

  // an agent's page read (ServerCtx 'read' hook): where its session is now
  read(sid: string, page: string): void {
    this.record({ k: 'page', path: page, agent: true, sid, entry: false })
    const x = this.sessions.get((sidHash(sid) ?? '').slice(0, 12))
    if (!x) return
    const path = page.split('?')[0]!
    let pattern: string | undefined
    try { pattern = this.o.route?.(path) } catch { pattern = undefined }
    x.page = clean(pattern ?? '(unmatched)', 200); x.lastAt = this.now()   // a route pattern, never the raw path
  }

  // a tvine.security log record (memory log ring subscriber)
  log(r: MemoryRecord): void {
    if (r.logger !== 'tvine.security') return
    const event = clean(String(r.event ?? r.msg), 40)
    this.inc('sec', { e: event })
    const s = (k: string) => (r[k] == null ? undefined : clean(String(r[k]), 120))
    this.security.push({ t: r.t, event, level: r.level, ip: s('ip'), userId: s('userId'), via: s('via'), path: s('path'), action: s('action') })
    if (this.security.length > 500) this.security.shift()
    this.onLive?.('security')
  }

  private prune(now: number, force = false): void {
    for (const [k, v] of this.sessions) if (force ? v.lastAt < now - 10 * MIN : v.lastAt < now - HOUR) this.sessions.delete(k)
  }

  // in-memory rows of the last hour (minute buckets) for one key
  memoryRows(key: string, since: number): StatRow[] {
    const out: StatRow[] = []
    for (const [m, cells] of this.minutes) if (m >= since) for (const c of cells.values()) if (c.key === key) out.push({ bucket: new Date(m), key, dims: c.dims, ...c.acc })
    return out
  }

  // write this process's rows for the finished hours + the current hour (delete own rows of that hour, insert)
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.prune(this.now())
    const todo = [...this.done.splice(0), this.hour]
    const write = async () => {
      for (const h of todo) {
        if (!h.cells.size) continue
        const bucket = new Date(h.start)
        const rows = [...h.cells.values()].map((c) => ({ bucket, node: this.node, key: c.key, dims: c.dims, ...structuredClone(c.acc) }))
        await atomic(async () => {   // one transaction: a reader never sees this hour's rows half-replaced
          await AdminStat.objects.filter({ bucket, node: this.node }).delete()   // scope: ok (internal rollup table)
          await AdminStat.objects.bulkCreate(rows, { batchSize: 200 })   // scope: ok
        })
      }
      const now = this.now()
      if (now - this.lastPrune > HOUR) {
        this.lastPrune = now
        await AdminStat.objects.filter({ bucket__lt: new Date(now - this.o.retentionDays * 24 * HOUR) }).delete()   // scope: ok
      }
    }
    return (this.flushing = write().finally(() => { this.flushing = undefined }))
  }
}

// ---- reads ------------------------------------------------------------------------------------------------------------
export const rangeParam = z.union([z.enum(['1h', '24h', '7d', '30d', '90d', '1y']), z.object({ from: z.string().max(40), to: z.string().max(40) })])
export type Range = '1h' | '24h' | '7d' | '30d' | '90d' | '1y' | { from: string; to: string }
export type GroupBy = 'minute' | 'hour' | 'day' | 'week' | 'month'
const DAYS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
export function rangeOf(r: Range | undefined, now = Date.now()): { from: Date; to: Date; groupBy: GroupBy; prevFrom: Date } {
  if (r && typeof r === 'object') {
    const from = new Date(r.from), to = new Date(r.to)
    if (isNaN(+from) || isNaN(+to) || to <= from) throw new Error('range: from must be before to')
    const span = +to - +from
    if (span > 400 * 24 * HOUR) throw new Error('range: at most 400 days')
    return { from, to, groupBy: span <= 2 * 24 * HOUR ? 'hour' : span <= 120 * 24 * HOUR ? 'day' : 'week', prevFrom: new Date(+from - span) }
  }
  if (r === '1h') return { from: new Date(now - HOUR), to: new Date(now), groupBy: 'minute', prevFrom: new Date(now - 2 * HOUR) }
  const d = DAYS[r ?? '24h'] ?? 1
  const span = d * 24 * HOUR
  return { from: new Date(now - span), to: new Date(now), groupBy: d === 1 ? 'hour' : d <= 90 ? 'day' : 'week', prevFrom: new Date(now - 2 * span) }
}
const UNIT: Record<GroupBy, number> = { minute: MIN, hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR }
export function floorTo(t: number, g: GroupBy): number {
  if (g === 'month') { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
  if (g === 'week') { const d = Math.floor(t / UNIT.day) * UNIT.day; return d - ((new Date(d).getUTCDay() + 6) % 7) * UNIT.day }   // Monday
  return Math.floor(t / UNIT[g]) * UNIT[g]
}
export function bucketsOf(from: Date, to: Date, g: GroupBy): number[] {
  const out: number[] = []
  for (let t = floorTo(+from, g); t <= +to && out.length < 1000; ) {
    out.push(t)
    if (g === 'month') { const d = new Date(t); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) } else t += UNIT[g]
  }
  return out
}

export interface ChartData {
  id?: string; title?: string; type?: string; unit?: 'count' | 'money' | 'number' | 'ms' | 'percent'; currency?: string
  groupBy?: GroupBy | 'category'; series: { name: string; label: string }[]; points: { x: string; values: number[] }[]
  total?: number; previous?: number
}
export interface Table { columns: string[]; rows: (string | number)[][] }

// rows → a time series: one series per label (label(row) undefined = skipped), value per bucket
export function timeSeries(rows: StatRow[], g: GroupBy, from: Date, to: Date, series: { name: string; label: string }[],
  label: (r: StatRow) => string | undefined, value: (a: Acc) => number = (a) => a.count): ChartData {
  const bs = bucketsOf(from, to, g)
  const idx = new Map(bs.map((b, i) => [b, i]))
  const cells = bs.map(() => series.map(() => newAcc()))
  const si = new Map(series.map((s, i) => [s.name, i]))
  for (const r of rows) {
    const s = label(r), i = idx.get(floorTo(+r.bucket, g))
    if (s === undefined || i === undefined || !si.has(s)) continue
    merge(cells[i]![si.get(s)!]!, r)
  }
  return { groupBy: g, series, points: bs.map((b, i) => ({ x: new Date(b).toISOString(), values: cells[i]!.map((a) => round(value(a))) })) }
}
export const round = (n: number) => Math.round(n * 100) / 100
// rows → per label merged accumulators, sorted by `by`, top n
export function topOf(rows: StatRow[], label: (r: StatRow) => string | undefined, n = 10, by: (a: Acc) => number = (a) => a.count): [string, Acc][] {
  const m = new Map<string, Acc>()
  for (const r of rows) {
    const k = label(r)
    if (k === undefined) continue
    merge(m.get(k) ?? (m.set(k, newAcc()), m.get(k)!), r)
  }
  return [...m].sort((a, b) => by(b[1]) - by(a[1])).slice(0, n)
}

// the collector for this process's settings (the web server's ready() and `tvine worker`)
export function newCollector(settings: Settings, route?: (path: string) => string | undefined): Collector {
  const secret = settings.secret
  return new Collector({
    slowMs: settings.db.slowQueryMs || 100, retentionDays: settings.admin.stats.retentionDays, route,
    mysql: (alias) => { try { return connections.get(alias).dialect.name === 'mysql' } catch { return false } },
    key: Array.isArray(secret) ? secret[0] : secret,
    searches: settings.admin.stats.searches,
    pages: { ...settings.admin.stats.pages, skip: [settings.admin.path, '/tvine', '/media', settings.media.route.replace(/\/$/, '')] },
  })
}
// tap + periodic flush; the returned stop() unhooks and flushes once more
export function startStats(col: Collector, flushMs: number, log: (level: 'warn', msg: string, data?: Record<string, unknown>) => void): () => Promise<void> {
  const tap = (s: Stat) => col.record(s)
  stats.tap = tap
  const timer = setInterval(() => { col.flush().catch((e: unknown) => log('warn', 'admin stats flush failed', { error: (e as Error).message })) }, flushMs)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    if (stats.tap === tap) stats.tap = undefined
    await col.flush().catch(() => { /* the database may already be closed */ })
  }
}
