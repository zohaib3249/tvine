// Benchmark driver. node bench.mjs <section...>   sections: info sanity main scale allcores shield   (or: all)
// Runs ONE server at a time, ONE load at a time. Appends every run to results.json.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { promisify } from 'node:util'

const B = dirname(fileURLToPath(import.meta.url))
const PY = join(B, '.venv/bin')
const REDIS = 'redis://127.0.0.1:6391'
const RESULTS = process.env.RESULTS ?? join(B, 'results.json')
const TV = join(B, 'apps/tvine_app')
const TV_SECRET = readFileSync(join(TV, '.env'), 'utf8').match(/TVINE_SECRET=(\S+)/)[1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pexec = promisify(execFile)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const FLOOD_S = Number(process.env.FLOOD_S ?? 30)
const WARM = Number(process.env.WARM ?? 5), DUR = Number(process.env.DUR ?? 15); globalThis.DUR_ = DUR
const REPS = Number(process.env.REPS ?? 3)

const tvEnv = (extra = {}) => ({ NODE_ENV: 'production', TVINE_SECRET: TV_SECRET, TVINE_ALLOWED_HOSTS: '127.0.0.1,localhost', DATABASE_URL: 'file:./tvine.db', REDIS_URL: REDIS, ...extra })
const tvBin = join(TV, 'node_modules/tvine/warp/bin/tvine.js')
const uv = (port, workers) => [join(PY, 'uvicorn'), ['main:app', '--host', '127.0.0.1', '--port', String(port), '--workers', String(workers), '--log-level', 'warning', '--no-access-log', '--loop', 'uvloop', '--http', 'httptools']]
const gu = (port, extra) => [join(PY, 'gunicorn'), ['wsgi:application', '-b', `127.0.0.1:${port}`, '--log-level', 'warning', '--backlog', '2048', ...extra]]

const SERVERS = {
  tvine: { port: 5151, cwd: TV, cmd: ['node', [tvBin, 'start', '--port', '5151', '--host', '127.0.0.1']], env: tvEnv(), db: join(TV, 'tvine.db'), fw: 'tvine', desc: 'tvine start, 1 process, NODE_ENV=production, no Shield, limits.rate lifted' },
  express: { port: 5152, cwd: join(B, 'apps/express_app'), cmd: ['node', ['server.mjs']], env: { NODE_ENV: 'production', PORT: '5152', REDIS_URL: REDIS }, db: join(B, 'apps/express_app/app.db'), fw: 'express', desc: 'node server.mjs, 1 process' },
  fastapi: { port: 5153, cwd: join(B, 'apps/fastapi_app'), cmd: uv(5153, 1), env: { REDIS_URL: REDIS }, db: join(B, 'apps/fastapi_app/app.db'), fw: 'fastapi', desc: 'uvicorn --workers 1 --loop uvloop --http httptools --log-level warning --no-access-log' },
  django_sync: { port: 5154, cwd: join(B, 'apps/django_app'), cmd: gu(5154, ['-w', '1']), env: { REDIS_URL: REDIS }, db: join(B, 'apps/django_app/app.db'), fw: 'django', desc: 'gunicorn -w 1 (sync worker)' },
  django_gthread: { port: 5155, cwd: join(B, 'apps/django_app'), cmd: gu(5155, ['-w', '1', '--worker-class', 'gthread', '--threads', '8']), env: { REDIS_URL: REDIS }, db: join(B, 'apps/django_app/app.db'), fw: 'django', desc: 'gunicorn -w 1 --worker-class gthread --threads 8' },
  // Shield section
  tvine_shield: { port: 5156, cwd: TV, cmd: ['node', [tvBin, 'start', '--port', '5156', '--host', '127.0.0.1']], env: tvEnv({ BENCH_SHIELD: '1', BENCH_TRUST_PROXY: '1' }), db: join(TV, 'tvine.db'), fw: 'tvine', desc: 'tvine start + tvine.shield (enforce, default rules), trustProxy 1' },
  tvine_proxy: { port: 5157, cwd: TV, cmd: ['node', [tvBin, 'start', '--port', '5157', '--host', '127.0.0.1']], env: tvEnv({ BENCH_TRUST_PROXY: '1' }), db: join(TV, 'tvine.db'), fw: 'tvine', desc: 'tvine start, Shield OFF, trustProxy 1 (baseline for Shield)' },
  node: { port: 5162, cwd: join(B, 'apps/node_app'), cmd: ['node', ['server.mjs']], env: { NODE_ENV: 'production', PORT: '5162', REDIS_URL: REDIS }, db: join(B, 'apps/node_app/app.db'), fw: 'node', desc: 'raw node:http baseline, 1 process' },
  node_x8: { port: 5163, cwd: join(B, 'apps/node_app'), cmd: ['node', ['cluster.mjs']], env: { NODE_ENV: 'production', PORT: '5163', WORKERS: '8', REDIS_URL: REDIS }, db: join(B, 'apps/node_app/app.db'), fw: 'node', desc: 'raw node:http, node:cluster x8' },
  tvine_prof: { port: 5164, cwd: TV, cmd: ['node', ['--cpu-prof', '--cpu-prof-dir', join(B, 'logs/prof'), tvBin, 'start', '--port', '5164', '--host', '127.0.0.1']], env: tvEnv(), db: join(TV, 'tvine.db'), fw: 'tvine', desc: 'tvine start under node --cpu-prof (same settings as main)' },
  // all-cores variants
  tvine_x8: { port: 5158, cwd: TV, cmd: ['node', ['cluster.mjs', 'start', '--port', '5158', '--host', '127.0.0.1']], env: tvEnv({ WORKERS: '8' }), db: join(TV, 'tvine.db'), fw: 'tvine', desc: 'node:cluster wrapper (apps/tvine_app/cluster.mjs) x8 tvine start — not a built-in Tvine feature' },
  express_x8: { port: 5159, cwd: join(B, 'apps/express_app'), cmd: ['node', ['cluster.mjs']], env: { NODE_ENV: 'production', PORT: '5159', WORKERS: '8', REDIS_URL: REDIS }, db: join(B, 'apps/express_app/app.db'), fw: 'express', desc: 'node:cluster x8' },
  fastapi_x8: { port: 5160, cwd: join(B, 'apps/fastapi_app'), cmd: uv(5160, 8), env: { REDIS_URL: REDIS }, db: join(B, 'apps/fastapi_app/app.db'), fw: 'fastapi', desc: 'uvicorn --workers 8' },
  django_x8: { port: 5161, cwd: join(B, 'apps/django_app'), cmd: gu(5161, ['-w', '8', '--worker-class', 'gthread', '--threads', '4']), env: { REDIS_URL: REDIS }, db: join(B, 'apps/django_app/app.db'), fw: 'django', desc: 'gunicorn -w 8 --worker-class gthread --threads 4' },
}

// ---------------------------------------------------------------- results file
const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { runs: [] }
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 1))
const record = (r) => { results.runs.push({ at: new Date().toISOString(), ...r }); save() }

// ---------------------------------------------------------------- process control
let current = null
function redisCli(...args) { return execFileSync('redis-cli', ['-p', '6391', ...args]).toString().trim() }
async function portFree(port) { try { await pexec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']); return false } catch { return true } }

async function start(name) {
  const s = SERVERS[name]
  if (!(await portFree(s.port))) throw new Error(`port ${s.port} busy`)
  const [cmd, args] = s.cmd
  const p = spawn(cmd, args, { cwd: s.cwd, env: { ...process.env, ...s.env }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
  current = { name, p, port: s.port, err: () => err }
  for (let i = 0; i < 200; i++) {
    await sleep(100)
    if (p.exitCode !== null || p.signalCode !== null) throw new Error(`${name} exited: ${err}`)
    try { const r = await fetch(`http://127.0.0.1:${s.port}/api/ping`, { headers: { 'x-tvine-api': '1' } }); if (r.ok) { await sleep(300); log('started', name, 'pid', p.pid); return p.pid } } catch {}
  }
  throw new Error(`${name} did not come up: ${err}`)
}
async function stop() {
  if (!current) return
  const { p, port, name } = current
  const alive = () => p.exitCode === null && p.signalCode === null
  if (alive()) { p.kill('SIGTERM'); for (let i = 0; i < 100 && alive(); i++) await sleep(100); if (alive()) p.kill('SIGKILL') }
  for (let i = 0; i < 100 && !(await portFree(port)); i++) await sleep(100)
  log('stopped', name); current = null
}
function reseed(name) { execFileSync(join(PY, 'python'), [join(B, 'seed.py'), 'load', SERVERS[name].db]) }

// ---------------------------------------------------------------- sampling (server CPU% from cumulative cpu time, RSS) for the whole process tree
function parseTime(t) { return t.split(':').reduce((a, x) => a * 60 + Number(x), 0) }
async function treeStat(root) {
  const { stdout } = await pexec('ps', ['-Ao', 'pid=,ppid=,time=,rss='])
  const rows = stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, time, rss]) => ({ pid: +pid, ppid: +ppid, cpu: parseTime(time), rss: +rss }))
  const ids = new Set([root]); let grew = true
  while (grew) { grew = false; for (const r of rows) if (ids.has(r.ppid) && !ids.has(r.pid)) { ids.add(r.pid); grew = true } }
  const mine = rows.filter((r) => ids.has(r.pid))
  return { cpu: mine.reduce((a, r) => a + r.cpu, 0), rssKB: mine.reduce((a, r) => a + r.rss, 0), procs: mine.length }
}
function sampler(root) {
  const s = []; let prev; let stopped = false
  const tick = async () => {
    while (!stopped) {
      const t = performance.now(); const st = await treeStat(root).catch(() => null)
      if (st && prev) s.push({ cpuPct: ((st.cpu - prev.cpu) / ((t - prev.t) / 1000)) * 100, rssMB: st.rssKB / 1024, procs: st.procs })
      if (st) prev = { ...st, t }
      await sleep(1000 - (performance.now() - t))
    }
  }
  const done = tick()
  return async () => {
    stopped = true; await done
    const avg = (k) => s.length ? s.reduce((a, x) => a + x[k], 0) / s.length : null
    const max = (k) => s.length ? Math.max(...s.map((x) => x[k])) : null
    return { cpuPctAvg: avg('cpuPct'), cpuPctMax: max('cpuPct'), rssMBAvg: avg('rssMB'), rssMBMax: max('rssMB'), procs: s.at(-1)?.procs, samples: s.length }
  }
}

// ---------------------------------------------------------------- load
function load(opts) {
  return new Promise((res, rej) => {
    const p = spawn('node', [join(B, 'load.mjs'), JSON.stringify(opts)], { cwd: B })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
    p.on('exit', (c) => { try { res(JSON.parse(out.trim().split('\n').at(-1))) } catch { rej(new Error(`load failed ${c}: ${err} ${out}`)) } })
  })
}
// k client processes in parallel; req/s summed, latency percentiles = max over the clients (conservative)
async function loadK(opts, k) {
  if (k === 1) return load(opts)
  const per = Math.round(opts.connections / k)
  const rs = await Promise.all(Array.from({ length: k }, () => load({ ...opts, connections: per })))
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0)
  const codes = {}; for (const r of rs) for (const [c, n] of Object.entries(r.statusCodes)) codes[c] = (codes[c] ?? 0) + n
  return { reqPerSec: sum((r) => r.reqPerSec), reqTotal: sum((r) => r.reqTotal), durationS: rs[0].durationS,
    latency: Object.fromEntries(['p50', 'p90', 'p99', 'max', 'mean'].map((q) => [q, Math.max(...rs.map((r) => r.latency[q]))])),
    errors: sum((r) => r.errors), timeouts: sum((r) => r.timeouts), non2xx: sum((r) => r.non2xx), statusCodes: codes,
    throughputMBs: sum((r) => r.throughputMBs), clientCpuPct: rs.map((r) => r.clientCpuPct), clients: k, latencyNote: 'max over client processes' }
}
function redisStats() { const s = redisCli('info', 'stats'); const g = (k) => Number(s.match(new RegExp(`${k}:(\\d+)`))[1]); return { hits: g('keyspace_hits'), misses: g('keyspace_misses') } }
// retries: gunicorn sync closes every connection, so the client can run out of local ports (EADDRNOTAVAIL)
async function warmCache(port) {
  // fill the cache for every id through the app itself (20 in flight)
  let next = 1
  await Promise.all(Array.from({ length: 20 }, async () => { while (next <= 10000) { const id = next++; for (let t = 0; ; t++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/cached/${id}`, { headers: { 'x-tvine-api': '1' } }); await r.arrayBuffer(); break } catch (e) { if (t > 200) throw e; await sleep(100) } } } }))
}

// gate every run on the local port pool: wait until TIME_WAIT sockets < 2000 (macOS: 16,384 ephemeral ports, MSL 15 s)
async function waitTimeWait() {
  const t0 = Date.now()
  for (;;) {
    const { stdout } = await pexec('sh', ['-c', 'netstat -an -p tcp | grep -c TIME_WAIT || true'])
    const n = Number(stdout.trim())
    if (n < 2000) { if (Date.now() - t0 > 1000) log(`waited ${((Date.now() - t0) / 1000).toFixed(0)} s for TIME_WAIT to drain (now ${n})`); return n }
    await sleep(2000)
  }
}
async function measured(name, pid, opts, { k = 1, before } = {}) {
  if (before) await before()
  const tw = await waitTimeWait()
  const r0 = opts.kind === 'cached' ? redisStats() : null
  const stopS = sampler(pid)
  const r = await loadK(opts, k)
  r.server = await stopS(); r.timeWaitAtStart = tw
  if (r0) { const r1 = redisStats(); const h = r1.hits - r0.hits, m = r1.misses - r0.misses; r.cache = { hits: h, misses: m, hitRatio: h / (h + m) } }
  return r
}
const median = (rs) => [...rs].sort((a, b) => a.reqPerSec - b.reqPerSec)[Math.floor(rs.length / 2)]
function short(r) { return `${Math.round(r.reqPerSec)} rps p50=${r.latency.p50} p99=${r.latency.p99} err=${r.errors} non2xx=${r.non2xx} cpu=${r.server.cpuPctAvg?.toFixed(0)}% rss=${r.server.rssMBMax?.toFixed(0)}MB client=${JSON.stringify(r.clientCpuPct?.toFixed?.(0) ?? r.clientCpuPct?.map((x) => x.toFixed(0)))}%` }

// one endpoint: warm-up (discarded) + REPS measured runs; keep the median by req/s
const CHURN = new Set(['django_sync'])   // no keep-alive: one TCP connection per request
async function bench(section, name, pid, kind, connections, { reps = REPS, k = 1, extra = {}, label } = {}) {
  const churn = CHURN.has(name), DUR = churn ? 10 : globalThis.DUR_
  if (churn) label = [label, 'connection-churn bound (no keep-alive): 10 s runs'].filter(Boolean).join('; ')
  const url = `http://127.0.0.1:${SERVERS[name].port}`
  const opts = { mode: 'cannon', url, kind, connections, ...extra }
  const before = kind === 'cached' ? () => warmCache(SERVERS[name].port) : undefined
  if (before) await before()
  await waitTimeWait()
  await loadK({ ...opts, duration: WARM }, k)
  const runs = []
  for (let i = 0; i < reps; i++) { const r = await measured(name, pid, { ...opts, duration: DUR }, { k, before }); log(section, name, kind, connections, `rep${i + 1}`, short(r)); runs.push(r) }
  const med = median(runs)
  record({ section, server: name, desc: SERVERS[name].desc, label, churnBound: churn || undefined, kind, connections, clients: k, warmupS: WARM, durationS: DUR, reps, median: med, all: runs, opts: { ...opts, sids: undefined } })
  return med
}

// ---------------------------------------------------------------- sections
function bg() { return execFileSync('sh', ['-c', 'ps -Ao %cpu,comm | sort -nr | head -8']).toString() }

async function info() {
  const v = (cmd, args) => { try { return execFileSync(cmd, args).toString().trim() } catch (e) { return String(e.message).slice(0, 100) } }
  const pkg = (dir, n) => { try { return JSON.parse(readFileSync(join(dir, 'node_modules', n, 'package.json'))).version } catch { return null } }
  const py = v(join(PY, 'python'), ['-c', 'import fastapi,uvicorn,starlette,pydantic,redis,django,gunicorn,uvloop,httptools,sqlite3,sys,json;print(json.dumps(dict(python=sys.version.split()[0],fastapi=fastapi.__version__,uvicorn=uvicorn.__version__,starlette=starlette.__version__,pydantic=pydantic.__version__,redis_py=redis.__version__,django=django.__version__,gunicorn=gunicorn.__version__,uvloop=uvloop.__version__,httptools=httptools.__version__,sqlite=sqlite3.sqlite_version)))'])
  const tvPkg = JSON.parse(readFileSync(new URL('../packages/tvine/package.json', import.meta.url)))
  results.machine = {
    cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: os.totalmem() / 2 ** 30, os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version, redis: v('redis-server', ['-v']), somaxconn: v('sysctl', ['-n', 'kern.ipc.somaxconn']),
    backgroundAtStart: bg(),
  }
  results.versions = {
    tvine: { tvinejs: tvPkg.version, gitCommit: v('git', ['-C', new URL('..', import.meta.url).pathname, 'rev-parse', '--short', 'HEAD']), next: pkg(TV, 'next'), react: pkg(TV, 'react'), redis_node: pkg(TV, 'redis'), zod: pkg(TV, 'zod'), better_sqlite3: pkg('/Users/apple/Desktop/CE/tvine/packages/tvine', 'better-sqlite3') },
    express: { express: pkg(join(B, 'apps/express_app'), 'express'), better_sqlite3: pkg(join(B, 'apps/express_app'), 'better-sqlite3'), redis_node: pkg(join(B, 'apps/express_app'), 'redis') },
    python: JSON.parse(py), autocannon: pkg(B, 'autocannon'),
  }
  results.settings = {
    load: { tool: 'autocannon (programmatic, one node process per client)', warmupS: WARM, durationS: DUR, reps: REPS, keep: 'median by req/s', pipelining: 1, timeoutS: 10, header: 'x-tvine-api: 1 sent to every framework (Tvine urls.ts routes require it)' },
    rotation: { ids: '1..10000 cycling', offsets: '(i*20) % 10000, limit 20', post: '{name, price, category} with a counter' },
    servers: Object.fromEntries(Object.entries(SERVERS).map(([k, s]) => [k, { port: s.port, cmd: [s.cmd[0].replace(B, '.'), ...s.cmd[1].map((a) => a.replace(B, '.'))].join(' '), env: Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== 'TVINE_SECRET')), desc: s.desc }])),
    tvineDisabled: 'settings.limits.rate = { limit: 1e9, windowMs: 60000 } (general action limit, also each action default own rate); no tvine.shield; RateLimit middleware not listed (off by default); admin.stats off; db.slowQueryMs 0; logging level warn; debug false; SslRedirect + session.secure dropped from the generated prod.ts (plain http on loopback). Middleware kept: RequestId, AllowedHosts, Security, Cors, GZip (framework defaults).',
  }
  save()
}

async function sanity() {
  const order = ['tvine', 'express', 'fastapi', 'django_sync']
  const paths = ['/api/ping', '/api/items/2', '/api/items?limit=20&offset=40', '/api/cached/7', '/api/cached/7']
  const got = {}
  for (const name of order) {
    reseed(name); redisCli('flushall')
    await start(name)
    const port = SERVERS[name].port, h = { 'x-tvine-api': '1' }
    got[name] = []
    for (const p of paths) { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: h }); got[name].push({ path: p, status: r.status, body: await r.text() }) }
    const r = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sanity', price: 9.99, category: 'hats' }) })
    const b = await r.json(); got[name].push({ path: 'POST /api/items', status: r.status, body: JSON.stringify({ ...b, data: { ...b.data, created_at: typeof b.data?.created_at } }) })
    await stop()
  }
  const canon = (s) => { try { return JSON.stringify(JSON.parse(s)) } catch { return s } }
  const checks = got.tvine.map((t, i) => ({ path: t.path, tvineStatus: t.status, tvineBody: t.body.slice(0, 300),
    identical: Object.fromEntries(order.slice(1).map((n) => [n, got[n][i].status === t.status && canon(got[n][i].body) === canon(t.body)])) }))
  log('sanity', JSON.stringify(checks.map((c) => [c.path, c.identical])))
  results.sanity = { checks, raw: got }; save()
}

async function main_() {
  results.machine.backgroundAtMain = bg(); save()
  const only = process.env.MAIN_SERVERS?.split(','), kinds = process.env.MAIN_KINDS?.split(',') ?? ['ping', 'get', 'list', 'cached', 'post']
  for (const name of only ?? ['tvine', 'express', 'fastapi', 'django_sync', 'django_gthread']) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try {
      for (const kind of kinds) {
        const med = await bench('main', name, pid, kind, 50)
        const cc = med.clientCpuPct
        if (typeof cc === 'number' && cc > 85) {   // the single autocannon process may be the ceiling: one extra 2-client run
          const r2 = await bench('main-2clients', name, pid, kind, 50, { reps: 1, k: 2, label: 'client-bound check: 2 autocannon processes x 25 conns' })
          log('2-client check', name, kind, Math.round(r2.reqPerSec))
        }
      }
    } finally { await stop() }
  }
}

function bestOther() {
  const g = results.runs.filter((r) => r.section === 'main' && r.kind === 'get' && !['tvine', 'node'].includes(r.server))
  return g.sort((a, b) => b.median.reqPerSec - a.median.reqPerSec)[0]?.server ?? 'express'
}
async function scale() {
  const other = bestOther()
  for (const name of process.env.SCALE_SERVERS?.split(',') ?? ['tvine', other]) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try { for (const c of [10, 50, 200, 500]) await bench('scale', name, pid, 'get', c, { reps: 1, label: 'single 15 s run after 5 s warm-up' }) } finally { await stop() }
  }
}
async function allcores() {
  results.machine.backgroundAtAllcores = bg(); save()
  for (const name of ['tvine_x8', 'express_x8', 'fastapi_x8', 'django_x8']) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try { await bench('allcores', name, pid, 'get', 200, { reps: 1, k: 2, label: '8 server processes + 2 autocannon processes (100 conns each) on the same 8 cores' }) } finally { await stop() }
  }
}

async function getSids(port, n) {
  const sids = []
  for (let i = 0; i < n; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'Claude-User/1.0', 'x-forwarded-for': `13.0.${i >> 8}.${i & 255}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_page', arguments: { url: '/', view: 'L0' } } }) })
    const t = await r.text(); const m = t.match(/sid=([A-Za-z0-9_-]+)/); if (m) sids.push(m[1])
  }
  return sids
}

async function flood(name, label, ipSpec, conns = 1000) {
  reseed(name); redisCli('flushall')
  const pid = await start(name)
  try {
    const url = `http://127.0.0.1:${SERVERS[name].port}`
    const legitOpts = { mode: 'legit', url, kind: 'get', rate: 5, ip: '12.34.56.78', ua: 'curl/8.7.1' }
    await waitTimeWait(); log('flood legit-before', name); const before = await load({ ...legitOpts, duration: 10 })
    await waitTimeWait(); log('flood start', name, label)
    const stopS = sampler(pid)
    const [f, during] = await Promise.all([
      load({ mode: 'cannon', url, kind: 'get', connections: conns, duration: FLOOD_S, ip: ipSpec, ua: 'curl/8.7.1', timeout: 10 }),
      (async () => { await sleep(2000); return load({ ...legitOpts, duration: FLOOD_S - 4 }) })(),   // starts once the flood is running
    ])
    f.server = await stopS()
    const total = Object.values(f.statusCodes).reduce((a, b) => a + b, 0)
    f.share429 = total ? (f.statusCodes['429'] ?? 0) / total : null
    f.share200 = total ? (f.statusCodes['200'] ?? 0) / total : null
    log('flood', name, label, `${Math.round(f.reqPerSec)} rps codes=${JSON.stringify(f.statusCodes)} errors=${f.errors} cpu=${f.server.cpuPctAvg?.toFixed(0)}% rss=${f.server.rssMBMax?.toFixed(0)}MB legit before p50=${before.p50?.toFixed(1)} p99=${before.p99?.toFixed(1)} during ok=${during.successRate} p50=${during.p50?.toFixed(1)} p99=${during.p99?.toFixed(1)} codes=${JSON.stringify(during.codes)}`)
    record({ section: 'shield-flood', server: name, desc: SERVERS[name].desc, label, connections: conns, durationS: FLOOD_S, floodIps: ipSpec, flood: f, legitBefore: before, legitDuring: during, legitClient: '5 req/s GET /api/items/<id>, X-Forwarded-For 12.34.56.78, UA curl/8.7.1' })
  } finally { await stop() }
}

async function shield() {
  results.machine.backgroundAtShield = bg(); save()
  const ov = { ip: 'rotate:20000', ua: 'curl/8.7.1' }
  // a) overhead: same app, trustProxy 1, Shield OFF vs ON, 20,000 rotating client IPs so the 300/min/IP rule never fires
  for (const name of ['tvine_proxy', 'tvine_shield']) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try { for (const kind of ['ping', 'get']) await bench('shield-overhead', name, pid, kind, 50, { extra: ov, label: 'X-Forwarded-For rotating over 20,000 IPs, UA curl/8.7.1' }) } finally { await stop() }
  }
  // b) agent burst over MCP (read_page and the typed action tool items_get), Claude-User UA, rotating IPs
  for (const name of ['tvine_shield', 'tvine_proxy']) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try {
      const sids = await getSids(SERVERS[name].port, 200)
      for (const kind of ['mcp_read', 'mcp_tool']) for (const c of [50, 200])
        await bench('shield-mcp', name, pid, kind, c, { reps: 1, extra: { ip: 'rotate:20000', ua: 'Claude-User/1.0', sids }, label: 'MCP tools/call, UA Claude-User/1.0, 20,000 rotating IPs, 200 pre-fetched sids for items_get' })
    } finally { await stop() }
  }
  await floods()
}
async function floods() {
  // c) floods: 1000 connections, 30 s, GET /api/items/<id>, + a 5 req/s legit user on its own IP
  await flood('tvine_shield', 'single-IP flood (12.0.0.1), Shield ON', '12.0.0.1')
  await flood('tvine_shield', 'distributed flood (1,000 rotating IPs), Shield ON', 'rotate:1000')
  await flood('tvine_proxy', 'single-IP flood (12.0.0.1), Shield OFF', '12.0.0.1')
  // 500 connections: below the point where the kernel accept queue (kern.ipc.somaxconn = 128) overflows as badly
  await flood('tvine_shield', 'single-IP flood (12.0.0.1), Shield ON, 500 conns', '12.0.0.1', 500)
  await flood('tvine_shield', 'distributed flood (1,000 rotating IPs), Shield ON, 500 conns', 'rotate:1000', 500)
  await flood('tvine_proxy', 'single-IP flood (12.0.0.1), Shield OFF, 500 conns', '12.0.0.1', 500)
}

async function baseline() {
  reseed('node'); redisCli('flushall')
  const pid = await start('node')
  try { for (const kind of ['ping', 'get', 'list', 'cached', 'post']) await bench('main', 'node', pid, kind, 50) } finally { await stop() }
}
// all cores, every framework, ping + get; K client processes so the client is not the ceiling (client CPU reported)
const KCLI = Number(process.env.KCLI ?? 4)
async function allcores2() {
  results.machine.backgroundAtAllcores2 = bg(); save()
  for (const name of ['node_x8', 'tvine_x8', 'express_x8', 'fastapi_x8', 'django_x8']) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try { for (const kind of ['ping', 'get']) await bench('allcores2', name, pid, kind, 200, { reps: 1, k: KCLI, label: `8 server processes + ${KCLI} autocannon processes (${200 / KCLI} conns each), same 8 cores` }) } finally { await stop() }
  }
}
// fixed-rate ramp on GET /api/items/<id>: Tvine x8 and the best other x8; stop at p99 > 200 ms or errors > 1 %
async function ramp() {
  const others = results.runs.filter((r) => r.section === 'allcores2' && r.kind === 'get' && !['tvine_x8', 'node_x8'].includes(r.server))
  const other = others.sort((a, b) => b.median.reqPerSec - a.median.reqPerSec)[0]?.server ?? 'express_x8'
  for (const name of ['tvine_x8', other]) {
    reseed(name); redisCli('flushall')
    const pid = await start(name)
    try {
      const url = `http://127.0.0.1:${SERVERS[name].port}`
      await sleep(5000)   // let every cluster worker finish booting (start() only proves one worker answers)
      await loadK({ mode: 'cannon', url, kind: 'get', connections: 200, duration: WARM }, KCLI)
      await sleep(3000)
      for (const target of [1000, 5000, 10000, 25000, 50000, 100000]) {
        let r, errPct, bad, attempt = 0
        for (; attempt < 2; attempt++) {   // a failed step is retried once, so one transient stall does not end the ramp
          r = await measured(name, pid, { mode: 'rate', url, kind: 'get', connections: 200, duration: DUR, rate: Math.round(target / KCLI) }, { k: KCLI })
          const total = r.reqTotal + r.errors; errPct = total ? ((r.errors + r.non2xx) / total) * 100 : 0
          bad = r.latency.p99 > 200 || errPct > 1
          log('ramp', name, target, `attempt${attempt + 1}`, short(r), `errPct=${errPct.toFixed(2)}`)
          record({ section: 'ramp', rampVersion: 3, attempt: attempt + 1, server: name, desc: SERVERS[name].desc, kind: 'get', connections: 200, clients: KCLI, targetRps: target, errPct, failed: bad, median: r, label: `open-loop fixed rate ${target} req/s (load.mjs mode rate, 1 ms slots, latency from scheduled send time) split over ${KCLI} client processes x 50 keep-alive sockets` })
          if (!bad) break
        }
        if (bad) { log('ramp stop', name, target); break }
      }
    } finally { await stop() }
  }
}
async function profile() {
  execFileSync('rm', ['-rf', join(B, 'logs/prof')]); execFileSync('mkdir', ['-p', join(B, 'logs/prof')])
  reseed('tvine_prof'); redisCli('flushall')
  const pid = await start('tvine_prof')
  try { await bench('profile', 'tvine_prof', pid, 'get', 50, { reps: 1, label: 'node --cpu-prof, 15 s at 50 conns (profile covers warm-up + run)' }) } finally { await stop() }
}

const SECTIONS = { info, sanity, main: main_, scale, allcores, shield, floods, baseline, allcores2, ramp, profile }
const want = process.argv.slice(2); const list = want.includes('all') ? Object.keys(SECTIONS) : want
if (!results.machine && !list.includes('info')) list.unshift('info')
try { for (const s of list) { log('== section', s); await SECTIONS[s]() } }
catch (e) { console.error(e); if (current) console.error('server stderr:', current.err()) ; process.exitCode = 1 }
finally { await stop() }
