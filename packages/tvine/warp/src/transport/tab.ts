// transport/tab — production tab control (docs/design/frontend/v2/core/security.md §Remote agents,
// transports.md §Tab socket). A remote agent (MCP/HTTP) asks for the human's open tab; the human clicks
// Allow once in the tab's trusted chrome (or types the pairing code); the agent's ui/read/expand calls are
// then forwarded to that tab as `cmd` frames over the SSE channel, run there by the in-tab executor, and
// answered by a result POST. One tab, one agent; the human's Stop revokes at once.
//
// Trust: the tab is authenticated ONLY by the httpOnly session cookie (no JS-readable sid). Every tab POST is
// same-origin (Origin must be present and match), carries `x-tvine-tab` (a cross-site page can't send it
// without a CORS preflight we never answer), and its cookie session must own the tabId. tabId, requestId and
// cmdId are 128-bit random. The agent's declared name is never verified and always shown as such.
import { isProduction } from '../env.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { sidHash } from '../core/audit.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerCtx } from '../core/dispatch.js'
import { clientIp, forwardedHostOf, sameOrigin as originMatches } from '../core/request.js'
import { readBody, tooDeep } from './body.js'
import { cookieHeader } from '../core/session.js'
import type { ErrCode, Session, Settings, Sid } from '../core/types.js'
import { cookieValue } from '../security/cookie.js'
import { ipKey, type Limiter } from '../security/ratelimit.js'
import { limiterFor } from '../backends/index.js'
import { metrics } from '../core/metrics.js'

// a hub limiter from settings.limits.backend, its keys namespaced so two hub limiters never share a bucket
export type TabLimiter = { check(k: { sid: string }): ReturnType<Limiter['check']> }
export function tabLimiter(server: ServerCtx, ns: string, rate: { limit: number; windowMs: number }): TabLimiter {
  const l = limiterFor(server.settings, rate)
  return { check: (k) => l.check({ sid: `tab-${ns}|${k.sid}` }) }
}

export const TAB_LIMITS = {
  requestTtlMs: 300_000,      // approveUrl / requestId lifetime
  codeTtlMs: 120_000,         // pairing code lifetime (fallback)
  armMs: 500,                 // Allow counts only this long after the prompt was shown (anti-clickjack; the chrome checks it too)
  graceMs: 30_000,            // SSE gone this long → the tab is closed
  idleMs: 600_000,            // control released after this long without a forwarded call
  cmdMs: 20_000,              // a forwarded command's answer (the tab's own limit is 15 s)
  tailMs: 2_000,              // the session stays agent this long after a forwarded command answered (late autosaves, effects)
  driftMs: 30_000,            // ...and this long after one that did not answer (it may still run in the tab: exec drainMs)
  codeFails: 10,              // wrong codes from one IP before it is locked
  lockMs: 15 * 60_000,
  resultBytes: 1_048_576,     // a result POST (a full page read) may exceed limits.bodyBytes
}

type MaybePromise<T> = T | Promise<T>
export type Frame = (event: string, data: unknown) => void
export type TabOp = 'ui' | 'read' | 'expand' | 'do'
export type TabAnswer = { ok: true; data: unknown } | { ok: false; code: ErrCode; reason?: string; message: string }
export type AgentState =
  | { kind: 'control'; tabId: string }
  | { kind: 'awaiting'; approveUrl: string; code: string }
  | { kind: 'note'; reason: string }          // why this agent has no tab now (stopped, human_denied, busy, timeout, ...)

interface Pending { resolve(a: TabAnswer): void }
interface Tab { id: string; sid: Sid; doc: string; send?: Frame; gone?: ReturnType<typeof setTimeout>; agent?: Sid; shown?: { requestId: string; at: number }; pending: Map<string, Pending> }
interface Ask { id: string; agentSid: Sid; name: string; exp: number; code: string; codeExp: number; approveUrl: string; tabId?: string }
interface Held { tabId: string; name: string; since: number; used: number }

export const token = () => randomBytes(16).toString('base64url')
export const hashId = (s: string) => createHash('sha256').update(`tab:${s}`).digest('hex').slice(0, 16)   // 128 bit
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const newCode = () => [...randomBytes(8)].map((b) => CROCKFORD[b & 31]).join('')
// what the human types: case-insensitive, dashes/spaces ignored, Crockford look-alikes folded
export const normCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').slice(0, 16)
export const fmtCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`
// declared name: ≤ 40 chars, control/bidi chars stripped; never verified
export const cleanName = (s: unknown) => (typeof s === 'string' ? s : '').replace(/[\0-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').trim().slice(0, 40) || 'Agent'
export const fail = (code: ErrCode, reason: string | undefined, message: string): TabAnswer => ({ ok: false, code, ...(reason && { reason }), message })

export class TabHub {
  private tabs = new Map<string, Tab>()
  private asks = new Map<string, Ask>()                  // requestId → open request
  private held = new Map<Sid, Held>()                    // agent sid → the tab it controls
  private notes = new Map<Sid, { reason: string; at: number }>()
  private moved = new Map<Sid, Sid>()                    // rotated sid → the sid its in-flight count was copied to
  private busy = new Map<Sid, number>()                  // session sid → forwarded commands running in its tabs
  private tail = new Map<Sid, number>()                  // session sid → stays agent until (after its last command)
  private fails = new Map<string, { n: number; until: number }>()   // ip → wrong pairing codes
  // settings.limits.backend: shared across servers on 'redis' (each limiter in its own key space)
  protected askRate: TabLimiter     // request_control per agent sid / per ip
  protected codeRate: TabLimiter    // pairing tries per tab / per ip
  private cmdRate: TabLimiter       // forwarded commands per tab: 10 burst, 3/s
  private readRate: TabLimiter      // read_page/expand per tab: their own, generous 30/s
  readonly helloRate: TabLimiter  // hello (mints sessions) per ip
  readonly tabRate: TabLimiter    // request/approve/result per tab (release is exempt)
  private timer: ReturnType<typeof setInterval>
  private unwatch: () => void
  private unrotate: () => void

  constructor(protected server: ServerCtx) {
    this.askRate = tabLimiter(server, 'ask', { limit: 5, windowMs: 60_000 })
    this.codeRate = tabLimiter(server, 'code', { limit: 5, windowMs: 60_000 })
    this.cmdRate = tabLimiter(server, 'cmd', { limit: 10, windowMs: 3_334 })
    this.readRate = tabLimiter(server, 'read', { limit: 30, windowMs: 1_000 })
    this.helloRate = tabLimiter(server, 'hello', { limit: 30, windowMs: 10_000 })
    this.tabRate = tabLimiter(server, 'tab', { limit: 30, windowMs: 10_000 })
    this.unwatch = server.sessions.watch((sid, kind) => { if (kind === 'expired') this.expired(sid) })
    // login/logout rotated a session: its agent marking (running forwarded commands, tail) follows it, so the
    // new sid is never treated as human while the agent's command is still settling. Tabs on the old sid are
    // dropped (expired), never re-keyed: whoever held the old sid's stream must not reach the new session.
    this.unrotate = server.sessions.onRotate((from, to) => {
      const b = this.busy.get(from), t = this.tail.get(from)
      if (b) { this.busy.set(to, (this.busy.get(to) ?? 0) + b); this.moved.set(from, to) }   // unbusy(from) settles `to` too
      if (t !== undefined) this.tail.set(to, Math.max(this.tail.get(to) ?? 0, t))
      if (b) this.tail.set(to, Math.max(this.tail.get(to) ?? 0, Date.now() + TAB_LIMITS.driftMs))   // its in-flight count stays on the old key
      if (b || t !== undefined) void this.share(to)
    })
    this.timer = setInterval(() => this.sweep(), 15_000)
    this.timer.unref?.()
  }

  close(): void { clearInterval(this.timer); this.unwatch(); this.unrotate(); for (const t of [...this.tabs.values()]) this.drop(t) }

  get size(): number { return this.tabs.size }   // metrics: connected tabs
  // tvine.admin's Agents page: the tabs an agent controls now. ids are hashes (never a tab token or a sid).
  controlled(): MaybePromise<{ id: string; session: string; since: number; agent: string; used: number }[]> {
    const out = []
    for (const [agentSid, h] of this.held) {
      const t = this.tabs.get(h.tabId)
      if (t) out.push({ id: hashId(t.id), session: sidHash(agentSid)!, since: h.since, agent: h.name, used: h.used })
    }
    return out
  }
  // the admin's Stop: the same release as the human's Stop pill
  revoke(id: string): MaybePromise<boolean> {
    for (const t of this.tabs.values()) if (t.agent && hashId(t.id) === id) { this.release(t, 'human', 'not_connected'); return true }
    return false
  }
  get on(): boolean { return this.server.settings.agent?.inTab !== 'off' }

  // ---- tab lifecycle (channel.ts) -----------------------------------------------------------
  // A cookie stream asking to be a tab. `want` (a tabId this session already had) is taken over: a reload
  // or reconnect keeps its tab, and its control, only within the same cookie session.
  // A live stream is taken over only by the same document (per-page nonce `doc`): another tab of the
  // session that learned the tabId gets a tab of its own. ponytail: a reload whose old stream is still
  // open gets a new tab (its control ends with the old one's grace); add a handoff if that bites.
  open(sid: Sid, send: Frame, want?: string, doc = ''): MaybePromise<string> {
    const old = want ? this.tabs.get(want) : undefined
    if (old && old.sid === sid && (!old.send || (doc !== '' && old.doc === doc))) {
      clearTimeout(old.gone); old.gone = undefined
      old.send = send
      old.doc = doc
      const h = old.agent && this.held.get(old.agent)
      send('hello', { tabId: old.id })
      if (h) send('control', { agent: h.name, verified: false, since: h.since })
      return old.id
    }
    const tab: Tab = { id: token(), sid, doc, send, pending: new Map() }
    this.tabs.set(tab.id, tab)
    send('hello', { tabId: tab.id })
    return tab.id
  }

  // The stream ended. Only the CURRENT stream of the tab counts (a takeover already replaced it).
  gone(tabId: string, send: Frame): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.send !== send) return
    tab.send = undefined
    for (const p of [...tab.pending.values()]) p.resolve(fail('expired_sid', 'tab_closed', 'the tab disconnected; the step may have run: read_page before retrying'))
    tab.gone = setTimeout(() => this.drop(tab), TAB_LIMITS.graceMs)
    tab.gone.unref?.()
  }

  private drop(tab: Tab): void {
    clearTimeout(tab.gone)
    this.release(tab, 'tab_closed', 'not_connected')
    this.tabs.delete(tab.id)
    for (const a of this.asks.values()) if (a.tabId === tab.id) a.tabId = undefined
  }

  // ---- agent side (mcp.ts, /tvine/agent/*) -------------------------------------------------
  // `sid` is called only after the ip check passed: a refused request creates no session.
  async request(sid: () => Promise<Sid>, o: { name?: unknown; ip: string; base?: string }): Promise<TabAnswer & { sid?: Sid }> {
    if (!this.on) return fail('domain', 'forbidden', 'this site does not allow agents to control browser tabs')
    const limited = async (k: string) => { const r = await this.askRate.check({ sid: k }); return r.ok ? undefined : { ok: false as const, code: 'rate_limited' as const, message: `rate limited: retry after ${r.retryAfterMs}ms` } }
    const byIp = await limited(`ip:${ipKey(o.ip)}`)
    if (byIp) return byIp
    const agentSid = await sid()
    const bySid = await limited(`sid:${agentSid}`)
    if (bySid) return { ...bySid, sid: agentSid }
    for (const a of [...this.asks.values()]) if (a.agentSid === agentSid) this.asks.delete(a.id)   // newer replaces older
    this.notes.delete(agentSid)
    const now = Date.now(), id = token()
    const approveUrl = `${o.base ?? ''}/?tvine-approve=${id}`
    const ask: Ask = { id, agentSid, name: cleanName(o.name), exp: now + TAB_LIMITS.requestTtlMs, code: newCode(), codeExp: now + TAB_LIMITS.codeTtlMs, approveUrl }
    this.asks.set(id, ask)
    return { ok: true, sid: agentSid, data: { requestId: id, approveUrl, code: fmtCode(ask.code), expiresIn: TAB_LIMITS.requestTtlMs / 1000, verified: false, name: ask.name } }
  }

  // Where an agent's ui/read_page/expand/do goes: its tab, a pending approval, a note, or (undefined) headless.
  state(agentSid: Sid | undefined): MaybePromise<AgentState | undefined> {
    if (!agentSid) return undefined
    const h = this.held.get(agentSid)
    if (h) {
      const tab = this.tabs.get(h.tabId)
      if (tab && Date.now() - h.used <= TAB_LIMITS.idleMs) return { kind: 'control', tabId: h.tabId }
      if (tab) this.release(tab, 'idle', 'not_connected')
    }
    const now = Date.now()
    for (const a of this.asks.values()) if (a.agentSid === agentSid && a.exp > now) return { kind: 'awaiting', approveUrl: a.approveUrl, code: fmtCode(a.code) }
    const n = this.notes.get(agentSid)
    return n ? { kind: 'note', reason: n.reason } : undefined
  }

  async forward(agentSid: Sid, op: TabOp, payload: unknown): Promise<TabAnswer> {
    const h = this.held.get(agentSid)
    const tab = h && this.tabs.get(h.tabId)
    if (!h || !tab) return fail('domain', 'not_connected', 'no tab under your control: call request_control')
    if (!tab.send) return fail('expired_sid', 'tab_closed', 'the tab is disconnected; retry shortly or call request_control again')
    // reads (read_page/expand) have their own generous bucket; ui/do spend the command bucket
    const rl = await (op === 'read' || op === 'expand' ? this.readRate : this.cmdRate).check({ sid: `tab:${tab.id}` })
    if (!rl.ok) return { ok: false, code: 'rate_limited', message: `rate limited: retry after ${rl.retryAfterMs}ms` }
    h.used = Date.now()
    const cmdId = token(), sid = tab.sid
    const bad = await this.begin(sid)
    if (bad) return bad
    if (!tab.send || tab.agent !== agentSid) { this.settle(sid); return fail('domain', 'stopped', 'control of the tab ended') }
    return new Promise((resolve) => {
      const done = (a: TabAnswer) => {
        if (!tab.pending.delete(cmdId)) return
        clearTimeout(timer)
        this.settle(sid, a)
        resolve(a)
      }
      const timer = setTimeout(() => done(fail('domain', 'timeout', 'the tab did not answer in time; the step may have run: read_page before retrying')), TAB_LIMITS.cmdMs)
      timer.unref?.()
      tab.pending.set(cmdId, { resolve: done })
      tab.send!('cmd', { cmdId, op, payload })
    })
  }

  // every server must see the session as agent BEFORE the tab runs the command (its requests may land anywhere):
  // a failed marking forwards nothing (the answer is returned)
  protected async begin(sid: Sid): Promise<TabAnswer | undefined> {
    this.busy.set(sid, (this.busy.get(sid) ?? 0) + 1)
    try { await this.share(sid); return undefined } catch (e) {
      this.unbusy(sid)
      this.server.log('error', 'tab: agent marking failed; command not forwarded', { error: String(e) })
      return fail('internal', undefined, 'internal error')
    }
  }
  // a begun command ended: `a` its answer (none = it was never sent)
  protected settle(sid: Sid, a?: TabAnswer): void {
    this.unbusy(sid)
    // answered (or Stop, which aborts it in the tab) → short tail; no answer → it may still be running there
    if (a) this.tail.set(sid, Math.max(this.tail.get(sid) ?? 0, Date.now() + (a.ok || a.reason === 'stopped' ? TAB_LIMITS.tailMs : TAB_LIMITS.driftMs)))
    void this.share(sid).catch((e: unknown) => this.server.log('error', 'tab: agent marking failed', { error: String(e) }))
  }

  // dispatch(): while a forwarded command runs in a tab of this session, every request of it is agent.
  // ponytail: per session, not per tab: a human acting in ANOTHER tab of the same session during those
  // seconds is treated as agent too (stricter, never looser).
  // A shared store (limits.backend 'redis', ServerCtx.marks) carries the marking to every server: the tab and its
  // stream live on this one, the session's other requests may reach any.
  forcedAgent(sid: Sid): boolean | Promise<boolean> {
    if (this.localForced(sid)) return true
    return this.server.marks ? this.server.marks.has(sid) : false
  }
  private localForced(sid: Sid): boolean {
    if ((this.busy.get(sid) ?? 0) > 0) return true
    const t = this.tail.get(sid)
    return t !== undefined && t > Date.now()
  }
  private unbusy(sid: Sid): void {
    // a command that started before a login rotation answers on the old sid: its count was copied to the new sid
    // (onRotate), so the new one comes down too, along the rotation chain
    for (let k: Sid | undefined = sid, hops = 0; k !== undefined && hops < 8; hops++) {
      const n = (this.busy.get(k) ?? 1) - 1
      if (n > 0) this.busy.set(k, n); else this.busy.delete(k)
      const next = this.moved.get(k)
      if (n <= 0) this.moved.delete(k)
      k = next
    }
  }
  // this server's marking of `sid`, published: busy → until the command's answer could still come (cmdMs + drift);
  // else the tail. Each server writes its own (marks keeps one entry per process; the session is agent while any is live).
  private share(sid: Sid): Promise<void> {
    const m = this.server.marks
    if (!m) return Promise.resolve()
    const now = Date.now()
    const until = (this.busy.get(sid) ?? 0) > 0 ? now + TAB_LIMITS.cmdMs + TAB_LIMITS.driftMs : this.tail.get(sid) ?? 0
    return m.set(sid, Math.max(0, until - now))
  }

  releaseAgent(agentSid: Sid): MaybePromise<void> {
    for (const a of [...this.asks.values()]) if (a.agentSid === agentSid) this.asks.delete(a.id)
    this.notes.delete(agentSid)
    const h = this.held.get(agentSid), tab = h && this.tabs.get(h.tabId)
    if (tab) this.release(tab, 'agent')
    this.held.delete(agentSid)
  }

  // Ends control of a tab: pending commands answer `stopped`, the tab hears `release`, the agent gets `note` next.
  private release(tab: Tab, why: string, note?: string): void {
    const agent = tab.agent
    if (!agent) return
    tab.agent = undefined
    this.held.delete(agent)
    if (note) this.notes.set(agent, { reason: note, at: Date.now() })
    for (const p of [...tab.pending.values()]) p.resolve(fail('domain', 'stopped', 'control of the tab ended (the human pressed Stop or it was released); the step may have run'))
    tab.send?.('release', { why })
  }

  protected expired(sid: Sid): void {
    for (const t of [...this.tabs.values()]) if (t.sid === sid) this.drop(t)
    if (this.held.has(sid)) this.releaseAgent(sid)
    for (const a of [...this.asks.values()]) if (a.agentSid === sid) this.asks.delete(a.id)
    this.notes.delete(sid)
  }

  protected sweep(): void {
    const now = Date.now()
    for (const a of [...this.asks.values()]) if (a.exp <= now) { this.asks.delete(a.id); this.notes.set(a.agentSid, { reason: 'timeout', at: now }) }
    for (const h of [...this.held.values()]) if (now - h.used > TAB_LIMITS.idleMs) { const t = this.tabs.get(h.tabId); if (t) this.release(t, 'idle', 'not_connected') }
    for (const [k, n] of [...this.notes]) if (now - n.at > 3_600_000) this.notes.delete(k)
    for (const [k, f] of [...this.fails]) if (f.until <= now) this.fails.delete(k)
    for (const [k, t] of [...this.tail]) if (t <= now) this.tail.delete(k)
  }

  // ---- tab side (POST /tvine/tab/*) --------------------------------------------------------
  own(session: Session, tabId: unknown): MaybePromise<boolean> { return !!this.mine(session, tabId) }
  private mine(session: Session, tabId: unknown): Tab | undefined {
    const t = typeof tabId === 'string' ? this.tabs.get(tabId) : undefined
    return t && t.sid === session.sid ? t : undefined
  }

  // The tab opened approveUrl: show the prompt there (first tab wins), or answer busy for an already controlled tab.
  show(session: Session, b: Record<string, unknown>): MaybePromise<[number, unknown]> {
    const tab = this.mine(session, b.tabId)
    if (!tab) return [403, { error: 'not your tab' }]
    const ask = typeof b.requestId === 'string' ? this.asks.get(b.requestId) : undefined
    if (!ask || ask.exp <= Date.now() || (ask.tabId !== undefined && ask.tabId !== tab.id)) return [404, { error: 'this request expired or was already used' }]
    if (tab.agent && tab.agent !== ask.agentSid) return this.deny(ask, tab, 'busy')
    ask.tabId = tab.id
    tab.shown = { requestId: ask.id, at: Date.now() }
    return [200, { requestId: ask.id, name: ask.name, verified: false }]
  }

  async approve(session: Session, b: Record<string, unknown>, ip: string): Promise<[number, unknown]> {
    const tab = this.mine(session, b.tabId)
    if (!tab) return [403, { error: 'not your tab' }]
    const now = Date.now()
    let ask: Ask | undefined
    if (typeof b.code === 'string') {
      const k = ipKey(ip), f = this.fails.get(k)
      if (f && f.n >= TAB_LIMITS.codeFails && f.until > now) return [429, { error: 'too many wrong codes; try again later' }]
      for (const key of [`tab:${tab.id}`, `ip:${k}`]) if (!(await this.codeRate.check({ sid: key })).ok) return [429, { error: 'too many tries; wait a minute' }]
      const typed = normCode(b.code)
      const want = Buffer.from(/^[0-9A-Z]{8}$/.test(typed) ? typed : '########')   // malformed: compared as a never-matching code (equal lengths, no throw)
      for (const a of this.asks.values()) {
        // constant time per candidate; every live code is compared (no early exit on a match)
        const hit = timingSafeEqual(Buffer.from(a.code), want) && a.codeExp > now && a.exp > now
        if (hit) ask = a
      }
      if (!ask) {
        const n = (f?.n ?? 0) + 1
        this.fails.set(k, { n, until: n >= TAB_LIMITS.codeFails ? now + TAB_LIMITS.lockMs : now + 60_000 })
        return [403, { error: 'wrong or expired code' }]
      }
      if (ask.tabId !== undefined && ask.tabId !== tab.id) return [404, { error: 'this request is shown in another tab' }]
    } else {
      ask = typeof b.requestId === 'string' ? this.asks.get(b.requestId) : undefined
      if (!ask || ask.exp <= now || ask.tabId !== tab.id || tab.shown?.requestId !== ask.id) return [404, { error: 'this request expired or was not shown in this tab' }]
      if (b.allow !== false && now - tab.shown.at < TAB_LIMITS.armMs) return [409, { error: 'too early' }]
    }
    if (b.allow === false) return this.deny(ask, tab, b.reason === 'busy' ? 'busy' : 'human_denied')
    if (tab.agent && tab.agent !== ask.agentSid) return this.deny(ask, tab, 'busy')
    // an agent controls one tab at a time: a new approval releases the first
    const prev = this.held.get(ask.agentSid), prevTab = prev && this.tabs.get(prev.tabId)
    if (prevTab && prevTab !== tab) this.release(prevTab, 'replaced')
    this.asks.delete(ask.id)
    this.notes.delete(ask.agentSid)
    tab.shown = undefined
    tab.agent = ask.agentSid
    this.held.set(ask.agentSid, { tabId: tab.id, name: ask.name, since: now, used: now })
    tab.send?.('control', { agent: ask.name, verified: false, since: now })
    return [200, { agent: ask.name, verified: false }]
  }

  private deny(ask: Ask, tab: Tab, reason: 'busy' | 'human_denied'): [number, unknown] {
    this.asks.delete(ask.id)
    this.notes.set(ask.agentSid, { reason, at: Date.now() })
    if (tab.shown?.requestId === ask.id) tab.shown = undefined
    return reason === 'busy' ? [409, { error: 'busy: another agent controls this tab' }] : [200, { denied: true }]
  }

  result(session: Session, b: Record<string, unknown>): MaybePromise<[number, unknown]> {
    const tab = this.mine(session, b.tabId)
    if (!tab) return [403, { error: 'not your tab' }]
    const p = typeof b.cmdId === 'string' ? tab.pending.get(b.cmdId) : undefined
    if (!p) return [409, { error: 'no such pending command' }]   // forged, late or replayed: dropped
    p.resolve({ ok: true, data: b.result ?? null })
    return [200, { ok: true }]
  }

  stop(session: Session, b: Record<string, unknown>): MaybePromise<[number, unknown]> {
    const tab = this.mine(session, b.tabId)
    if (!tab) return [403, { error: 'not your tab' }]
    this.release(tab, 'human', 'not_connected')
    return [200, { ok: true }]
  }
}

// ---- HTTP: POST /tvine/tab/{hello,request,approve,result,release} and /tvine/agent/{control,release} ----
const TAB_PATH = /^\/tvine\/tab\/(hello|request|approve|result|release)$/
const AGENT_PATH = /^\/tvine\/agent\/(control|release)$/

const hdrOf = (req: IncomingMessage, n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v }
const hostOf = (req: IncomingMessage, settings: Settings) => forwardedHostOf(req, settings.trustProxy)   // X-Forwarded-Host per trusted hops
const httpsOf = (req: IncomingMessage, settings: Settings) => (req.socket as { encrypted?: boolean }).encrypted === true ||
  (settings.trustProxy > 0 && String(req.headers['x-forwarded-proto'] ?? '').split(',').map((s) => s.trim()).at(-settings.trustProxy) === 'https')
// The site's public origin as this request reached it (scheme by the same trusted hops as request.ip); '' if no Host.
// The public origin for absolute links the server builds (approveUrl, sitemap): settings.siteUrl, else this request's
// Host once the AllowedHosts middleware validated it (req.tvine.host). Unvalidated: dev keeps the Host; production
// gets '' (a relative link) — a spoofed Host never lands in a link.
export const originOf = (req: IncomingMessage, settings: Settings) => {
  if (settings.siteUrl) return settings.siteUrl.replace(/\/$/, '')
  const validated = (req as { tvine?: { host?: string } }).tvine?.host !== undefined
  if (!validated && isProduction()) return ''
  const h = hostOf(req, settings)
  return h && /^[\w.:[\]-]+$/.test(h) ? `${httpsOf(req, settings) ? 'https' : 'http'}://${h}` : ''
}

export function tabTransport(server: ServerCtx, hub: TabHub): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const { settings, sessions } = server
  const name = settings.session.cookieName
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers })
    res.end(JSON.stringify(body))
  }
  const hdr = hdrOf
  const cookieOf = (req: IncomingMessage) => cookieValue(req.headers.cookie, name)
  // Origin MUST be present and equal the host: a browser always sends it on a POST fetch.
  const sameOrigin = (req: IncomingMessage) => originMatches(req, settings)
  const ipOf = (req: IncomingMessage) => clientIp(hdr(req, 'x-forwarded-for') ?? null, req.socket.remoteAddress ?? '', settings.trustProxy)
  const tooMany = (res: ServerResponse) => { metrics.inc('tvine_ratelimit_hits_total', { scope: 'tab' }); send(res, 429, { error: 'rate limited' }) }

  async function body(req: IncomingMessage, cap: number): Promise<Record<string, unknown> | undefined> {
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return undefined
    const raw = await readBody(req, cap)
    if (!raw) return undefined
    try {
      const v: unknown = JSON.parse(raw.toString('utf8') || '{}')
      return typeof v === 'object' && v !== null && !Array.isArray(v) && !tooDeep(v) ? v as Record<string, unknown> : undefined
    } catch { return undefined }
  }

  // x-tvine-tab: '1' on hello, else the tabId. Checked in this order, all BEFORE the body is read:
  // same origin → cookie session → that session owns the tab → the tab's own rate bucket (release exempt: Stop always lands).
  async function tab(req: IncomingMessage, res: ServerResponse, op: string) {
    const tabId = hdr(req, 'x-tvine-tab')
    if (!sameOrigin(req) || !tabId) return send(res, 403, { error: 'forbidden' })
    const ip = ipOf(req)
    const cookie = cookieOf(req)
    let session = cookie !== undefined ? await sessions.resolve({ cookie }) : undefined
    if (op === 'hello') {
      // a tab needs a cookie session to be controlled: mint one (after the origin + ip checks), never echo it
      if (!(await hub.helloRate.check({ sid: `ip:${ipKey(ip)}` })).ok) return tooMany(res)
      if (session) return send(res, 200, { ok: true })
      if (!(await server.limiter.check({ ip })).ok) return tooMany(res)   // as the <Form> path, before minting
      session = await sessions.create()
      const c = await sessions.cookieFor(session.sid)
      return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(settings, c) })
    }
    if (!session) return send(res, 401, { error: 'no session' })
    if (!(await hub.own(session, tabId))) return send(res, 403, { error: 'not your tab' })
    if (op !== 'release' && !(await hub.tabRate.check({ sid: `tab:${tabId}` })).ok) return tooMany(res)
    const b = await body(req, op === 'result' ? TAB_LIMITS.resultBytes : settings.limits.bodyBytes)
    if (!b) { res.setHeader('connection', 'close'); return send(res, 400, { error: 'body must be a JSON object' }) }
    b.tabId = tabId
    const [status, out] = op === 'request' ? await hub.show(session, b)
      : op === 'approve' ? await hub.approve(session, b, ip)
      : op === 'result' ? await hub.result(session, b)
      : await hub.stop(session, b)
    send(res, status, out)
  }

  // A remote agent over plain HTTP: sid in x-tvine-sid (or body); never a cookie.
  async function agent(req: IncomingMessage, res: ServerResponse, op: string) {
    const b = await body(req, settings.limits.bodyBytes)
    if (!b) return send(res, 400, { error: 'body must be a JSON object' })
    const ip = ipOf(req)
    const sidKey = hdr(req, 'x-tvine-sid') ?? (typeof b.sid === 'string' ? b.sid : undefined)
    if (op === 'release') {
      if (sidKey && await sessions.peek({ sid: sidKey })) await hub.releaseAgent(sidKey)
      return send(res, 200, { ok: true })
    }
    if (!(await server.limiter.check({ ip })).ok) return tooMany(res)
    const r = await hub.request(async () => ((sidKey ? await sessions.resolve({ sid: sidKey }) : undefined) ?? await sessions.create()).sid, { name: b.name, ip, base: originOf(req, settings) })   // siteUrl, else the Host AllowedHosts validated
    if (!r.ok) return send(res, r.code === 'rate_limited' ? 429 : 403, { ...(r.sid && { sid: r.sid }), error: r.message, code: r.code, reason: r.reason })
    send(res, 200, { sid: r.sid, ...(r.data as object), message: CONTROL_HINT })
  }

  return (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]!
    const t = TAB_PATH.exec(path), a = t ? null : AGENT_PATH.exec(path)
    if (!t && !a) {
      // the Allow prompt / Connect box page may not be framed (clickjacking): the browser refuses it in a foreign frame
      if (/[?&]tvine-(approve|connect)=/.test(req.url ?? '')) {
        res.setHeader('content-security-policy', "frame-ancestors 'self'")
        res.setHeader('x-frame-options', 'SAMEORIGIN')
      }
      return next()
    }
    if (!hub.on) return send(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' })
    void (t ? tab(req, res, t[1]!) : agent(req, res, a![1]!)).catch((e: unknown) => {
      server.log('error', 'tab transport failed', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
      if (!res.headersSent) send(res, 500, { error: 'internal error' }); else res.destroy()
    })
  }
}

export const CONTROL_HINT = 'Ask the user to open approveUrl in their browser (or type the code in the site\'s Connect box) and click Allow. Then read_page/ui with this sid act in their tab, as them; they see what you do and can press Stop. Your name is shown to them as unverified.'
