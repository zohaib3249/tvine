// Builds docs/benchmark.html: a self-contained page (data embedded, no libraries, no network) from results.json.
// Run after ./run.sh:  node report.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const here = (p) => new URL(p, import.meta.url)
const r = JSON.parse(readFileSync(here('./results.json'), 'utf8'))

// the latest run for each test (a rerun replaces the run before it)
const latest = (rows, key) => { const m = new Map(); for (const x of rows) { const k = key(x); if (!m.has(k) || m.get(k).at < x.at) m.set(k, x) } return [...m.values()] }
const NAME = { node: 'Raw Node', node_x8: 'Raw Node', tvine: 'Tvine', tvine_x8: 'Tvine', express: 'Express', express_x8: 'Express', fastapi: 'FastAPI', fastapi_x8: 'FastAPI', django_sync: 'Django (sync)', django_gthread: 'Django (threads)', django_x8: 'Django', django_gthread_x8: 'Django' }
const EP = { ping: 'Ping', get: 'One row', list: 'Page of 20', cached: 'Redis cache', post: 'Insert' }
const r1 = (n) => Math.round(n * 10) / 10
const sumCpu = (c) => (Array.isArray(c) ? Math.round(c.reduce((a, b) => a + b, 0)) : Math.round(c ?? 0))
const on = (s) => (/shield/.test(s) ? 'On' : 'Off')
const runs = r.runs
const main = latest(runs.filter((x) => x.section === 'main'), (x) => `${x.server}|${x.kind}`).map((x) => ({
  framework: NAME[x.server] ?? x.server, endpoint: EP[x.kind], rps: Math.round(x.median.reqPerSec), p50: r1(x.median.latency.p50), p99: r1(x.median.latency.p99),
  serverCpu: Math.round(x.median.server.cpuPctAvg), rssMB: Math.round(x.median.server.rssMBMax), clientCpu: sumCpu(x.median.clientCpuPct),
  note: x.server === 'django_sync' ? 'no keep-alive: limited by opening connections' : sumCpu(x.median.clientCpuPct) >= 85 ? 'load tool near its limit: real ceiling may be higher' : '',
}))
const allcores = latest(runs.filter((x) => x.section === 'allcores2'), (x) => `${x.server}|${x.kind}`).map((x) => ({ framework: NAME[x.server] ?? x.server, endpoint: EP[x.kind], rps: Math.round(x.median.reqPerSec), p99: r1(x.median.latency.p99), serverCpu: Math.round(x.median.server.cpuPctAvg), clientCpu: sumCpu(x.median.clientCpuPct) }))
const scale = latest(runs.filter((x) => x.section === 'scale'), (x) => `${x.server}|${x.connections}`).map((x) => ({ framework: NAME[x.server] ?? x.server, connections: x.connections, rps: Math.round(x.median.reqPerSec), p99: r1(x.median.latency.p99) }))
const ramp = latest(runs.filter((x) => x.section === 'ramp'), (x) => `${x.server}|${x.targetRps}`).map((x) => ({ framework: NAME[x.server] ?? x.server, target: x.targetRps, achieved: Math.round(x.median.reqPerSec), p50: r1(x.median.latency.p50), p99: r1(x.median.latency.p99), errPct: Math.round(x.errPct * 100) / 100, held: x.median.latency.p99 <= 200 && x.errPct <= 1 }))
const overhead = latest(runs.filter((x) => x.section === 'shield-overhead'), (x) => `${x.server}|${x.kind}`).map((x) => ({ endpoint: EP[x.kind], shield: on(x.server), rps: Math.round(x.median.reqPerSec), p99: r1(x.median.latency.p99) }))
const TOOL = { mcp_read: 'read_page', mcp_tool: 'action tool (items_get)' }
const mcp = latest(runs.filter((x) => x.section === 'shield-mcp'), (x) => `${x.server}|${x.kind}|${x.connections}`).map((x) => ({ tool: TOOL[x.kind] ?? x.kind, agents: x.connections, shield: on(x.server), rps: Math.round(x.median.reqPerSec), p99: r1(x.median.latency.p99), errors: x.median.errors }))
const flood = latest(runs.filter((x) => x.section === 'shield-flood'), (x) => `${x.server}|${x.label}|${x.connections}`).map((x) => ({
  attack: /1,000/.test(x.label) ? '1,000 IPs' : 'One IP', connections: x.connections, shield: on(x.server), floodRps: Math.round(x.flood.reqPerSec), turnedAway: r1((x.flood.share429 ?? 0) * 100),
  visitorOk: r1((x.legitDuring?.successRate ?? 0) * 100), visitorRequests: x.legitDuring?.total ?? 0, visitorP50: x.legitDuring?.p50 != null ? r1(x.legitDuring.p50) : null, visitorP99: x.legitDuring?.p99 != null ? r1(x.legitDuring.p99) : null,
}))
const m = r.machine, v = r.versions, l = r.settings.load
const setup = [
  ['Machine', `${m.cpu}, ${m.cores} cores, ${m.memGB} GB; the load tool runs on the same machine`],
  ['Runtimes', `Node ${m.node.replace(/^v/, '')}, Python ${v.python.python}, SQLite ${v.python.sqlite} (WAL), Redis 7.2`],
  ['Tvine', `tvinejs ${v.tvine.tvinejs} (commit ${v.tvine.gitCommit}), Next ${v.tvine.next}, tvine start in production mode`],
  ['Express', `Express ${v.express.express} + better-sqlite3 ${v.express.better_sqlite3}`],
  ['FastAPI', `FastAPI ${v.python.fastapi} + uvicorn ${v.python.uvicorn} (uvloop, httptools)`],
  ['Django', `Django ${v.python.django} + gunicorn ${v.python.gunicorn}: a sync worker, and gthread with 8 threads`],
  ['Load', `autocannon ${v.autocannon}; ${l.warmupS} s warm-up, then ${l.reps} × ${l.durationS} s at 50 connections, median kept; an open-loop client for the fixed-rate ramp`],
  ['Data', 'the same 10,000 rows in every app; identical JSON responses checked before timing'],
].map(([item, value]) => ({ item, value }))
const DATA = { main, allcores, scale, ramp, overhead, mcp, flood, setup, at: runs.reduce((a, x) => (x.at > a ? x.at : a), '') }

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tvine benchmark</title>
<meta name="description" content="Tvine vs raw Node, Express, FastAPI and Django on the same JSON API, plus Shield overhead, agent bursts and floods.">
<style>
  :root { --bg: #fbfaf8; --panel: #ffffff; --line: #e6e3de; --fg: #1d1b18; --muted: #6b665e; --accent: #d9480f; --grid: #eeebe6;
    --ok: #2b8a3e; --bad: #c92a2a; --c1: #868e96; --c2: #3b5bdb; --c3: #0c8599; --c4: #9c36b5; --c5: #cc5de8; --c6: #9c36b5;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14130f; --panel: #1c1b17; --line: #33312b; --fg: #ece9e2; --muted: #a39e93; --accent: #ff7a3d; --grid: #2a2824;
    --ok: #69db7c; --bad: #ff8787; --c1: #a3a8ae; --c2: #748ffc; --c3: #3bc9db; --c4: #da77f2; --c5: #e599f7; --c6: #da77f2; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); }
  .wrap { max-width: 72rem; margin-inline: auto; padding: 2.5rem max(16px, env(safe-area-inset-left, 0px)) 4rem max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; gap: 2.5rem; }
  h1 { font: 400 2.4rem/1.15 var(--serif); margin: 0; text-wrap: balance; }
  h2 { font: 400 1.6rem/1.2 var(--serif); margin: 0; }
  h3 { font-size: 1rem; font-weight: 600; margin: 0; }
  p { margin: 0; }
  .lede { max-width: 64ch; font-size: 1.05rem; }
  .lede b, .note b { font-variant-numeric: tabular-nums; }
  .muted, .note { color: var(--muted); }
  .note { font-size: .85rem; line-height: 1.45; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr)); gap: .75rem; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .9rem 1rem; display: flex; flex-direction: column; gap: .2rem; }
  .tile .k { font-size: .8rem; color: var(--muted); }
  .tile .v { font: 400 1.9rem/1.1 var(--serif); font-variant-numeric: tabular-nums; }
  .v.bad { color: var(--bad); } .v.ok { color: var(--ok); } .v.accent { color: var(--accent); }
  section { display: flex; flex-direction: column; gap: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 1rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 1.1rem 1.2rem; display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chart text { fill: var(--muted); font: 12px var(--sans); }
  .chart .strong { fill: var(--fg); font-weight: 600; }
  .legend { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: .8rem; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: .35rem; }
  .legend i { width: .7rem; height: .7rem; border-radius: 2px; display: inline-block; }
  .tip { position: absolute; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,.18); padding: .35rem .6rem; font-size: .8rem; white-space: nowrap; z-index: 2; }
  .tip .t { color: var(--muted); }
  .tablebox { overflow: auto; max-height: 30rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-weight: 600; color: var(--muted); padding: .35rem .6rem; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); white-space: nowrap; }
  td { padding: .35rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; }
  tr.mine td { font-weight: 600; }
  .pill.ok { color: var(--ok); font-weight: 600; } .pill.bad { color: var(--bad); font-weight: 600; }
  ul { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: .35rem; max-width: 72ch; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header style="display:flex;flex-direction:column;gap:.75rem">
    <h1>Tvine benchmark</h1>
    <p class="lede" id="lede"></p>
    <p class="note" id="when"></p>
  </header>
  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Speed on one process</h2>
    <p class="muted" style="max-width:70ch">Each app runs as one process in production mode with the same 10,000 rows. The load tool keeps 50 connections busy and sends the next request the moment one returns, so each bar is that framework's maximum. Shield and Tvine's rate limits are off here.</p>
    <div class="card"><h3>Requests a second, by endpoint (more is better)</h3><p class="note">The same scale on every row. Raw Node and Express reach the load tool's own limit on the fast endpoints, so their real ceiling may be higher. Hover a bar for latency, CPU and memory.</p><div class="legend" id="lg-main"></div><div class="chart" id="ch-main"></div></div>
    <div class="card"><h3>Every run</h3><p class="note">Median of three 15-second runs. Latency in milliseconds; server CPU 100% is one core.</p><div class="tablebox" id="tb-main"></div></div>
  </section>

  <section>
    <h2>All cores and rising load</h2>
    <div class="grid">
      <div class="card"><h3>Eight processes each</h3><p class="note">200 connections from 4 load processes on the same 8 cores. Tvine runs tvine start --workers 8 with sessions and rate limits shared on Redis.</p><div class="legend" id="lg-cores"></div><div class="chart" id="ch-cores"></div></div>
      <div class="card"><h3>One process, more connections</h3><p class="note">One row by id, from 10 to 500 open connections. A flat line means the process was already full at 10.</p><div class="legend" id="lg-scale"></div><div class="chart" id="ch-scale"></div></div>
    </div>
    <div class="card"><h3>Fixed-rate ramp, eight processes</h3><p class="note">The client sends at a fixed rate; a step fails when p99 goes over the dashed line or more than 1% of requests fail (red dots). 100,000 a second was not reachable here: the load processes ran out of CPU first.</p><div class="legend" id="lg-ramp"></div><div class="chart" id="ch-ramp"></div></div>
  </section>

  <section>
    <h2>Shield: cost, agents and floods</h2>
    <div class="grid">
      <div class="card"><h3>Cost per request</h3><p class="note">From 20,000 rotating IPs, so the rate limit never fired: this is the cost of the checks alone.</p><div class="tablebox" id="tb-ov"></div></div>
      <div class="card"><h3>Agents over MCP</h3><p class="note">Agents calling MCP tools at once, with a Claude-User agent name and rotating IPs.</p><div class="tablebox" id="tb-mcp"></div></div>
    </div>
    <div class="card"><h3>A real visitor during a 30-second flood</h3><p class="note">While the flood runs, a separate visitor on another IP asks for a page five times a second. The bar is the share of the visitor's requests that were answered.</p><div class="chart" id="ch-flood"></div><div class="tablebox" id="tb-flood"></div>
      <p class="note">A flood from one IP is turned away by the per-IP limit, which costs far less than serving it, so the visitor keeps getting pages. A flood spread over 1,000 IPs keeps each IP under the limit, so the single process fills up and the visitor's connections are reset. Stopping that needs a whole-site emergency mode and more processes.</p></div>
  </section>


  <section>
    <h2>How it was measured</h2>
    <div class="card"><div class="tablebox" id="tb-setup"></div>
      <ul>
        <li>Everything ran on one laptop, so the load tool and the servers share the same cores. Read the numbers as this machine's limits, not a production ceiling.</li>
        <li>SQLite rather than Postgres; Redis on the same machine.</li>
        <li>Tvine ran as a full app with Next.js and security headers in the same process. Express, FastAPI and raw Node ran with no security middleware.</li>
        <li>The scale, eight-process, MCP and flood results are single runs.</li>
        <li>Tvine and Express were measured with tvinejs 0.3.2; raw Node, FastAPI and Django numbers, and the Shield, MCP and flood runs, are from the earlier run on the same machine.</li>
        <li>The code and the raw results: <code>benchmarks/</code> in the Tvine repository. <code>./run.sh</code> reruns everything; <code>node report.mjs</code> rebuilds this page.</li>
      </ul>
    </div>
  </section>
</div>
<script type="application/json" id="data">${JSON.stringify(DATA).replace(/</g, '\\u003c')}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('data').textContent)
  const FW = ['Tvine', 'Raw Node', 'Express', 'FastAPI', 'Django (threads)', 'Django (sync)', 'Django']
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
  const COLOR = { 'Tvine': '--accent', 'Raw Node': '--c1', 'Express': '--c2', 'FastAPI': '--c3', 'Django (threads)': '--c4', 'Django (sync)': '--c5', 'Django': '--c6' }
  const col = (fw) => 'var(' + (COLOR[fw] || '--c1') + ')'
  const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))
  const ms = (v) => (v == null ? '—' : v >= 100 ? num(v) : v.toFixed(1))
  const NS = 'http://www.w3.org/2000/svg'
  const el = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e }
  const h = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e }
  const by = (id) => document.getElementById(id)
  let measure
  const tw = (s) => { if (!measure) { measure = el('svg', { width: 0, height: 0, style: 'position:absolute;visibility:hidden' }); document.body.append(measure) } const t = el('text', { class: '' }, s); t.style.font = '12px ' + css('--sans'); measure.append(t); const w = t.getComputedTextLength(); t.remove(); return w }
  const tipFor = (host) => {
    const t = h('div', { class: 'tip' }); t.hidden = true; host.append(t)
    return { show(ev, head, lines) { t.replaceChildren(h('div', { class: 't' }, head), ...lines.map((l) => h('div', {}, l))); t.hidden = false
      const b = host.getBoundingClientRect(); let x = ev.clientX - b.left + 12, y = ev.clientY - b.top - t.offsetHeight - 8
      if (x + t.offsetWidth > b.width) x = Math.max(0, ev.clientX - b.left - t.offsetWidth - 12); if (y < 0) y = ev.clientY - b.top + 14
      t.style.left = x + 'px'; t.style.top = y + 'px' }, hide() { t.hidden = true } }
  }
  const legend = (id, names) => by(id).replaceChildren(...names.map((n) => { const s = h('span'); const i = h('i'); i.style.background = col(n); s.append(i, document.createTextNode(n)); return s }))
  const svgIn = (host, w, hgt) => { const s = el('svg', { viewBox: '0 0 ' + w + ' ' + hgt, role: 'img' }); host.replaceChildren(s); return s }

  // horizontal bars: one block per group, every block on one shared scale
  function bars(id, rows, o) {
    const host = by(id), w = Math.max(320, host.clientWidth || 700)
    const groups = o.groups.filter((g) => rows.some((r) => r[o.gk] === g)), items = o.items.filter((i) => rows.some((r) => r[o.ik] === i))
    const labelW = Math.max(...items.map(tw)) + 10, max = Math.max(...rows.map((r) => r[o.vk])) || 1, valW = tw(o.fmt(max)) + 8
    const x = (vv) => (vv / max) * Math.max(40, w - labelW - valW), barH = 14, gap = 4, head = 20, bg = 14
    const height = groups.length * (head + items.length * (barH + gap) + bg)
    const s = svgIn(host, w, height); const tip = tipFor(host); let y = 0
    for (const g of groups) {
      if (o.showGroup !== false) s.append(el('text', { class: 'strong', x: 0, y: y + 13 }, g)); y += o.showGroup !== false ? head : 0
      for (const it of items) {
        const r = rows.find((d) => d[o.gk] === g && d[o.ik] === it); if (!r) continue
        s.append(el('text', { x: labelW - 8, y: y + barH - 3, 'text-anchor': 'end' }, it))
        const rect = el('rect', { x: labelW, y, width: Math.max(1, x(r[o.vk])), height: barH, rx: 2 }); rect.style.fill = o.color(r)
        rect.addEventListener('pointermove', (ev) => tip.show(ev, g === it ? it : g + ' · ' + it, o.tip(r))); rect.addEventListener('pointerleave', () => tip.hide())
        s.append(rect, el('text', { x: labelW + x(r[o.vk]) + 6, y: y + barH - 3 }, o.fmt(r[o.vk])))
        y += barH + gap
      }
      y += bg
    }
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + y)
  }
  // lines over a point x-axis; y linear or log
  function lines(id, rows, o) {
    const host = by(id), w = Math.max(320, host.clientWidth || 700), hgt = 240
    const xs = [...new Set(rows.map((r) => r[o.xk]))].sort((a, b) => a - b), fws = FW.filter((f) => rows.some((r) => r.framework === f))
    const s = svgIn(host, w, hgt), tip = tipFor(host)
    const yMax = Math.max(o.minMax || 0, ...rows.map((r) => r[o.yk])), yMin = o.log ? 1 : 0
    const ticks = o.log ? [1, 10, 100, 1000, 10000].filter((t) => t <= yMax * 1.5) : [0, 1, 2, 3, 4].map((i) => Math.round((yMax * i) / 4))
    const left = Math.max(...ticks.map((t) => tw(o.ytick(t)))) + 10, right = Math.max(...fws.map(tw)) + 14, top = 10, bottom = 26
    const X = (vv) => left + (xs.length === 1 ? 0.5 : xs.indexOf(vv) / (xs.length - 1)) * (w - left - right)
    const Y = (vv) => { const a = o.log ? Math.log10(Math.max(1, vv)) : vv, lo = o.log ? 0 : yMin, hi = o.log ? Math.log10(yMax * 1.5) : yMax; return hgt - bottom - ((a - lo) / (hi - lo || 1)) * (hgt - top - bottom) }
    for (const t of ticks) { const g = el('line', { x1: left, x2: w - right, y1: Y(t), y2: Y(t) }); g.style.stroke = 'var(--grid)'; s.append(g, el('text', { x: left - 6, y: Y(t) + 4, 'text-anchor': 'end' }, o.ytick(t))) }
    for (const vv of xs) s.append(el('text', { x: X(vv), y: hgt - 6, 'text-anchor': 'middle' }, o.xtick(vv)))
    if (o.limit) { const l = el('line', { x1: left, x2: w - right, y1: Y(o.limit), y2: Y(o.limit), 'stroke-dasharray': '4 4' }); l.style.stroke = 'var(--muted)'; s.append(l, el('text', { x: w - right, y: Y(o.limit) - 5, 'text-anchor': 'end' }, o.limitLabel)) }
    for (const f of fws) {
      const pts = rows.filter((r) => r.framework === f).sort((a, b) => a[o.xk] - b[o.xk])
      const p = el('path', { d: pts.map((d, i) => (i ? 'L' : 'M') + X(d[o.xk]).toFixed(1) + ' ' + Y(d[o.yk]).toFixed(1)).join(' '), fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); p.style.stroke = col(f); s.append(p)
      for (const d of pts) { const c = el('circle', { cx: X(d[o.xk]), cy: Y(d[o.yk]), r: 4 }); c.style.fill = o.bad && o.bad(d) ? 'var(--bad)' : col(f)
        c.addEventListener('pointermove', (ev) => tip.show(ev, f + ' · ' + o.xtick(d[o.xk]), o.tip(d))); c.addEventListener('pointerleave', () => tip.hide()); s.append(c) }
      const last = pts[pts.length - 1], lab = el('text', { x: X(last[o.xk]) + 8, y: Y(last[o.yk]) + 4 }, f); lab.style.fill = col(f); s.append(lab)
    }
  }
  function table(id, rows, cols, mine) {
    const t = h('table'), tr = h('tr'); for (const c of cols) tr.append(h('th', c.num ? { class: 'num' } : {}, c.label)); const th = h('thead'); th.append(tr); const tb = h('tbody')
    for (const r of rows) { const row = h('tr', mine && mine(r) ? { class: 'mine' } : {}); for (const c of cols) { const td = h('td', c.num ? { class: 'num' } : {}); const vv = c.fmt ? c.fmt(r[c.key], r) : r[c.key]; if (vv instanceof Node) td.append(vv); else td.textContent = vv == null ? '—' : String(vv); row.append(td) } tb.append(row) }
    t.append(th, tb); by(id).replaceChildren(t)
  }

  const EPS = ['Ping', 'One row', 'Page of 20', 'Redis cache', 'Insert']
  const one = (fw, ep) => (D.main.find((r) => r.framework === fw && r.endpoint === ep) || {}).rps
  const ov = (ep, s) => (D.overhead.find((r) => r.endpoint === ep && r.shield === s) || {}).rps
  const fl = (attack, c, s) => D.flood.find((r) => r.attack === attack && r.connections === c && r.shield === s) || {}
  const tG = one('Tvine', 'One row'), eG = one('Express', 'One row'), fG = one('FastAPI', 'One row'), dG = one('Django (threads)', 'One row')
  const tL = one('Tvine', 'Page of 20'), fL = one('FastAPI', 'Page of 20')
  const cost = Math.round((1 - ov('One row', 'On') / ov('One row', 'Off')) * 1000) / 10
  const ratio = (a, b) => (Math.round((a / b) * 10) / 10).toString()
  const lede = by('lede'); const bold = (s) => { const b = h('b', {}, s); return b }
  lede.append('One Tvine process answered ', bold(num(tG)), ' one-row reads a second. Express answered ', bold(num(eG)), ' on the same logic, ', bold(ratio(eG, tG) + '×'), ' more. Tvine was ', bold(ratio(tG, fG) + '×'), ' faster than FastAPI on one row and ', bold(ratio(tL, fL) + '×'), ' on a page of 20, and ', bold(ratio(tG, dG) + '×'), ' faster than Django. Shield cost ', bold(cost + '%'), ' and kept a real visitor at ', bold(fl('One IP', 1000, 'On').visitorOk + '%'), ' answered during a one-IP flood, against ', bold(fl('One IP', 1000, 'Off').visitorOk + '%'), ' without it.')
  by('when').textContent = 'Measured ' + new Date(D.at).toUTCString().replace(/ GMT$/, ' UTC') + '.'
  const tile = (k, vv, sub, cls) => { const d = h('div', { class: 'tile' }); d.append(h('span', { class: 'k' }, k), h('span', { class: 'v ' + (cls || '') }, vv), h('span', { class: 'k' }, sub)); return d }
  by('tiles').append(
    tile('Tvine, one row, 1 process', num(tG), 'requests a second', 'accent'),
    tile('Express, same test', num(eG), 'requests a second'),
    tile('vs FastAPI, page of 20', ratio(tL, fL) + '×', 'faster on Tvine', 'ok'),
    tile('vs Django, one row', ratio(tG, dG) + '×', 'faster on Tvine', 'ok'),
    tile('Shield cost, one row', cost + '%', 'fewer requests a second'),
    tile('Visitor, 1,000-IP flood', fl('1,000 IPs', 1000, 'On').visitorOk + '%', 'of requests answered', 'bad'))

  const draw = () => {
    bars('ch-main', D.main, { gk: 'endpoint', groups: EPS, ik: 'framework', items: FW, vk: 'rps', fmt: num, color: (r) => col(r.framework), tip: (r) => [num(r.rps) + ' req/s', 'p50 ' + ms(r.p50) + ' ms · p99 ' + ms(r.p99) + ' ms', 'server CPU ' + r.serverCpu + '% · ' + num(r.rssMB) + ' MB'] })
    bars('ch-cores', D.allcores, { gk: 'endpoint', groups: ['Ping', 'One row'], ik: 'framework', items: FW, vk: 'rps', fmt: num, color: (r) => col(r.framework), tip: (r) => [num(r.rps) + ' req/s', 'p99 ' + ms(r.p99) + ' ms', 'server CPU ' + num(r.serverCpu) + '% · load tool ' + num(r.clientCpu) + '%'] })
    lines('ch-scale', D.scale, { xk: 'connections', yk: 'rps', xtick: (vv) => vv + ' conns', ytick: num, tip: (d) => [num(d.rps) + ' req/s', 'p99 ' + ms(d.p99) + ' ms'] })
    lines('ch-ramp', D.ramp, { xk: 'target', yk: 'p99', log: true, minMax: 400, limit: 200, limitLabel: 'p99 limit 200 ms', xtick: (vv) => (vv >= 1000 ? vv / 1000 + 'k' : vv) + '/s', ytick: (t) => num(t) + ' ms', bad: (d) => !d.held, tip: (d) => ['reached ' + num(d.achieved) + '/s', 'p50 ' + ms(d.p50) + ' ms · p99 ' + ms(d.p99) + ' ms', 'errors ' + d.errPct + '% · ' + (d.held ? 'held' : 'failed')] })
    const fls = [...D.flood].sort((a, b) => a.connections - b.connections || a.attack.localeCompare(b.attack) || b.shield.localeCompare(a.shield)).map((r) => ({ ...r, g: r.connections + ' flood connections', label: r.attack + ', Shield ' + r.shield }))
    bars('ch-flood', fls, { gk: 'g', groups: ['500 flood connections', '1000 flood connections'], ik: 'label', items: ['One IP, Shield On', 'One IP, Shield Off', '1,000 IPs, Shield On'], vk: 'visitorOk', fmt: (vv) => vv + '%', color: (r) => (r.visitorOk < 50 ? 'var(--bad)' : r.shield === 'On' ? 'var(--ok)' : 'var(--c1)'), tip: (r) => ['visitor answered ' + r.visitorOk + '% of ' + r.visitorRequests, 'visitor p50 ' + ms(r.visitorP50) + ' ms', 'server answered ' + num(r.floodRps) + '/s, ' + r.turnedAway + '% turned away'] })
  }
  legend('lg-main', FW.filter((f) => D.main.some((r) => r.framework === f)))
  legend('lg-cores', FW.filter((f) => D.allcores.some((r) => r.framework === f)))
  legend('lg-scale', FW.filter((f) => D.scale.some((r) => r.framework === f)))
  legend('lg-ramp', FW.filter((f) => D.ramp.some((r) => r.framework === f)))
  const order = (r) => EPS.indexOf(r.endpoint) * 10 + FW.indexOf(r.framework)
  table('tb-main', [...D.main].sort((a, b) => order(a) - order(b)), [{ key: 'framework', label: 'Framework' }, { key: 'endpoint', label: 'Endpoint' }, { key: 'rps', label: 'Req/s', num: true, fmt: num }, { key: 'p50', label: 'p50 ms', num: true, fmt: ms }, { key: 'p99', label: 'p99 ms', num: true, fmt: ms }, { key: 'serverCpu', label: 'Server CPU %', num: true, fmt: num }, { key: 'rssMB', label: 'Memory MB', num: true, fmt: num }, { key: 'note', label: 'Note' }], (r) => r.framework === 'Tvine')
  const eps = [...new Set(D.overhead.map((r) => r.endpoint))]
  table('tb-ov', eps.map((ep) => ({ endpoint: ep, off: ov(ep, 'Off'), on: ov(ep, 'On'), change: Math.round((ov(ep, 'On') / ov(ep, 'Off') - 1) * 1000) / 10 })), [{ key: 'endpoint', label: 'Endpoint' }, { key: 'off', label: 'Off req/s', num: true, fmt: num }, { key: 'on', label: 'On req/s', num: true, fmt: num }, { key: 'change', label: 'Change %', num: true }])
  table('tb-mcp', [...D.mcp].sort((a, b) => a.tool.localeCompare(b.tool) || a.agents - b.agents || a.shield.localeCompare(b.shield)), [{ key: 'tool', label: 'Tool' }, { key: 'agents', label: 'Agents', num: true }, { key: 'shield', label: 'Shield' }, { key: 'rps', label: 'Req/s', num: true, fmt: num }, { key: 'p99', label: 'p99 ms', num: true, fmt: ms }])
  const pill = (vv) => { const s = h('span', { class: 'pill ' + (vv < 50 ? 'bad' : vv >= 99 ? 'ok' : '') }, vv + ''); return s }
  table('tb-flood', [...D.flood].sort((a, b) => a.connections - b.connections || a.attack.localeCompare(b.attack) || b.shield.localeCompare(a.shield)), [{ key: 'attack', label: 'Flood from' }, { key: 'connections', label: 'Connections', num: true }, { key: 'shield', label: 'Shield' }, { key: 'floodRps', label: 'Server answered req/s', num: true, fmt: num }, { key: 'turnedAway', label: 'Turned away %', num: true }, { key: 'visitorOk', label: 'Visitor answered %', num: true, fmt: pill }, { key: 'visitorP50', label: 'Visitor p50 ms', num: true, fmt: ms }, { key: 'visitorP99', label: 'Visitor p99 ms', num: true, fmt: ms }])
  table('tb-setup', D.setup, [{ key: 'item', label: 'Item' }, { key: 'value', label: 'Value' }])
  draw()
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(draw, 150) })
})()
</script>
</body>
</html>
`
writeFileSync(here('../docs/benchmark.html'), html)
console.log(`docs/benchmark.html: ${(html.length / 1024).toFixed(0)} KB, ${runs.length} runs, measured up to ${DATA.at}`)
