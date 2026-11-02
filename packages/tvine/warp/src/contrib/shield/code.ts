// tvine.shield code rules: a rule whose action is admin-written JavaScript, run in a QuickJS (WebAssembly) sandbox.
// quickjs-emscripten-core is loaded in a worker thread spawned on the first code rule / check / run: apps without code rules load nothing.
// Fail-open: compile error, throw, timeout, OOM, invalid return → the rule is skipped for that request, counted per rule.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { Settings } from '../../core/types.js'
import { getLogger } from '../../log.js'
import type { Action, Signals } from './types.js'

export const CODE_MAX = 20_000
export const CODE_TEMPLATE = `// Runs for each request this rule's conditions match. Keep it fast (5 ms limit) and pure.
// req: a read-only copy of the request (see the field list). Return nothing to let the next rule decide,
// or ONE action:
//   { type: 'allow' } | { type: 'log' }
//   { type: 'block', status?: 403 | 404 | 429 | 451, message?: string }
//   { type: 'challenge', level?: 'auto' | 'pow' | 'checkbox' | 'captcha' }
//   { type: 'rateLimit', limit: number, window: '10s' | '1m' | '1h', key?: 'ip' | 'asn' | 'path' }
export default function rule(req) {
  if (req.path.startsWith('/admin') && req.country !== 'PK') return { type: 'challenge', level: 'auto' }
}
`
export const CODE_FIELDS: { name: string; type: string; description: string }[] = [
  { name: 'ip', type: 'string', description: 'client IP' },
  { name: 'ipNet', type: 'string', description: 'its /24 (IPv4) or /64 (IPv6)' },
  { name: 'country', type: 'string?', description: 'ISO country code, e.g. "IS"' },
  { name: 'continent', type: 'string?', description: 'continent code, e.g. "EU"' },
  { name: 'asn', type: 'number?', description: 'network (AS) number' },
  { name: 'asnOrg', type: 'string?', description: 'network owner name' },
  { name: 'asnKind', type: "'datacenter' | 'residential' | 'mobile' | 'unknown'?", description: 'network kind' },
  { name: 'tor', type: 'boolean', description: 'a Tor exit node' },
  { name: 'local', type: 'boolean', description: 'loopback / private network' },
  { name: 'path', type: 'string', description: 'URL path, no query' },
  { name: 'query', type: 'string?', description: 'the query string, without "?"' },
  { name: 'method', type: 'string', description: 'GET, POST, …' },
  { name: 'host', type: 'string', description: 'Host header' },
  { name: 'ua', type: 'string', description: 'User-Agent' },
  { name: 'uaFamily', type: 'string?', description: 'chrome, firefox, safari, curl, …' },
  { name: 'bot.name', type: 'string?', description: 'known bot name, e.g. "GPTBot"' },
  { name: 'bot.category', type: 'string?', description: 'search | ai-crawler | ai-agent | monitor | seo | scraper | scanner | automation | browser | unknown' },
  { name: 'bot.verified', type: 'boolean', description: 'bot identity checked (rDNS, IP ranges, Web Bot Auth)' },
  { name: 'bot.spoofed', type: 'boolean', description: 'claims a verified bot, failed the check' },
  { name: 'score', type: 'number', description: '1 (bot) .. 99 (human)' },
  { name: 'headerScore', type: 'number', description: '0..1 header consistency (1 = real browser)' },
  { name: 'tls.ja3', type: 'string?', description: 'TLS JA3 fingerprint (from a trusted proxy header)' },
  { name: 'tls.ja4', type: 'string?', description: 'TLS JA4 fingerprint' },
  { name: 'headers', type: 'Record<string, string>', description: 'request headers, lowercase names (50 max, 1 KB each; cookie / authorization are "[redacted]")' },
  { name: 'rate.ip', type: 'number', description: 'requests from this IP in the last 60 s' },
  { name: 'rate.asn', type: 'number', description: 'requests from this network in the last 60 s' },
  { name: 'rate.path', type: 'number', description: 'requests to this path in the last 60 s' },
  { name: 'clearance', type: 'boolean', description: 'holds a valid shield clearance cookie' },
]
export const CODE_ACTIONS = ['allow', 'log', 'block', 'challenge', 'rateLimit']

// the action a rule's code may return (validated on the host)
const actionOut = z.discriminatedUnion('type', [
  z.object({ type: z.literal('allow') }).strict(),
  z.object({ type: z.literal('log') }).strict(),
  z.object({ type: z.literal('block'), status: z.union([z.literal(403), z.literal(404), z.literal(429), z.literal(451)]).optional(), message: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal('challenge'), level: z.enum(['auto', 'pow', 'checkbox', 'captcha']).default('auto') }).strict(),
  z.object({ type: z.literal('rateLimit'), limit: z.number().int().min(1).max(1_000_000), window: z.enum(['10s', '1m', '1h']), key: z.enum(['ip', 'asn', 'path']).default('ip') }).strict(),
])

export type CodeErrorKind = 'compile' | 'runtime' | 'timeout' | 'memory' | 'invalid'
export interface CodeError { kind: CodeErrorKind; message: string; line?: number; column?: number }
export interface CodeResult { action?: Action; error?: CodeError; skipped?: 'disabled' | 'paused' | 'restarted'; ms: number; logs: string[] }

// ---- the request a rule sees -------------------------------------------------------------------------------------------
const SECRET_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie'])
export function codeInput(s: Signals, headers: Record<string, string | string[] | undefined> = {}, url?: string): Record<string, unknown> {
  const h: Record<string, string> = {}
  let n = 0
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || n++ >= 50) continue
    const name = k.toLowerCase()
    h[name] = SECRET_HEADERS.has(name) ? '[redacted]' : (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 1024)
  }
  const q = url?.indexOf('?') ?? -1
  return {
    ip: s.ip, ipNet: s.ipNet, country: s.country, continent: s.continent, asn: s.asn, asnOrg: s.asnOrg, asnKind: s.asnKind, tor: !!s.tor, local: !!s.local,
    path: s.path, ...(q >= 0 && { query: url!.slice(q + 1, q + 2049) }), method: s.method, host: s.host, ua: s.ua, uaFamily: s.uaFamily,
    bot: { name: s.bot.name, category: s.bot.category, verified: !!s.bot.verified, spoofed: !!s.bot.spoofed },
    score: s.score, headerScore: s.headerScore, ...(s.tls && { tls: { ja3: s.tls.ja3, ja4: s.tls.ja4 } }), headers: h,
    rate: { ...s.rate }, clearance: !!s.clearance?.valid,
  }
}
export const SAMPLE_REQUEST = codeInput({ ip: '203.0.113.7', ipNet: '203.0.113.0/24', country: 'IS', continent: 'EU', asn: 64500, asnOrg: 'Example Net', asnKind: 'residential', tor: false, local: false,
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', uaFamily: 'chrome', bot: { category: 'browser', verified: false, spoofed: false },
  headerScore: 1, path: '/', method: 'GET', host: 'localhost', rate: { ip: 1, asn: 1, path: 1 }, score: 70 }, { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' })

// ---- the sandbox -------------------------------------------------------------------------------------------------------
// One worker thread holds the QuickJS (wasm) module: one runtime + context per rule source (sha256), the module evaluated
// once. In the worker: memory limit 8 MB per runtime, a stack limit, an interrupt deadline per call, and a capped wasm heap.
// QuickJS only polls its interrupt every ~10 000 ticks and a native call (join, fill…) is one tick, so a native-heavy loop
// can outrun the deadline: the host watchdog terminates the worker (timeoutMs + 50 ms) and a fresh one is spawned.
const MEMORY = 8 << 20, STACK = 512 << 10, HEAP_MB = 128, GRACE_MS = 50
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { newQuickJSWASMModuleFromVariant, newVariant } = require(workerData.core)
const base = require(workerData.variant)
const PRELUDE = ${JSON.stringify(`(() => {
  const freeze = (o) => { if (o && typeof o === 'object') { for (const k of Object.keys(o)) freeze(o[k]); Object.freeze(o) } return o }
  globalThis.__runner = (fn) => function (s) {
    const r = fn(freeze(JSON.parse(s)))
    if (r === undefined || r === null) return undefined
    if (typeof r.then === 'function') return '"a Promise (rules run synchronously, no async)"'
    const out = JSON.stringify(r)
    return out === undefined ? 'null' : out
  }
})()`)}
let modP, sources = new Map(), boxes = new Map()
const HEAP_MAX = workerData.heapMb * 1048576
const load = () => (modP ??= newQuickJSWASMModuleFromVariant(newVariant(base.default ?? base, { wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: HEAP_MAX / 65536 }) })))
const heapOf = (mod) => { try { return mod.module.HEAPU8.buffer.byteLength } catch { return 0 } }
const lineCol = (e) => { const m = /rule\.js:(\d+)(?::(\d+))?/.exec(String(e.stack || '')); return m ? { line: +m[1], column: +(m[2] || 1) } : typeof e.lineNumber === 'number' ? { line: e.lineNumber, column: 1 } : {} }
function errorOf(ctx, h, kind, why) {
  let e
  try { const d = ctx.dump(h); e = d && typeof d === 'object' ? d : { message: String(d) } } catch { e = { message: 'unreadable error' } } finally { h.dispose() }
  const msg = String(e.message ?? e)
  const k = why || (msg === 'interrupted' ? 'timeout' : /out of memory|stack overflow/i.test(msg) ? 'memory' : kind)
  return { kind: k, message: (k === 'timeout' ? 'took longer than the time limit' : (e.name && e.name !== 'Error' ? e.name + ': ' : '') + msg).slice(0, 500), ...lineCol(e) }
}
function disposeBox(c) { if (c && c.box) { c.box.run.dispose(); c.box.ctx.dispose(); c.box.rt.dispose() } }
function dropModule() { try { for (const c of boxes.values()) disposeBox(c) } catch {} boxes.clear(); modP = undefined }
function build(mod, source, timeoutMs) {
  const rt = mod.newRuntime()
  rt.setMemoryLimit(workerData.memory)
  rt.setMaxStackSize(workerData.stack)
  const ctx = rt.newContext()
  const box = { rt, ctx, end: performance.now() + Math.max(timeoutMs, 50), why: undefined, logs: null }
  rt.setInterruptHandler(() => performance.now() > box.end ? !!(box.why = 'timeout') : false)
  const fail = (error) => { ctx.dispose(); rt.dispose(); return { error } }
  const con = ctx.newObject()
  for (const level of ['log', 'warn', 'error']) {
    const f = ctx.newFunction(level, (...args) => {
      if (!box.logs || box.logs.length >= 20) return
      const line = args.map((a) => { const v = ctx.dump(a); return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v) }).join(' ')
      box.logs.push(((level === 'log' ? '' : '[' + level + '] ') + line).slice(0, 500))
    })
    ctx.setProp(con, level, f); f.dispose()
  }
  ctx.setProp(ctx.global, 'console', con); con.dispose()
  ctx.unwrapResult(ctx.evalCode(PRELUDE, 'prelude.js', { type: 'global' })).dispose()
  const r = ctx.evalCode(source, 'rule.js', { type: 'module' })
  if (r.error) return fail(errorOf(ctx, r.error, 'compile', box.why))
  let ns = r.value
  const st = ctx.getPromiseState(ns)
  if (st.type !== 'fulfilled') { ns.dispose(); return st.type === 'rejected' ? fail(errorOf(ctx, st.error, 'compile')) : fail({ kind: 'compile', message: 'top-level await is not supported', line: 1, column: 1 }) }
  if (!st.notAPromise) { ns.dispose(); ns = st.value }
  const fn = ctx.getProp(ns, 'default'); ns.dispose()
  if (ctx.typeof(fn) !== 'function') { fn.dispose(); return fail({ kind: 'compile', message: 'the module must export default function rule(req) { … }', line: 1, column: 1 }) }
  const mk = ctx.getProp(ctx.global, '__runner')
  const run = ctx.callFunction(mk, ctx.undefined, fn)
  mk.dispose(); fn.dispose()
  if (run.error) return fail(errorOf(ctx, run.error, 'compile'))
  box.run = run.value
  return { box }
}
async function compiled(hash, timeoutMs) {
  let c = boxes.get(hash)
  if (c) return c
  const source = sources.get(hash)
  if (source === undefined) return { error: { kind: 'compile', message: 'sandbox lost the source' } }
  c = build(await load(), source, timeoutMs)
  boxes.set(hash, c)
  return c
}
function call(hash, box, input, timeoutMs, logs) {
  const { ctx } = box
  box.why = undefined; box.logs = logs; box.end = performance.now() + timeoutMs
  const s = ctx.newString(input)
  const r = ctx.callFunction(box.run, ctx.undefined, s)
  s.dispose(); box.logs = null
  if (r.error) {
    const error = errorOf(ctx, r.error, 'runtime', box.why)
    if (error.kind === 'memory') { boxes.delete(hash); disposeBox({ box }) }
    return { error }
  }
  const out = ctx.dump(r.value); r.value.dispose()
  return out === undefined ? {} : { out }
}
parentPort.on('message', async (m) => {
  if (m.op === 'prune') { for (const h of [...sources.keys()]) if (!m.keep.includes(h)) { sources.delete(h); try { disposeBox(boxes.get(h)) } catch { dropModule() } boxes.delete(h) } return }
  if (m.source !== undefined) sources.set(m.hash, m.source)
  const t0 = performance.now(), logs = m.logs ? [] : null
  let reply
  try {
    const c = await compiled(m.hash, m.timeoutMs)
    if (c.error) reply = { error: c.error }
    else if (m.op === 'check') reply = {}
    else { const t1 = performance.now(); reply = { ...call(m.hash, c.box, m.input, m.timeoutMs, logs), ms: performance.now() - t1 } }
    const mod = await load()
    if (heapOf(mod) > HEAP_MAX * 0.75) dropModule()   // a ballooned wasm heap never shrinks: start over
  } catch (e) {
    dropModule()   // a wasm abort poisons the module
    reply = { error: { kind: 'runtime', message: 'sandbox crashed: ' + String(e).slice(0, 300) } }
  }
  parentPort.postMessage({ id: m.id, ms: performance.now() - t0, ...reply, logs: logs || [] })
})
`
interface Reply { error?: CodeError; out?: unknown; ms?: number; logs?: string[]; restarted?: true }
interface Pending { id: number; budget: number; resolve: (r: Reply) => void }
let worker: Worker | undefined, fresh = true, seq = 0, timer: NodeJS.Timeout | undefined
const queue: Pending[] = [], known = new Set<string>()
function spawn(): Worker {
  const req = createRequire(import.meta.url)
  const w = new Worker(WORKER, { eval: true, workerData: { core: req.resolve('quickjs-emscripten-core'), variant: req.resolve('@jitl/quickjs-wasmfile-release-sync'), heapMb: HEAP_MB, memory: MEMORY, stack: STACK }, resourceLimits: { maxOldGenerationSizeMb: 64 } })
  w.unref()
  w.on('message', (r: Reply & { id: number }) => {
    const p = queue[0]
    if (!p || p.id !== r.id) return
    queue.shift()
    fresh = false
    p.resolve(r)
    arm()
  })
  w.on('error', () => kill(w, 'runtime'))
  w.on('exit', () => kill(w, 'runtime'))
  return w
}
function arm(): void {
  clearTimeout(timer)
  const head = queue[0]
  if (!head || !worker) return
  const w = worker
  timer = setTimeout(() => kill(w, 'timeout'), head.budget + GRACE_MS + (fresh ? 2000 : 0))   // the first call loads the wasm
  timer.unref()
}
// the head call hung (or the worker died): it fails, the queued ones are skipped uncounted, a fresh worker starts on demand
function kill(w: Worker, kind: 'timeout' | 'runtime'): void {
  if (worker !== w) return
  worker = undefined
  clearTimeout(timer)
  known.clear()
  fresh = true
  void w.terminate()
  const [head, ...rest] = queue.splice(0)
  head?.resolve({ error: { kind, message: kind === 'timeout' ? 'took longer than the time limit (sandbox restarted)' : 'the sandbox crashed (restarted)' } })
  for (const p of rest) p.resolve({ restarted: true })
}
function send(op: 'run' | 'check', source: string, timeoutMs: number, extra: { input?: string; logs?: boolean } = {}): Promise<Reply> {
  worker ??= spawn()
  const hash = sourceHash(source), first = !known.has(hash)
  known.add(hash)
  const id = ++seq
  return new Promise((resolve) => {
    queue.push({ id, budget: timeoutMs + (first ? 100 : 0), resolve })
    if (queue.length === 1) arm()
    worker!.postMessage({ id, op, hash, ...(first && { source }), timeoutMs, ...extra })
  })
}
export const sourceHash = (source: string) => createHash('sha256').update(source).digest('hex')

const timeoutOf = (settings: Settings | undefined) => Math.min(50, Math.max(1, Number(settings?.shield?.code?.timeoutMs) || 5))
const round = (n: number) => Math.round(n * 1000) / 1000
// one call, no stats (shield.code.run, shield.rules.preview, the rule path below); never throws
export async function runCode(source: string, input: unknown, o: { settings?: Settings; logs?: boolean } = {}): Promise<CodeResult> {
  const t0 = performance.now()
  const r = await send('run', source, timeoutOf(o.settings), { input: JSON.stringify(input), logs: !!o.logs })
  const ms = round(r.ms ?? performance.now() - t0), logs = r.logs ?? []
  if (r.restarted) return { skipped: 'restarted', ms, logs }
  if (r.error) return { error: r.error, ms, logs }
  if (r.out === undefined) return { ms, logs }
  const bad = (message: string): CodeResult => ({ error: { kind: 'invalid', message }, ms, logs })
  if (typeof r.out !== 'string') return bad('the rule must return an action object or nothing')
  let v: unknown
  try { v = JSON.parse(r.out) } catch { return bad('the return value is not JSON') }
  if (typeof v === 'string') return bad(`returned ${v}`)
  const p = actionOut.safeParse(v)
  if (!p.success) return bad(`invalid action ${JSON.stringify(v).slice(0, 120)}: ${p.error.issues.map((i) => `${i.path.join('.') || 'type'} ${i.message}`).join('; ')}`.slice(0, 500))
  return { action: p.data as Action, ms, logs }
}
// syntax + "export default a function" (the module's top level runs once, bounded; the function body does not)
export async function checkCode(source: string): Promise<{ ok: boolean; errors: { line: number; column: number; message: string }[] }> {
  if (typeof source !== 'string' || source.length > CODE_MAX) return { ok: false, errors: [{ line: 1, column: 1, message: `the code is over ${CODE_MAX} characters` }] }
  const r = await send('check', source, 50)
  return r.error ? { ok: false, errors: [{ line: r.error.line ?? 1, column: r.error.column ?? 1, message: r.error.message }] } : { ok: true, errors: [] }
}
// the rules changed: drop sandboxes no rule uses any more
export function pruneCode(sources: string[]): void {
  if (!worker) return
  const keep = sources.map(sourceHash)
  for (const h of known) if (!keep.includes(h)) known.delete(h)
  worker.postMessage({ op: 'prune', keep })
}

// ---- per-rule error stats (in memory, this process) --------------------------------------------------------------------
interface Stat { minutes: Map<number, number>; lastError?: { at: string; message: string; kind: CodeErrorKind }; streak: number; streakStart: number; pausedUntil: number; warnedAt: number }
export const codeStats = new Map<string, Stat>()
const log = getLogger('tvine.shield')
const statOf = (id: string) => { let s = codeStats.get(id); if (!s) codeStats.set(id, (s = { minutes: new Map(), streak: 0, streakStart: 0, pausedUntil: 0, warnedAt: 0 })); return s }
export function codeStatus(id: string): { errors1h: number; lastError?: { at: string; message: string; kind: string }; paused?: boolean } {
  const s = codeStats.get(id), now = Date.now()
  if (!s) return { errors1h: 0 }
  const m0 = Math.floor(now / 60_000) - 59
  let errors1h = 0
  for (const [m, n] of s.minutes) if (m >= m0) errors1h += n; else s.minutes.delete(m)
  return { errors1h, ...(s.lastError && { lastError: s.lastError }), ...(s.pausedUntil > now && { paused: true }) }
}
function countError(id: string, e: CodeError): void {
  const s = statOf(id), now = Date.now(), m = Math.floor(now / 60_000)
  s.minutes.set(m, (s.minutes.get(m) ?? 0) + 1)
  if (s.minutes.size > 61) for (const k of s.minutes.keys()) if (k < m - 59) s.minutes.delete(k)
  s.lastError = { at: new Date(now).toISOString(), message: e.message, kind: e.kind }
  if (!s.streak || now - s.streakStart > 60_000) { s.streak = 0; s.streakStart = now }
  if (++s.streak >= 100) { s.pausedUntil = now + 60_000; s.streak = 0; log.warn('shield code rule paused for 60 s (100 errors in a row)', { ruleId: id }) }
  if (now - s.warnedAt >= 60_000) { s.warnedAt = now; log.warn('shield code rule failed (skipped)', { ruleId: id, kind: e.kind, error: e.message }) }
}
// the request path: never throws; count: false for dry runs (shield.test / preview)
export async function runCodeRule(id: string, source: string, input: () => unknown, settings: Settings, count = true): Promise<CodeResult> {
  if (settings.shield.code?.enabled === false) return { skipped: 'disabled', ms: 0, logs: [] }
  const s = codeStats.get(id)
  if (s && s.pausedUntil > Date.now()) return { skipped: 'paused', ms: 0, logs: [] }
  const r = await runCode(source, input(), { settings })
  if (!count) return r
  if (r.error) countError(id, r.error)
  else if (s) s.streak = 0
  return r
}
