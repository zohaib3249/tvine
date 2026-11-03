// transport/tab-shared — the tab hub when the channel layer is shared (settings.channels.backend 'redis'): tab control
// works whichever worker / server each request reaches. Same rules and answers as TabHub (transport/tab.ts); only
// where the state lives changes:
//  - Registry in Redis (settings.channels.redis, keys tab:*): t:<tabId> {sid, doc, hub, stream, agent, sreq, sat}
//    (hub = the process holding its stream, '' while disconnected), h:<agentSid> {tabId, name, since, used} (TTL =
//    the idle limit, refreshed per command), a:<requestId> + aa:<agentSid> + c:<code> (the open request), n:<agentSid>
//    (what the agent hears once it has no tab), cmd:<cmdId> {tab, hub} (a forwarded command waiting for its result),
//    f:<ip> (wrong pairing codes).
//  - One pub/sub channel tab:bus (PUBLISH, no replay ring: results may be 1 MB) every hub listens on:
//    frame {tab, ev, data} → the hub holding the tab's stream writes it; res {hub, cmd, a} → the hub that forwarded
//    the command answers its waiting agent call; end {tab, a} → every hub fails its waiting commands of that tab
//    (Stop / release: stopped; stream gone: tab_closed); take {tab, stream} → a reconnect moved the stream, the old
//    holder forgets it; expired {sid} → every hub drops its tabs of that session.
//  - A connected tab's entry lives LIVE_MS, refreshed by its hub's sweep: a crashed worker's tabs vanish by
//    themselves. A disconnected one lives graceMs (the in-process grace), then it is gone.
import type { ServerCtx } from '../core/dispatch.js'
import type { Session, Sid } from '../core/types.js'
import { sidHash } from '../core/audit.js'
import { ipKey } from '../security/ratelimit.js'
import { Script } from '../backends/redis.js'
import { redis } from '../redis/index.js'
import { cleanName, fail, fmtCode, hashId, newCode, normCode, TAB_LIMITS, TabHub, tabLimiter, token,
  type AgentState, type Frame, type TabAnswer, type TabLimiter, type TabOp } from './tab.js'

const LIVE_MS = 60_000
const NOTE_MS = 3_600_000
type Msg =
  | { t: 'frame'; tab: string; ev: string; data: unknown }
  | { t: 'res'; hub: string; cmd: string; a: TabAnswer }
  | { t: 'end'; tab: string; a: TabAnswer }
  | { t: 'take'; tab: string; stream: string }
  | { t: 'expired'; sid: string }

// the request is still open and the tab is free (or already this agent's): the request is used up, the tab is the agent's
const CLAIM = new Script(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 'gone' end
local cur = redis.call('HGET', KEYS[1], 'agent')
if cur and cur ~= '' and cur ~= ARGV[1] then return 'busy' end
if redis.call('DEL', KEYS[2]) == 0 then return 'gone' end
redis.call('HSET', KEYS[1], 'agent', ARGV[1], 'sreq', '', 'sat', '')
return 'ok'`)
// ends control of a tab: its agent ('' = none), the agent's h: dropped (if still this tab), the note set
const RELEASE = new Script(`
local tk = ARGV[1] .. 't:' .. ARGV[2]
local ag = redis.call('HGET', tk, 'agent')
if not ag or ag == '' then return '' end
redis.call('HSET', tk, 'agent', '')
local hk = ARGV[1] .. 'h:' .. ag
if redis.call('HGET', hk, 'tabId') == ARGV[2] then redis.call('DEL', hk) end
if ARGV[3] ~= '' then redis.call('SET', ARGV[1] .. 'n:' .. ag, ARGV[3], 'PX', ARGV[4]) end
return ag`)
// the stream ended: only the tab's current stream counts (a reconnect elsewhere already replaced it)
const GONE = new Script(`
if redis.call('HGET', KEYS[1], 'stream') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'hub', '')
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`)
// an agent's state() in one round trip: its tab (if that tab is still its own; a stale h: is dropped), else its open
// request (ARGV[3] = this server's now, as before), else its note
const STATE = new Script(`
local p, a = ARGV[1], ARGV[2]
local tab = redis.call('HGET', p .. 'h:' .. a, 'tabId')
if tab then
  if redis.call('HGET', p .. 't:' .. tab, 'agent') == a then return {'control', tab} end
  redis.call('DEL', p .. 'h:' .. a)
end
local id = redis.call('GET', p .. 'aa:' .. a)
if id then
  local r = redis.call('HMGET', p .. 'a:' .. id, 'agent', 'url', 'code', 'exp')
  if r[1] and (tonumber(r[4]) or 0) > tonumber(ARGV[3]) then return {'awaiting', r[2] or '', r[3] or ''} end
end
local n = redis.call('GET', p .. 'n:' .. a)
if n then return {'note', n} end
return false`)

export class SharedTabHub extends TabHub {
  private me = token()
  private local = new Map<string, { sid: Sid; send: Frame; stream: string }>()     // tabs whose stream is HERE
  private waiting = new Map<string, { tab: string; done(a: TabAnswer): void }>()  // commands forwarded FROM here
  private cmdRateS: TabLimiter
  private readRateS: TabLimiter
  private alias: string
  private ready: Promise<void>
  private hearing = (m: string) => { try { this.hear(JSON.parse(m) as Msg) } catch { /* a bad message */ } }

  constructor(server: ServerCtx) {
    super(server)
    this.alias = server.settings.channels.redis
    // per tab, on every server: settings.limits.backend (redis with --workers)
    this.cmdRateS = tabLimiter(server, 'cmd', { limit: 10, windowMs: 3_334 })
    this.readRateS = tabLimiter(server, 'read', { limit: 30, windowMs: 1_000 })
    this.ready = redis.subscriber(this.alias).then((s) => s.SUBSCRIBE(this.k('bus'), this.hearing))
    this.ready.catch((e: unknown) => server.log('error', 'tab hub: redis subscribe failed', { error: String(e) }))
    // a login rotation on this server while a command of the old sid runs on another: the new sid stays agent too
    const m = server.marks
    if (m) this.unrotate2 = server.sessions.onRotate((from, to) => {
      void m.has(from).then((h) => (h ? m.set(to, TAB_LIMITS.cmdMs + TAB_LIMITS.driftMs) : undefined)).catch(() => undefined)
    })
  }
  private unrotate2 = () => {}

  override close(): void {
    super.close(); this.unrotate2()
    void redis.subscriber(this.alias).then((s) => s.UNSUBSCRIBE(this.k('bus'), this.hearing)).catch(() => undefined)
  }
  override get size(): number { return this.local.size }

  private k(...p: string[]) { return redis.key(this.alias, 'tab', ...p) }
  private async r<T = unknown>(...args: (string | number)[]): Promise<T> { return (await redis.get(this.alias)).sendCommand<T>(args.map(String)) }
  private async hm<F extends string>(key: string, fields: readonly F[]): Promise<Record<F, string> | undefined> {
    const v = await this.r<(string | null)[]>('HMGET', key, ...fields)
    return v[0] == null ? undefined : Object.fromEntries(fields.map((f, i) => [f, v[i] ?? ''])) as Record<F, string>
  }
  private run(s: Script, keys: string[], args: (string | number)[]) { return redis.get(this.alias).then((c) => s.run<string | number>(c, keys, args)) }
  private pub(m: Msg): Promise<unknown> { return this.r('PUBLISH', this.k('bus'), JSON.stringify(m)) }
  private bg(p: Promise<unknown>) { p.catch((e: unknown) => this.server.log('error', 'tab hub: redis failed', { error: String(e) })) }

  private hear(m: Msg): void {
    if (m.t === 'frame') this.local.get(m.tab)?.send(m.ev, m.data)
    else if (m.t === 'res') { if (m.hub === this.me) this.waiting.get(m.cmd)?.done(m.a) }
    else if (m.t === 'end') { for (const w of [...this.waiting.values()]) if (w.tab === m.tab) w.done(m.a) }
    else if (m.t === 'take') { const l = this.local.get(m.tab); if (l && l.stream !== m.stream) this.local.delete(m.tab) }
    else if (m.t === 'expired') for (const [id, l] of [...this.local]) if (l.sid === m.sid) { this.local.delete(id); this.bg(this.dropTab(id)) }
  }
  // a frame to the tab: written here if its stream is here, else to the hub that holds it
  private frame(tab: string, ev: string, data: unknown): Promise<unknown> {
    const l = this.local.get(tab)
    if (l) { l.send(ev, data); return Promise.resolve() }
    return this.pub({ t: 'frame', tab, ev, data })
  }
  private end(tab: string, a: TabAnswer): Promise<unknown> {
    for (const w of [...this.waiting.values()]) if (w.tab === tab) w.done(a)
    return this.pub({ t: 'end', tab, a })
  }
  private async releaseTab(tab: string, why: string, note = ''): Promise<void> {
    if (!await this.run(RELEASE, [], [this.k(''), tab, note, NOTE_MS])) return
    await this.end(tab, fail('domain', 'stopped', 'control of the tab ended (the human pressed Stop or it was released); the step may have run'))
    await this.frame(tab, 'release', { why })
  }
  private async dropTab(tab: string): Promise<void> {
    await this.releaseTab(tab, 'tab_closed', 'not_connected')
    await this.r('DEL', this.k('t', tab))
  }

  // ---- tab lifecycle ----------------------------------------------------------------------------------------
  override async open(sid: Sid, send: Frame, want?: string, doc = ''): Promise<string> {
    await this.ready
    const stream = token()
    const old = want ? await this.hm(this.k('t', want), ['sid', 'doc', 'hub', 'agent'] as const) : undefined
    const keep = !!old && old.sid === sid && (!old.hub || (doc !== '' && old.doc === doc))
    const id = keep ? want! : token(), key = this.k('t', id)
    await this.r('HSET', key, 'hub', this.me, 'stream', stream, 'doc', doc, ...(keep ? [] : ['sid', sid, 'agent', '']))
    await this.r('PEXPIRE', key, LIVE_MS)
    this.local.set(id, { sid, send, stream })
    if (keep) this.bg(this.pub({ t: 'take', tab: id, stream }))
    send('hello', { tabId: id })
    if (keep && old.agent) {
      const h = await this.hm(this.k('h', old.agent), ['tabId', 'name', 'since'] as const)
      if (h?.tabId === id) send('control', { agent: h.name, verified: false, since: Number(h.since) })
    }
    return id
  }

  override gone(tabId: string, send: Frame): void {
    const l = this.local.get(tabId)
    if (!l || l.send !== send) return
    this.local.delete(tabId)
    this.bg((async () => {
      if (!await this.run(GONE, [this.k('t', tabId)], [l.stream, TAB_LIMITS.graceMs])) return
      await this.end(tabId, fail('expired_sid', 'tab_closed', 'the tab disconnected; the step may have run: read_page before retrying'))
    })())
  }

  // ---- agent side -------------------------------------------------------------------------------------------
  override async request(sid: () => Promise<Sid>, o: { name?: unknown; ip: string; base?: string }): Promise<TabAnswer & { sid?: Sid }> {
    if (!this.on) return fail('domain', 'forbidden', 'this site does not allow agents to control browser tabs')
    const limited = async (k: string) => { const r = await this.askRate.check({ sid: k }); return r.ok ? undefined : { ok: false as const, code: 'rate_limited' as const, message: `rate limited: retry after ${r.retryAfterMs}ms` } }
    const byIp = await limited(`ip:${ipKey(o.ip)}`)
    if (byIp) return byIp
    const agentSid = await sid()
    const bySid = await limited(`sid:${agentSid}`)
    if (bySid) return { ...bySid, sid: agentSid }
    await this.dropAsk(agentSid)   // newer replaces older
    const now = Date.now(), id = token(), code = newCode(), name = cleanName(o.name)
    const approveUrl = `${o.base ?? ''}/?tvine-approve=${id}`
    const ttl = TAB_LIMITS.requestTtlMs
    await this.r('HSET', this.k('a', id), 'agent', agentSid, 'name', name, 'exp', now + ttl, 'code', code, 'codeExp', now + TAB_LIMITS.codeTtlMs, 'url', approveUrl, 'tabId', '')
    await this.r('PEXPIRE', this.k('a', id), ttl)
    await this.r('SET', this.k('aa', agentSid), id, 'PX', ttl)
    await this.r('SET', this.k('c', code), id, 'PX', TAB_LIMITS.codeTtlMs)
    await this.r('SET', this.k('n', agentSid), 'timeout', 'PX', NOTE_MS)   // heard once the request expires unanswered
    return { ok: true, sid: agentSid, data: { requestId: id, approveUrl, code: fmtCode(code), expiresIn: ttl / 1000, verified: false, name } }
  }
  private async dropAsk(agentSid: Sid): Promise<void> {
    const id = await this.r<string | null>('GET', this.k('aa', agentSid))
    if (!id) return
    const code = await this.r<string | null>('HGET', this.k('a', id), 'code')
    await this.r('DEL', this.k('a', id), this.k('aa', agentSid), ...(code ? [this.k('c', code)] : []))
  }

  override async state(agentSid: Sid | undefined): Promise<AgentState | undefined> {
    if (!agentSid) return undefined
    // h: is gone after idleMs without a command
    const r = await redis.get(this.alias).then((c) => STATE.run<string[] | null>(c, [], [this.k(''), agentSid, Date.now()]))
    if (!r) return undefined
    if (r[0] === 'control') return { kind: 'control', tabId: r[1]! }
    if (r[0] === 'awaiting') return { kind: 'awaiting', approveUrl: r[1]!, code: fmtCode(r[2]!) }
    return { kind: 'note', reason: r[1]! }
  }

  override async forward(agentSid: Sid, op: TabOp, payload: unknown): Promise<TabAnswer> {
    await this.ready
    const h = await this.hm(this.k('h', agentSid), ['tabId'] as const)
    const tab = h?.tabId ?? '', tk = this.k('t', tab)
    const t = h && await this.hm(tk, ['sid', 'hub', 'agent'] as const)
    if (!t || t.agent !== agentSid) return fail('domain', 'not_connected', 'no tab under your control: call request_control')
    if (!t.hub) return fail('expired_sid', 'tab_closed', 'the tab is disconnected; retry shortly or call request_control again')
    const rl = await (op === 'read' || op === 'expand' ? this.readRateS : this.cmdRateS).check({ sid: `tab:${tab}` })
    if (!rl.ok) return { ok: false, code: 'rate_limited', message: `rate limited: retry after ${rl.retryAfterMs}ms` }
    await this.r('HSET', this.k('h', agentSid), 'used', Date.now())
    await this.r('PEXPIRE', this.k('h', agentSid), TAB_LIMITS.idleMs)
    const sid = t.sid, cmdId = token(), ck = this.k('cmd', cmdId)
    const bad = await this.begin(sid)
    if (bad) return bad
    try {
      const now = await this.hm(tk, ['sid', 'hub', 'agent'] as const)
      if (!now?.hub || now.agent !== agentSid) { this.settle(sid); return fail('domain', 'stopped', 'control of the tab ended') }
      await this.r('SET', ck, JSON.stringify({ tab, hub: this.me }), 'PX', TAB_LIMITS.cmdMs)
    } catch (e) { this.settle(sid); throw e }
    return new Promise((resolve) => {
      const done = (a: TabAnswer) => {
        if (!this.waiting.delete(cmdId)) return
        clearTimeout(timer)
        this.bg(this.r('DEL', ck))   // a late result is refused (409), like in one process
        this.settle(sid, a)
        resolve(a)
      }
      const timer = setTimeout(() => done(fail('domain', 'timeout', 'the tab did not answer in time; the step may have run: read_page before retrying')), TAB_LIMITS.cmdMs)
      timer.unref?.()
      this.waiting.set(cmdId, { tab, done })
      this.frame(tab, 'cmd', { cmdId, op, payload }).catch(() => done(fail('internal', undefined, 'internal error')))
    })
  }

  override async releaseAgent(agentSid: Sid): Promise<void> {
    await this.dropAsk(agentSid)
    await this.r('DEL', this.k('n', agentSid))
    const h = await this.hm(this.k('h', agentSid), ['tabId'] as const)
    if (h) await this.releaseTab(h.tabId, 'agent')
    await this.r('DEL', this.k('h', agentSid))
  }

  protected override expired(sid: Sid): void {
    this.bg((async () => {
      await this.pub({ t: 'expired', sid })   // every hub (this one too) drops its tabs of the session
      if (await this.r('EXISTS', this.k('h', sid))) await this.releaseAgent(sid)
      await this.dropAsk(sid)
      await this.r('DEL', this.k('n', sid))
    })())
  }

  protected override sweep(): void {
    super.sweep()   // the agent-marking tails
    for (const id of [...this.local.keys()]) this.bg((async () => {
      await this.r('PEXPIRE', this.k('t', id), LIVE_MS)
      // its agent's h: expired = no command for idleMs: the tab hears release
      const ag = await this.r<string | null>('HGET', this.k('t', id), 'agent')
      if (ag && await this.r('HGET', this.k('h', ag), 'tabId') !== id) await this.releaseTab(id, 'idle', 'not_connected')
    })())
  }

  // every hub's controlled tabs (tvine.admin's Agents page)
  // ponytail: a SCAN of tab:h:* per call (admin page only); keep an index set if controlled tabs get numerous
  override async controlled(): Promise<{ id: string; session: string; since: number; agent: string; used: number }[]> {
    const out = [], pre = this.k('h', '')
    for (const key of await this.scan(`${pre}*`)) {
      const agentSid = key.slice(pre.length), h = await this.hm(key, ['tabId', 'name', 'since', 'used'] as const)
      if (h && await this.r('HGET', this.k('t', h.tabId), 'agent') === agentSid) out.push({ id: hashId(h.tabId), session: sidHash(agentSid)!, since: Number(h.since), agent: h.name, used: Number(h.used) })
    }
    return out
  }
  override async revoke(id: string): Promise<boolean> {
    const pre = this.k('t', '')
    for (const key of await this.scan(`${pre}*`)) {
      const tab = key.slice(pre.length)
      if (hashId(tab) === id && await this.r('HGET', key, 'agent')) { await this.releaseTab(tab, 'human', 'not_connected'); return true }
    }
    return false
  }
  private async scan(match: string): Promise<string[]> {
    const out: string[] = []
    let cur = '0'
    do { const [next, keys] = await this.r<[string, string[]]>('SCAN', cur, 'MATCH', match, 'COUNT', 500); out.push(...keys); cur = next } while (cur !== '0')
    return out
  }

  // ---- tab side (POST /tvine/tab/*) ----------------------------------------------------------------------------
  override async own(session: Session, tabId: unknown): Promise<boolean> {
    return typeof tabId === 'string' && await this.r('HGET', this.k('t', tabId), 'sid') === session.sid
  }

  override async show(session: Session, b: Record<string, unknown>): Promise<[number, unknown]> {
    const tab = b.tabId as string
    if (!await this.own(session, tab)) return [403, { error: 'not your tab' }]
    const id = typeof b.requestId === 'string' ? b.requestId : ''
    const a = id ? await this.hm(this.k('a', id), ['agent', 'name', 'exp', 'tabId'] as const) : undefined
    const now = Date.now()
    // first tab wins (a tab that is gone no longer holds it)
    if (!a || Number(a.exp) <= now || (a.tabId && a.tabId !== tab && await this.r('EXISTS', this.k('t', a.tabId)))) return [404, { error: 'this request expired or was already used' }]
    const cur = await this.r<string | null>('HGET', this.k('t', tab), 'agent')
    if (cur && cur !== a.agent) return this.refuse(id, a.agent, tab, 'busy')
    await this.r('HSET', this.k('a', id), 'tabId', tab)
    await this.r('PEXPIRE', this.k('a', id), Math.max(1, Number(a.exp) - now))
    await this.r('HSET', this.k('t', tab), 'sreq', id, 'sat', now)
    return [200, { requestId: id, name: a.name, verified: false }]
  }

  override async approve(session: Session, b: Record<string, unknown>, ip: string): Promise<[number, unknown]> {
    const tab = b.tabId as string
    if (!await this.own(session, tab)) return [403, { error: 'not your tab' }]
    const now = Date.now(), F = ['agent', 'name', 'exp', 'code', 'codeExp', 'tabId'] as const
    let id: string, a: Record<(typeof F)[number], string> | undefined
    if (typeof b.code === 'string') {
      const k = ipKey(ip), fk = this.k('f', k), f = await this.hm(fk, ['n', 'until'] as const)
      if (f && Number(f.n) >= TAB_LIMITS.codeFails && Number(f.until) > now) return [429, { error: 'too many wrong codes; try again later' }]
      for (const key of [`tab:${tab}`, `ip:${k}`]) if (!(await this.codeRate.check({ sid: key })).ok) return [429, { error: 'too many tries; wait a minute' }]
      const typed = normCode(b.code)
      id = (/^[0-9A-Z]{8}$/.test(typed) ? await this.r<string | null>('GET', this.k('c', typed)) : null) ?? ''
      a = id ? await this.hm(this.k('a', id), F) : undefined
      if (!a || Number(a.codeExp) <= now || Number(a.exp) <= now) {
        const n = Number(f?.n ?? 0) + 1, until = n >= TAB_LIMITS.codeFails ? now + TAB_LIMITS.lockMs : now + 60_000
        await this.r('HSET', fk, 'n', n, 'until', until)
        await this.r('PEXPIRE', fk, until - now)
        return [403, { error: 'wrong or expired code' }]
      }
      if (a.tabId && a.tabId !== tab) return [404, { error: 'this request is shown in another tab' }]
    } else {
      id = typeof b.requestId === 'string' ? b.requestId : ''
      a = id ? await this.hm(this.k('a', id), F) : undefined
      const t = await this.hm(this.k('t', tab), ['sid', 'sreq', 'sat'] as const)
      if (!a || Number(a.exp) <= now || a.tabId !== tab || t?.sreq !== id) return [404, { error: 'this request expired or was not shown in this tab' }]
      if (b.allow !== false && now - Number(t.sat) < TAB_LIMITS.armMs) return [409, { error: 'too early' }]
    }
    if (b.allow === false) return this.refuse(id, a.agent, tab, b.reason === 'busy' ? 'busy' : 'human_denied')
    const r = await this.run(CLAIM, [this.k('t', tab), this.k('a', id)], [a.agent])
    if (r === 'busy') return this.refuse(id, a.agent, tab, 'busy')
    if (r !== 'ok') return [404, { error: 'this request expired or was already used' }]
    // an agent controls one tab at a time: a new approval releases the first
    const prev = await this.hm(this.k('h', a.agent), ['tabId'] as const)
    await this.r('DEL', this.k('aa', a.agent), this.k('c', a.code))
    await this.r('HSET', this.k('h', a.agent), 'tabId', tab, 'name', a.name, 'since', now, 'used', now)
    await this.r('PEXPIRE', this.k('h', a.agent), TAB_LIMITS.idleMs)
    await this.r('SET', this.k('n', a.agent), 'not_connected', 'PX', NOTE_MS)   // heard once control ends (Stop, idle, tab gone)
    if (prev && prev.tabId !== tab) await this.releaseTab(prev.tabId, 'replaced')
    await this.frame(tab, 'control', { agent: a.name, verified: false, since: now })
    return [200, { agent: a.name, verified: false }]
  }

  private async refuse(id: string, agentSid: Sid, tab: string, reason: 'busy' | 'human_denied'): Promise<[number, unknown]> {
    const code = await this.r<string | null>('HGET', this.k('a', id), 'code')
    await this.r('DEL', this.k('a', id), ...(code ? [this.k('c', code)] : []))
    if (await this.r('GET', this.k('aa', agentSid)) === id) await this.r('DEL', this.k('aa', agentSid))
    await this.r('SET', this.k('n', agentSid), reason, 'PX', NOTE_MS)
    if (await this.r('HGET', this.k('t', tab), 'sreq') === id) await this.r('HSET', this.k('t', tab), 'sreq', '', 'sat', '')
    return reason === 'busy' ? [409, { error: 'busy: another agent controls this tab' }] : [200, { denied: true }]
  }

  override async result(session: Session, b: Record<string, unknown>): Promise<[number, unknown]> {
    const tab = b.tabId as string
    if (!await this.own(session, tab)) return [403, { error: 'not your tab' }]
    const v = typeof b.cmdId === 'string' ? await this.r<string | null>('GETDEL', this.k('cmd', b.cmdId)) : null
    const c = v ? JSON.parse(v) as { tab: string; hub: string } : undefined
    if (!c || c.tab !== tab) return [409, { error: 'no such pending command' }]   // forged, late or replayed: dropped
    const a: TabAnswer = { ok: true, data: b.result ?? null }
    if (c.hub === this.me) this.waiting.get(b.cmdId as string)?.done(a)
    else await this.pub({ t: 'res', hub: c.hub, cmd: b.cmdId as string, a })
    return [200, { ok: true }]
  }

  override async stop(session: Session, b: Record<string, unknown>): Promise<[number, unknown]> {
    const tab = b.tabId as string
    if (!await this.own(session, tab)) return [403, { error: 'not your tab' }]
    await this.releaseTab(tab, 'human', 'not_connected')
    return [200, { ok: true }]
  }
}
