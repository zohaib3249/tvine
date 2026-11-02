// tvine.middleware.Shield (CATALOG entry in middleware/index.ts lazy-loads this; not named middleware.ts: that name is an app's action middleware): the decision pipeline, the modes,
// the response headers, the challenge redirect, the <prefix>/challenge|start|verify endpoints and their static files.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildRequest } from '../../core/request.js'
import type { BuildCtx, HttpMiddleware, MwRequest } from '../../middleware/index.js'
import { AGENT_SURFACE } from '../../middleware/index.js'
import { checkCaptcha, makeCaptcha } from './captcha.js'
import {
  LEVELS, checkClearance, claimNonce, clearanceCookie, cookieName, decide, difficultyFor, dur, fpHash, issueClearance, issueNonce, levelFor, limiter,
  powOk, readNonce, runtimeOf, safeCheck, uaHash,
} from './engine.js'
import { record } from './events.js'
import { scoreSensor } from './sensor-score.js'
import { collectSignals, ipNetOf, type SignalInput } from './signals.js'
import { maybeReload } from './store.js'
import { dumps, loads } from '../../security/signing.js'
import type { ChallengeLevel, Decision, SensorReport, Signals } from './types.js'
import { verifyWebBotAuth } from './webbotauth.js'
import { claims } from './claims.js'

const STATIC_DIR = new URL('./static/', import.meta.url)
const STATIC: Record<string, string> = {
  'challenge.js': 'text/javascript; charset=utf-8', 'sensor.js': 'text/javascript; charset=utf-8', 'pow-worker.js': 'text/javascript; charset=utf-8',
  'challenge.css': 'text/css; charset=utf-8',
}
const files = new Map<string, Buffer>()
const file = (n: string) => files.get(n) ?? (files.set(n, readFileSync(new URL(n, STATIC_DIR))), files.get(n)!)
const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|txt|xml|webmanifest)$/i
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const hdr = (req: IncomingMessage, n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }
const cookieOf = (req: IncomingMessage, name: string) => String(req.headers.cookie ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1)

// the signed return: { p: path+query, l: the level the rule asked for } (so /start can't be talked down a level)
const RETURN_SALT = 'tvine.shield.return'
export const signReturn = (p: string, l: ChallengeLevel) => dumps({ p, l }, { salt: RETURN_SALT })
export function readReturn(r: unknown): { p: string; l: ChallengeLevel } {
  try {
    const v = typeof r === 'string' && r.length < 4096 ? loads<{ p: string; l: ChallengeLevel }>(r, { salt: RETURN_SALT }) : undefined
    if (v && typeof v.p === 'string' && v.p.startsWith('/') && !v.p.startsWith('//') && !v.p.startsWith('/\\')) return { p: v.p, l: LEVELS.includes(v.l) ? v.l : 'pow' }
  } catch { /* forged or old: back to / with the lowest level the score allows */ }
  return { p: '/', l: 'pow' }
}

function send(res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)), ...headers }).end(body)
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers)

async function readJson(req: IncomingMessage, cap = 32_768): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) { n += (c as Buffer).length; if (n > cap) return undefined; chunks.push(c as Buffer) }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined } catch { return undefined }
}

// the challenge page: static/challenge.html with {{nonce}} {{prefix}} {{level}} {{return}}. ONE CSP (review C1): when the
// Security middleware already ran (Shield listed after it) its nonce is used and its CSP is the only one sent;
// otherwise (Shield before Security, or no Security) the page sends its own strict CSP.
export function challengePage(prefix: string, level: ChallengeLevel, ret: string, reqNonce?: string): { html: string; csp?: string } {
  const nonce = reqNonce ?? randomBytes(16).toString('base64')
  const html = file('challenge.html').toString('utf8').replace(/\{\{(nonce|prefix|level|return)\}\}/g, (_, k: string) => esc(k === 'nonce' ? nonce : k === 'prefix' ? prefix : k === 'level' ? level : ret))
  if (reqNonce) return { html }
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  return { html, csp }
}
const nonceOf = (req: IncomingMessage) => { const n = req.headers['x-nonce']; return typeof n === 'string' && n ? n : undefined }
const cspHeader = (p: { csp?: string }): Record<string, string> => (p.csp ? { 'content-security-policy': p.csp } : {})

export function shield(o: Record<string, unknown>, b: BuildCtx): HttpMiddleware {
  const s = b.settings
  const prefix = ((o.prefix as string | undefined) ?? s.shield.prefix).replace(/\/$/, '')
  const tlsHeader = s.trustProxy >= 1 ? s.shield.tlsHeader : undefined   // L2 only through a trusted proxy

  async function signals(req: MwRequest, extra: Partial<SignalInput> = {}): Promise<Signals> {
    const h = (n: string) => hdr(req, n)
    const secure = req.tvine.https
    const host = req.tvine.host ?? String(h('host') ?? '').replace(/:\d+$/, '')
    let verifiedAgent: SignalInput['verifiedAgent']
    if (h('signature-input') && h('signature')) {
      const q = (req.url ?? '/').indexOf('?')
      verifiedAgent = await verifyWebBotAuth({ method: req.method ?? 'GET', path: req.tvine.path, query: q >= 0 ? req.url!.slice(q + 1) : undefined, authority: String(h('host') ?? host), scheme: secure ? 'https' : 'http', header: h },
        { directories: s.shield.webBotAuth.directories, replay: (k, ttl) => claims.claim(s, k, ttl) }).catch(() => undefined)
      if (verifiedAgent) req.tvine.verifiedAgent = verifiedAgent
    }
    let token = false
    const bearer = /^Bearer\s+(.+)$/i.exec(h('authorization') ?? '')?.[1]
    if (bearer) token = await tokenValid(req, bearer)
    const tls = tlsHeader && h(tlsHeader) ? { [/ja3/i.test(tlsHeader) ? 'ja3' : 'ja4']: String(h(tlsHeader)).slice(0, 200) } : undefined
    const ipNet0 = ipNetOf(req.tvine.ip)
    const clearance = checkClearance(cookieOf(req, cookieName(secure)), ipNet0, (h('user-agent') ?? '').slice(0, 512))
    return collectSignals({ ip: req.tvine.ip, method: req.method ?? 'GET', path: req.tvine.path, host, secure, header: h, tls, verifiedAgent, token, clearance, ...extra })
  }

  const under = (p: string, base: string | undefined) => !!base && (p === base || p.startsWith(`${base.replace(/\/$/, '')}/`))
  const adminPath = s.installedApps.includes('tvine.admin') ? s.admin.path : undefined
  const panelPath = (p: string) => under(p, s.shield.panel.path) || /^\/tvine\/api\/(shield|auth)\./.test(p)
  const exempt = (p: string) => panelPath(p) || under(p, adminPath) || under(p, prefix) || /^\/tvine\/api\/admin\./.test(p)

  // a Bearer token's DB lookup: cached 60 s per token hash, at most 30 lookups a minute per ip (review LOW)
  const tokens = new Map<string, { at: number; ok: boolean }>()
  async function tokenValid(req: MwRequest, bearer: string): Promise<boolean> {
    const k = createHash('sha256').update(bearer).digest('base64url'), hit = tokens.get(k)
    if (hit && Date.now() - hit.at < 60_000) return hit.ok
    if (!(await safeCheck(limiter(s, 30, 60_000), `shield-token:${req.tvine.ip}`, s)).ok) return false
    let ok = false
    try { ok = !!(await buildRequest({ req, route: req.tvine.path, isAgent: true }, s)).user.isAuthenticated } catch { ok = false }
    if (tokens.size > 10_000) tokens.clear()
    tokens.set(k, { at: Date.now(), ok })
    return ok
  }

  async function endpoints(req: MwRequest, res: ServerResponse, sub: string): Promise<void> {
    const method = req.method ?? 'GET'
    if ((method === 'GET' || method === 'HEAD') && STATIC[sub]) {
      res.writeHead(200, { 'content-type': STATIC[sub]!, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' }).end(method === 'HEAD' ? undefined : file(sub))
      return
    }
    if ((method === 'GET' || method === 'HEAD') && sub === 'challenge') {
      const u = new URL(req.url ?? '/', 'http://x')
      const r = u.searchParams.get('r') ?? ''
      const { l } = readReturn(r)
      const page = challengePage(prefix, l, r, nonceOf(req))
      send(res, 200, page.html, 'text/html; charset=utf-8', { ...cspHeader(page), 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex' })
      return
    }
    if (method !== 'POST' || (sub !== 'start' && sub !== 'verify')) return json(res, 404, { error: 'not_found' })
    // per ip and per ip range (review H1): /start 30 / 120 a minute, /verify 60 / 240
    const [perIp, perNet] = sub === 'start' ? [30, 120] : [60, 240]
    for (const [n, k] of [[perIp, `ip:${req.tvine.ip}`], [perNet, `net:${ipNetOf(req.tvine.ip)}`]] as const) {
      const got = await safeCheck(limiter(s, n, 60_000), `shield-${sub}-${k}`, s)
      if (!got.ok) return json(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil(got.retryAfterMs / 1000))) })
    }
    const body = await readJson(req)
    if (!body) return json(res, 400, { error: 'bad_request' })
    const ret = readReturn(body.r ?? body.return)
    if (sub === 'start') {
      const sig = await signals(req)
      const asked = typeof body.level === 'string' && (LEVELS as string[]).includes(body.level) ? body.level as ChallengeLevel : levelFor('auto', sig, runtimeOf(s).levels)
      const level = [asked, ret.l].sort((a, z) => LEVELS.indexOf(z) - LEVELS.indexOf(a))[0]!   // never below what the rule asked
      let captcha: Awaited<ReturnType<typeof makeCaptcha>> | undefined
      try { captcha = level === 'captcha' ? await makeCaptcha() : undefined } catch { return json(res, 503, { ok: false, error: 'try_again' }) }   // store down: fail closed
      const d = difficultyFor(sig.score) + (level === 'captcha' ? 2 : 0)   // every level costs the PoW; the captcha level more
      const { nonce } = issueNonce({ d, l: level, ipNet: sig.ipNet, r: ret.p, ...(captcha && { c: captcha.id }) })
      return json(res, 200, { nonce, difficulty: d, level, ray: req.tvine.id, ...(captcha && { captcha: { id: captcha.id, svg: captcha.svg, prompt: captcha.prompt, question: captcha.question } }) })
    }
    // verify
    const sig0 = await signals(req, { count: false })
    const p = readNonce(body.nonce, sig0.ipNet)
    if (!p) return json(res, 403, { ok: false, level: ret.l, error: 'expired_or_invalid' })
    // attempt limits (review H2): 3 per nonce, 10 failed captchas per ip range per 10 min; the claim store being down fails closed
    let tries: number, netFails = 0
    try {
      tries = await claims.count(s, `att:${p.id}`, 600_000)
      if (p.l === 'captcha') netFails = Number(await claims.count(s, `capnet:${sig0.ipNet}`, 600_000)) - 1
    } catch { return json(res, 503, { ok: false, level: p.l, error: 'try_again' }) }
    if (tries > 3 || netFails >= 10) return json(res, 429, { ok: false, level: p.l, error: 'too_many_attempts' })
    const pow = body.pow as { counter?: unknown } | undefined, cb = body.checkbox as { t?: unknown } | undefined, cap = body.captcha as { id?: unknown; answer?: unknown } | undefined
    // the PoW is required at EVERY level (asking for a "higher" level must never skip it); checkbox / captcha add theirs
    let solved = !!pow && powOk(String(body.nonce), pow.counter, p.d)
    if (solved && p.l === 'checkbox') solved = !!cb && typeof cb.t === 'number' && cb.t >= 0
    if (solved && p.l === 'captcha') {
      try { solved = !!cap && !!p.c && (cap.id === undefined || cap.id === p.c) && typeof cap.answer === 'string' && await checkCaptcha(p.c, cap.answer) } catch { return json(res, 503, { ok: false, level: p.l, error: 'try_again' }) }
    }
    if (solved) {
      let first = false
      try { first = await claimNonce(p.id) } catch { return json(res, 503, { ok: false, level: p.l, error: 'try_again' }) }
      if (!first) return json(res, 403, { ok: false, level: p.l, error: 'replay' })
    }
    const sensor = sensorOf(body.sensor)
    const next: ChallengeLevel = LEVELS[Math.min(LEVELS.indexOf(p.l) + 1, LEVELS.length - 1)]!
    const solveMs = cb && typeof cb.t === 'number' ? Math.round(cb.t) : sensor ? Math.round(sensor.behaviour.dwellMs) : undefined
    if (!solved || !sensor) { record(s, sig0, verdict('challenge', 'challenge not solved', sig0, req), req, { failed: true, level: p.l, solveMs }); return json(res, 200, { ok: false, level: p.l === 'captcha' ? 'captcha' : next }) }
    const sensed = scoreSensor(sensor, p.l)
    const combined = Math.max(1, Math.min(99, Math.round((sig0.score + sensed.score) / 2)))
    // pass marks per level: a solved captcha needs only "not automation said so" (webdriver), the lighter levels a score
    const pass = !sensor.webdriver && (p.l === 'captcha' ? sensed.score >= 10 : sensed.score >= (p.l === 'checkbox' ? 20 : 30))
    if (!pass) { record(s, sig0, verdict('challenge', 'sensor check failed', sig0, req), req, { failed: true, level: p.l, solveMs, sensorFlags: sensed.reasons, fpHash: fpHash(sensor) }); return json(res, 200, { ok: false, level: next }) }
    const ttl = dur(runtimeOf(s).clearanceTtl)
    const cookie = issueClearance({ n: sig0.ipNet, u: uaHash(sig0.ua), f: fpHash(sensor), s: combined, l: p.l, e: Date.now() + ttl })
    record(s, sig0, verdict('allow', `challenge passed (${p.l})`, sig0, req), req, { passed: true, level: p.l, solveMs, sensorFlags: sensed.reasons, fpHash: fpHash(sensor) })
    return json(res, 200, { ok: true, return: p.r ?? ret.p }, { 'set-cookie': clearanceCookie(cookie, req.tvine.https, ttl) })
  }

  return {
    name: 'Shield',
    async processRequest(req, res) {
      const rt = runtimeOf(s)
      const path = req.tvine.path
      if (path === prefix || path.startsWith(`${prefix}/`)) return endpoints(req, res, path.slice(prefix.length + 1))
      if (rt.mode === 'off') return
      await maybeReload(s)
      if ((req.method === 'GET' || req.method === 'HEAD') && ASSET.test(path) && !AGENT_SURFACE(path)) return   // static assets: fast path
      const sig = await signals(req)
      const { decision, retryAfterMs } = await decide(sig, { settings: s, ray: req.tvine.id ?? randomBytes(8).toString('hex'), req, headers: req.headers })
      // never lock the owner out (review M2): the panel, the admin and their sign-in / panel APIs are never challenged;
      // a block there still applies, except on the panel for a signed-in superuser
      if (decision.action === 'challenge' && exempt(path)) Object.assign(decision, { action: 'pass', reason: `exempt from challenges (${decision.reason})` })
      if (decision.action === 'block' && panelPath(path) && b.userOf && (await b.userOf(req).catch(() => undefined))?.isSuperuser === true) Object.assign(decision, { action: 'pass', reason: `superuser on the panel (${decision.reason})` })
      req.tvine.shield = { signals: sig, decision }
      record(s, sig, decision, req)
      const enforce = decision.mode === 'enforce'
      const header = decision.action === 'pass' || decision.action === 'allow' ? 'pass' : enforce ? (decision.action === 'rateLimit' ? 'block' : decision.action === 'log' ? 'log' : decision.action) : decision.action === 'log' ? 'log' : `would-${decision.action === 'rateLimit' ? 'block' : decision.action}`
      const ray = decision.ray
      const out = { 'tvine-ray': ray, 'tvine-shield': header, 'server-timing': `shield;dur=${decision.ms}` }
      if (!enforce || !['block', 'challenge', 'rateLimit'].includes(decision.action)) {
        req.tvine.onHeaders(() => { for (const [k, v] of Object.entries(out)) if (!res.hasHeader(k)) res.setHeader(k, v) })
        return
      }
      const agentSurface = AGENT_SURFACE(path)
      const wantsJson = agentSurface || !/text\/html/.test(hdr(req, 'accept') ?? '')
      if (decision.action === 'rateLimit') {
        const retry = String(Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000)))
        return wantsJson ? json(res, 429, { error: 'rate_limited', reason: decision.reason, ray }, { ...out, 'retry-after': retry }) : send(res, 429, `Too Many Requests (ray ${ray})`, 'text/plain; charset=utf-8', { ...out, 'retry-after': retry })
      }
      if (decision.action === 'block') {
        const st = decision.status ?? 403
        return wantsJson ? json(res, st, { error: 'blocked', reason: decision.reason, ray }, out) : send(res, st, `Forbidden (ray ${ray})`, 'text/plain; charset=utf-8', out)
      }
      // challenge: the agent surface (and any non-browser JSON client) never gets HTML
      if (agentSurface) return json(res, 403, { error: 'challenge_required', reason: decision.reason, level: decision.level, ray }, out)
      const r = signReturn(req.url && req.url.startsWith('/') ? req.url : path, decision.level ?? 'pow')
      if (req.method === 'GET' || req.method === 'HEAD') {
        return send(res, 302, '', 'text/plain; charset=utf-8', { ...out, location: `${prefix}/challenge?r=${encodeURIComponent(r)}&l=${decision.level ?? 'pow'}` })
      }
      const page = challengePage(prefix, decision.level ?? 'pow', r, nonceOf(req))
      return send(res, 403, page.html, 'text/html; charset=utf-8', { ...out, ...cspHeader(page) })
    },
  }
}

function verdict(action: Decision['action'], reason: string, s: Signals, req: MwRequest): Decision {
  return { action, reason, mode: 'enforce', score: s.score, ray: req.tvine.id ?? '', ms: 0 }
}

// the client's SensorReport, shape-checked (anything else is "no sensor": a failed challenge)
export function sensorOf(v: unknown): SensorReport | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>, b = r.behaviour as Record<string, unknown> | undefined
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  const str = (x: unknown, n = 512) => x === undefined || (typeof x === 'string' && x.length <= n)
  if (typeof r.webdriver !== 'boolean' || !Array.isArray(r.headless) || r.headless.length > 20 || !r.headless.every((x) => typeof x === 'string' && x.length < 40)) return undefined
  if (!str(r.webgl) || !str(r.canvas, 128) || !str(r.audio, 128) || typeof r.screen !== 'string' || r.screen.length > 64 || typeof r.tz !== 'string' || r.tz.length > 64) return undefined
  if (!Array.isArray(r.langs) || r.langs.length > 20 || !num(r.touch) || !num(r.plugins) || (r.cores !== undefined && !num(r.cores))) return undefined
  if (!b || !['moves', 'entropy', 'scrolls', 'keys', 'dwellMs'].every((k) => num(b[k]))) return undefined
  return r as unknown as SensorReport
}
