// One load client process. Prints one JSON line with the result.
// node load.mjs '<json>'  where json = { mode: 'cannon' | 'legit', url, kind, connections, duration, warmup, headers, ip, ua, ... }
//   kind: ping | get | list | post | cached | mcp_read | mcp_tool
//   ip:   undefined (no X-Forwarded-For) | 'rotate:<n>' (n distinct IPs, round robin) | a fixed IP string
import autocannon from 'autocannon'
import http from 'node:http'
// legit client uses node:http, not fetch: Node 26's bundled undici threw setTypeOfService EINVAL under the flood
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
const get = (url, r) => new Promise((res, rej) => {
  const q = http.request(url + r.path, { method: r.method, headers: r.headers, agent, timeout: 10_000 }, (p) => { p.resume(); p.on('end', () => res(p.statusCode)) })
  q.on('timeout', () => q.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))); q.on('error', rej); q.end(r.body)
})

const o = JSON.parse(process.argv[2])
let n = 0
const ipOf = (i) => {
  if (!o.ip) return undefined
  if (!o.ip.startsWith('rotate:')) return o.ip
  const k = i % Number(o.ip.slice(7))
  return `11.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`         // public-looking range, never "local"
}
const CATS = ['hats', 'scarves', 'gloves', 'shoes', 'bags', 'belts', 'socks', 'coats']

function build(i) {
  const id = (i % 10000) + 1
  const h = { 'x-tvine-api': '1', ...(o.headers ?? {}) }
  const ip = ipOf(i); if (ip) h['x-forwarded-for'] = ip
  if (o.ua) h['user-agent'] = o.ua
  switch (o.kind) {
    case 'ping': return { method: 'GET', path: '/api/ping', headers: h }
    case 'get': return { method: 'GET', path: `/api/items/${id}`, headers: h }
    case 'list': return { method: 'GET', path: `/api/items?limit=20&offset=${(i * 20) % 10000}`, headers: h }
    case 'cached': return { method: 'GET', path: `/api/cached/${id}`, headers: h }
    case 'post': return { method: 'POST', path: '/api/items', headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `new-${i}`, price: (i % 50000) / 100 + 1, category: CATS[i % 8] }) }
    case 'mcp_read': case 'mcp_tool': {
      const params = o.kind === 'mcp_read'
        ? { name: 'read_page', arguments: { url: '/', view: 'L0' } }
        : { name: 'items_get', arguments: { id, sid: o.sids[i % o.sids.length] } }
      return { method: 'POST', path: '/mcp', headers: { ...h, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params }) }
    }
  }
  throw new Error('kind ' + o.kind)
}

const run = (duration) => autocannon({
  url: o.url, connections: o.connections, duration, pipelining: 1, ...(o.overallRate ? { overallRate: o.overallRate } : {}), timeout: o.timeout ?? 10,
  requests: [{ setupRequest: (req) => Object.assign(req, build(n++)) }],
})

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null }

async function legit() {
  // a low-rate real user: o.rate req/s for o.duration s, keep-alive, own IP
  const lat = [], codes = {}
  let fail = 0
  const end = Date.now() + o.duration * 1000
  let i = 0
  while (Date.now() < end) {
    const t0 = performance.now()
    const r = build(i++)
    try {
      const status = await get(o.url, r)
      codes[status] = (codes[status] ?? 0) + 1
      if (status >= 200 && status < 300) lat.push(performance.now() - t0); else fail++
    } catch (e) { const k = e.code ?? e.name; codes[k] = (codes[k] ?? 0) + 1; fail++ }
    const wait = 1000 / o.rate - (performance.now() - t0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  lat.sort((a, b) => a - b)
  const total = lat.length + fail
  return { total, ok: lat.length, successRate: total ? lat.length / total : null, codes,
    p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: lat.at(-1) ?? null }
}

// open-loop fixed rate (replaces autocannon overallRate for the ramp: its per-connection 1 s quota produced
// ~1 s stalls on an idle 8-worker server). o.rate req/s spread evenly in 1 ms slots over a keep-alive pool of
// o.connections sockets; latency is measured from the SCHEDULED send time, so queueing in the client pool counts.
async function fixedRate() {
  const ag = new http.Agent({ keepAlive: true, maxSockets: o.connections })
  const lat = [], codes = {}
  let errors = 0, sent = 0, done = 0, i = 0
  const c0 = process.cpuUsage(), t0 = performance.now(), end = t0 + o.duration * 1000
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now()
      const due = Math.min(o.rate * o.duration, Math.floor(((Math.min(now, end) - t0) / 1000) * o.rate))
      while (sent < due) {
        const sched = t0 + (sent / o.rate) * 1000; sent++
        const r = build(i++)
        const q = http.request(o.url + r.path, { method: r.method, headers: r.headers, agent: ag, timeout: 10_000 }, (p) => {
          p.resume(); p.on('end', () => { codes[p.statusCode] = (codes[p.statusCode] ?? 0) + 1; lat.push(performance.now() - sched); if (++done === sent && now >= end) resolve() })
        })
        q.on('timeout', () => q.destroy(new Error('timeout')))
        q.on('error', () => { errors++; if (++done === sent && performance.now() >= end) resolve() })
        q.end(r.body)
      }
      if (performance.now() < end) setTimeout(tick, 1); else if (done === sent) resolve(); else setTimeout(tick, 50)
    }
    tick()
  })
  const wall = (performance.now() - t0) / 1000, cu = process.cpuUsage(c0)
  lat.sort((a, b) => a - b)
  const non2xx = Object.entries(codes).filter(([c]) => c < 200 || c >= 300).reduce((a, [, n]) => a + n, 0)
  return { reqPerSec: lat.length / o.duration, reqTotal: lat.length, sent, durationS: wall,
    latency: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: lat.at(-1) ?? null, mean: lat.reduce((a, b) => a + b, 0) / (lat.length || 1) },
    errors, timeouts: 0, non2xx, statusCodes: codes, throughputMBs: null, clientCpuPct: ((cu.user + cu.system) / 1e6 / wall) * 100 }
}

if (o.mode === 'rate') {
  console.log(JSON.stringify(await fixedRate()))
} else if (o.mode === 'legit') {
  console.log(JSON.stringify(await legit()))
} else {
  if (o.warmup) await run(o.warmup)
  const c0 = process.cpuUsage(), w0 = performance.now()
  const r = await run(o.duration)
  const cu = process.cpuUsage(c0), wall = (performance.now() - w0) / 1000
  const sc = Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, v.count]))
  console.log(JSON.stringify({
    reqPerSec: r.requests.average, reqTotal: r.requests.total, durationS: r.duration,
    latency: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max, mean: r.latency.mean },
    errors: r.errors, timeouts: r.timeouts, non2xx: r.non2xx, statusCodes: sc,
    throughputMBs: r.throughput.average / 1e6, clientCpuPct: ((cu.user + cu.system) / 1e6 / wall) * 100,
  }))
}
