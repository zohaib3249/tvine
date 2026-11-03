// Markdown tables from results.json (the latest run per section/server/kind/connections wins).
import { readFileSync } from 'node:fs'
const R = JSON.parse(readFileSync(new URL('./results.json', import.meta.url)))
const last = new Map()
// the first django_sync runs (15 s, no TIME_WAIT gate) hit ephemeral-port exhaustion; superseded by the 10 s churn-bound reruns
const superseded = (r) => (r.server === 'django_sync' && r.section === 'main' && !r.churnBound) || (r.section === 'ramp' && r.rampVersion !== 3)
for (const r of R.runs) if (!superseded(r)) last.set([r.section, r.server, r.kind, r.connections, r.label].join('|'), r)
const runs = [...last.values()]
const f = (x, d = 0) => (x == null ? '–' : Number(x).toFixed(d))
const cc = (c) => (Array.isArray(c) ? c.map((x) => f(x)).join('+') : f(c))
const row = (r, m = r.median) => `| ${r.server} | ${r.kind} | ${r.connections} | **${f(m.reqPerSec)}** | ${m.latency.p50} | ${m.latency.p90} | ${m.latency.p99} | ${m.latency.max} | ${m.errors} | ${m.non2xx} | ${f(m.server.cpuPctAvg)} | ${f(m.server.rssMBMax)} | ${cc(m.clientCpuPct)} |${m.cache ? ` hit ${f(m.cache.hitRatio * 100, 1)}%` : ''}`
const head = '| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
const sec = (s, title) => { const xs = runs.filter((r) => r.section === s); if (!xs.length) return; console.log(`\n### ${title}\n\n${head}`); for (const r of xs) console.log(row(r)) }

console.log('## By endpoint (main: 1 process each, 50 connections, median of 3 × 15 s)\n')
const kinds = ['ping', 'get', 'list', 'cached', 'post']
const servers = ['node', 'tvine', 'express', 'fastapi', 'django_sync', 'django_gthread']
console.log('| endpoint | ' + servers.join(' | ') + ' |\n|---|' + servers.map(() => '---').join('|') + '|')
for (const k of kinds) {
  const cells = servers.map((s) => { const r = runs.find((x) => x.section === 'main' && x.server === s && x.kind === k); return r ? `${f(r.median.reqPerSec)} (p99 ${r.median.latency.p99})` : '–' })
  console.log(`| ${k} | ${cells.join(' | ')} |`)
}
sec('main', 'Main runs, full detail')
sec('main-2clients', 'Client-bound check (2 autocannon processes)')
sec('scale', 'Scale: GET /api/items/<id> by connections (single run)')
sec('allcores', 'All cores (8 server processes, 2 client processes, 200 conns, single run)')
sec('allcores2', 'All cores v2 (8 server processes, 4 client processes, 200 conns, single run)')
sec('profile', 'Profiled Tvine run')
sec('shield-overhead', 'Shield overhead (trustProxy 1, 20,000 rotating IPs)')
sec('shield-mcp', 'Agent burst over MCP (single run)')
const fl = runs.filter((r) => r.section === 'shield-flood')
if (fl.length) {
  console.log('\n### Floods (30 s, GET /api/items/<id>) + 5 req/s legit user\n')
  console.log('| scenario | conns | flood req/s | 200 | 429 | socket errors | share 429 | server CPU % | RSS MB | legit before p50/p99 ms | legit during success | legit during p50/p99 ms | legit codes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of fl) {
    const x = r.flood
    console.log(`| ${r.label} | ${r.connections} | ${f(x.reqPerSec)} | ${x.statusCodes['200'] ?? 0} | ${x.statusCodes['429'] ?? 0} | ${x.errors} | ${f(x.share429 * 100, 1)}% | ${f(x.server.cpuPctAvg)} | ${f(x.server.rssMBMax)} | ${f(r.legitBefore.p50, 1)} / ${f(r.legitBefore.p99, 1)} | ${f(r.legitDuring.successRate * 100)}% (${r.legitDuring.ok}/${r.legitDuring.total}) | ${f(r.legitDuring.p50, 1)} / ${f(r.legitDuring.p99, 1)} | ${JSON.stringify(r.legitDuring.codes)} |`)
  }
}
const rp = R.runs.filter((r) => r.section === 'ramp' && r.rampVersion === 3)
if (rp.length) {
  console.log('\n### Fixed-rate ramp, GET /api/items/<id>, all cores, 200 conns, 4 clients\n\n| server | target req/s | attempt | achieved req/s (completed / wall time) | p50 ms | p99 ms | max | errors+non2xx % | server CPU % | client CPU % |\n|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rp) { const m = r.median; console.log(`| ${r.server} | ${r.targetRps} | ${r.attempt}${r.failed ? ' (failed)' : ''} | ${f(m.reqTotal / m.durationS)} | ${f(m.latency.p50, 1)} | ${f(m.latency.p99, 1)} | ${f(m.latency.max, 1)} | ${f(r.errPct, 2)} | ${f(m.server.cpuPctAvg)} | ${cc(m.clientCpuPct)} |`) }
}
