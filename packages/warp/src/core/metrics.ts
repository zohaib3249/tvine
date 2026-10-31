// BACKLOG #9: built-in Prometheus text exposition (no prom-client). One process-global registry: counters and
// histograms are recorded at the call sites, gauges are read at scrape time. A no-op until metrics.enabled (boot
// sets it from settings.metrics.enabled), so instrumented hot paths cost one boolean check when off.
// Low cardinality is a rule, not a hope: labels are fixed enums or registered ids (action ids, cache/db aliases,
// broker kinds) — never a user, sid, ip or raw path. A metric that still grows past MAX_SERIES drops new series.

type Labels = Record<string, string>
type Hist = { b: number[]; sum: number; n: number }

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const MAX_SERIES = 1000

// the catalogue: every metric has a fixed type and help line
const HELP: Record<string, ['counter' | 'histogram' | 'gauge', string]> = {
  tvine_http_request_duration_seconds: ['histogram', 'HTTP requests by transport and status class'],
  tvine_actions_total: ['counter', 'Dispatched actions by action id, outcome (ok or error code) and caller (human/agent)'],
  tvine_ratelimit_hits_total: ['counter', 'Requests refused by a rate limit or connection cap'],
  tvine_sse_connections: ['gauge', 'Open SSE channel streams'],
  tvine_tab_connections: ['gauge', 'Browser tabs connected for agent control'],
  tvine_sessions: ['gauge', 'Sessions held by this process'],
  tvine_tasks_jobs: ['gauge', 'tvine.tasks jobs by status (queue depth), per broker'],
  tvine_tasks_claims_total: ['counter', 'tvine.tasks jobs claimed by workers in this process, per broker'],
  tvine_tasks_failures_total: ['counter', 'tvine.tasks job attempts that failed in this process (retry or dead), per broker'],
  tvine_cache_hits_total: ['counter', 'Cache lookups that hit, per cache alias'],
  tvine_cache_misses_total: ['counter', 'Cache lookups that missed, per cache alias'],
  tvine_mail_sent_total: ['counter', 'Email messages delivered'],
  tvine_mail_failed_total: ['counter', 'Email messages whose delivery failed'],
  tvine_db_query_duration_seconds: ['histogram', 'Database statements by connection alias and kind (query/exec)'],
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}="${esc(l[k]!)}"`).join(',')
const counters = new Map<string, Map<string, number>>()
const hists = new Map<string, Map<string, Hist>>()
const gauges = new Map<string, () => [Labels, number][]>()

function series<T>(all: Map<string, Map<string, T>>, name: string, labels: Labels): { m: Map<string, T>; k: string } | undefined {
  let m = all.get(name)
  if (!m) all.set(name, (m = new Map()))
  const k = key(labels)
  return m.has(k) || m.size < MAX_SERIES ? { m, k } : undefined
}

export const metrics = {
  enabled: false,
  inc(name: string, labels: Labels = {}, by = 1): void {
    if (!metrics.enabled) return
    const s = series(counters, name, labels)
    if (s) s.m.set(s.k, (s.m.get(s.k) ?? 0) + by)
  },
  observe(name: string, labels: Labels, seconds: number): void {
    if (!metrics.enabled) return
    const s = series(hists, name, labels)
    if (!s) return
    let h = s.m.get(s.k)
    if (!h) s.m.set(s.k, (h = { b: BUCKETS.map(() => 0), sum: 0, n: 0 }))
    BUCKETS.forEach((le, i) => { if (seconds <= le) h!.b[i]!++ })
    h.sum += seconds
    h.n++
  },
  // read at scrape time (a failing reader is skipped, never fails the scrape)
  gauge(name: string, read: () => [Labels, number][]): void { gauges.set(name, read) },
  reset(): void { counters.clear(); hists.clear(); gauges.clear() },
  render(): string {
    const out: string[] = []
    const head = (n: string) => { const [t, h] = HELP[n] ?? ['untyped', n]; out.push(`# HELP ${n} ${h}`, `# TYPE ${n} ${t}`) }
    const at = (k: string, extra?: string) => { const all = [k, extra].filter(Boolean).join(','); return all ? `{${all}}` : '' }
    for (const [n, m] of counters) { head(n); for (const [k, v] of m) out.push(`${n}${at(k)} ${v}`) }
    for (const [n, m] of hists) {
      head(n)
      for (const [k, h] of m) {
        BUCKETS.forEach((le, i) => out.push(`${n}_bucket${at(k, `le="${le}"`)} ${h.b[i]}`))
        out.push(`${n}_bucket${at(k, 'le="+Inf"')} ${h.n}`, `${n}_sum${at(k)} ${h.sum}`, `${n}_count${at(k)} ${h.n}`)
      }
    }
    for (const [n, read] of gauges) {
      let rows: [Labels, number][]
      try { rows = read() } catch { continue }
      head(n)
      for (const [l, v] of rows) out.push(`${n}${at(key(l))} ${v}`)
    }
    return out.join('\n') + '\n'
  },
}

// seconds since a performance.now() mark
export const since = (t0: number) => (performance.now() - t0) / 1000

// The in-process stats tap (tvine.admin's dashboard rollups, contrib/admin/stats.ts): one optional listener that
// sees every HTTP request, dispatched action and DB statement, whether or not Prometheus metrics are on. Call sites
// pass low-cardinality labels only (route PATTERNS, registered action ids); SQL text without its params, never values.
// On globalThis: one tap however many copies of warp a process loads.
export type Stat =
  | { k: 'http'; transport: string; status: string; route: string; ms: number }
  | { k: 'action'; action: string; outcome: string; via: string; agent?: string; token?: string; sid?: string; ms: number }
  | { k: 'db'; alias: string; sql: string; ms: number }
  | { k: 'cache'; alias: string; hit: boolean }
  | { k: 'mail'; ok: boolean; n: number }
const TAP = Symbol.for('tvine.statsTap')
export const stats: { tap?: (s: Stat) => void } = ((globalThis as { [TAP]?: { tap?: (s: Stat) => void } })[TAP] ??= {})
export const statTap = (s: Stat): void => { try { stats.tap?.(s) } catch { /* a broken listener never breaks the caller */ } }
