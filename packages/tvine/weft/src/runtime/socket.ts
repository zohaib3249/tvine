'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TvineEvent } from '../types.js'
import { getOverlay } from '../presence/overlay.js'
import { showConnect, showRequest } from '../presence/chrome.js'
import { abortRunning, setStopped } from './exec.js'
import { pageTools, tabControl, webmcpActive, withNav } from './webmcp.js'
import { getRegistry, type RegistryNode } from './registry.client.js'
import { listed } from '../widget/vocabulary.js'

const DECAY_MS = 30_000
const FINAL = new Set(['success', 'dead', 'expired', 'cancelled'])
const revOf = (e: TvineEvent) => { const m = /rev=(\d+)/.exec(String(e['#tvine'] ?? '')); return m ? Number(m[1]) : undefined }

// tvine.tasks: a background job of this session moved (update events with source 'job')
export interface JobUpdate { id: string; task: string; status: string; progress?: number; message?: string }

// Same-origin SSE: the httpOnly session cookie rides along, no sid in the URL.
// Reconnect + Last-Event-ID resume are the browser's job (EventSource), not ours.
export function useTvineChannel(opts: { enabled?: boolean; onUpdate?: () => void } = {}): {
  status: 'off' | 'connecting' | 'live' | 'expired'
  agentActive: boolean
  lastEvent?: TvineEvent
  lastJob?: JobUpdate
} {
  const enabled = opts.enabled ?? true
  const [status, setStatus] = useState<'off' | 'connecting' | 'live' | 'expired'>(enabled ? 'connecting' : 'off')
  const [agentActive, setAgentActive] = useState(false)
  const [lastEvent, setLastEvent] = useState<TvineEvent>()
  const [lastJob, setLastJob] = useState<JobUpdate>()
  const cb = useRef(opts.onUpdate)
  useLayoutEffect(() => { cb.current = opts.onUpdate })

  useEffect(() => {
    if (!enabled) { setStatus('off'); setAgentActive(false); return }
    setStatus('connecting')
    const es = new EventSource('/tvine/channel')
    let decay: ReturnType<typeof setTimeout> | undefined
    let rev: number | undefined
    const parse = (m: { data: string }): TvineEvent | undefined => { try { return JSON.parse(m.data) } catch { return undefined } }
    es.addEventListener('open', () => setStatus('live'))
    // 401/403/429 arrive as plain JSON before any frame: the browser fires `error` and goes CLOSED, never retrying.
    es.addEventListener('error', () => setStatus(es.readyState === EventSource.CLOSED ? 'expired' : 'connecting'))
    es.addEventListener('update', (m) => {
      const e = parse(m as MessageEvent); if (!e) return
      setLastEvent(e)
      const prev = rev, now = revOf(e)
      if (now !== undefined) rev = now
      if (e.source === 'job') {   // a job's progress is not agent activity; re-fetch only when the page may have changed
        const job = e.job as JobUpdate | undefined
        if (job) setLastJob(job)
        if ((job && FINAL.has(job.status)) || (prev !== undefined && now !== undefined && now > prev)) cb.current?.()
        return
      }
      if (e.source !== 'agent') return // human actions already re-render
      setAgentActive(true)
      clearTimeout(decay)
      decay = setTimeout(() => setAgentActive(false), DECAY_MS)
      cb.current?.()
    })
    es.addEventListener('err', (m) => {
      const e = parse(m as MessageEvent); if (!e) return
      setLastEvent(e)
      if (e.code === 'stale_rev') cb.current?.() // replay gap: re-fetch state
      else if (e.code === 'expired_sid') { es.close(); setStatus('expired') }
    })
    return () => { es.close(); clearTimeout(decay) }
  }, [enabled])

  return { status, agentActive, lastEvent, lastJob }
}

// ---- Tab control (security.md §Remote agents, transports.md §Tab socket) ---------------------------
// The tab's own stream `/tvine/channel?tab=<id>&doc=<nonce>`: hello {tabId} → this tab can be controlled by a
// REMOTE agent after the human clicks Allow in the trusted chrome. Forwarded `cmd` frames (ui/read/expand/do) run
// here through the in-tab executor and the tab's own cookie, and are answered by a result POST. Every tab POST is
// same-origin with the httpOnly cookie and `x-tvine-tab: <tabId>`; no sid is ever readable here.
// The stream opens only when needed: ?tvine-approve, ?tvine-connect, openConnect(), or this tab was under
// control before a reload. Never inside a frame (the Allow prompt must not be clickjackable).
const TAB_KEY = 'tvine.tab'              // this tab's id (reload keeps it)
const CTL_KEY = 'tvine.tab.ctl'          // '1' while a remote agent controls this tab
const STOP_KEY = 'tvine.tab.stopped'     // '1' after the human pressed Stop, until the server confirmed the release
const RETRY_MS = 2_000
const DOC = Math.random().toString(36).slice(2, 12)   // per-document nonce: another tab can't take over this stream
let connect: (() => void) | undefined

// Opens the Connect box (pairing-code fallback); an app may put this behind a menu item.
export function openConnect(): void { connect?.() }

// Read and strip a one-time param from the address bar (approveUrl must not linger in history/Referer).
// The value is remembered until used: React StrictMode (on in dev) mounts, unmounts and re-mounts the tab,
// and the first (discarded) mount must not swallow the approve code the live mount needs.
const taken = new Map<string, string>()
function takeParam(name: string): string | null {
  const l = (globalThis as any).location
  if (!l) return null
  const u = new URL(l.href)
  const v = u.searchParams.get(name)
  if (v === null) return taken.get(name) ?? null
  taken.set(name, v)
  u.searchParams.delete(name)
  try { history.replaceState(history.state, '', u.pathname + u.search + u.hash) } catch { /* sandboxed */ }
  return v
}
const store = () => { try { return globalThis.sessionStorage } catch { return undefined } }
// sessionStorage, mirrored in memory: when storage throws (private mode, blocked), the flag still holds for this
// document (a re-sent `control` stays refused until the release lands).
const mem = new Set<string>()
export function resetTabFlags(): void { mem.clear() }   // tests
const flag = (k: string, on?: boolean): boolean => {
  if (on === true) mem.add(k)
  else if (on === false) mem.delete(k)
  try {
    if (on === true) store()?.setItem(k, '1')
    else if (on === false) store()?.removeItem(k)
    return store()?.getItem(k) === '1' || mem.has(k)
  } catch { return mem.has(k) }
}
const framed = () => { try { return globalThis.top !== globalThis.self } catch { return true } }

// agent-presence.md: an agent's server-side action → outline the mounted widget bound to that action, if any.
function outlineAction(action: string): void {
  const find = (n: RegistryNode): RegistryNode | undefined => {
    for (const c of n.children) {
      if (c.el && c.spec && listed(c.spec).some(([, ctl]) => !!ctl.headless && 'params' in ctl.headless && ctl.headless.params.id === action)) return c
      const hit = find(c)
      if (hit) return hit
    }
  }
  const w = find(getRegistry().tree())
  if (w?.el && w.spec) getOverlay().begin(w.el, { verb: 'submit', label: w.spec.label, control: 'submit', options: w.spec.presence as never })()
}

export function connectTab(): () => void {
  if (typeof EventSource === 'undefined' || framed()) return () => {}
  const overlay = getOverlay()
  const tools = pageTools('tab')
  let es: EventSource | undefined, tabId: string | undefined, closed = false, retry: ReturnType<typeof setTimeout> | undefined
  let backoff: ReturnType<typeof setTimeout> | undefined   // the release loop's own timer (never shares `retry`)
  let hello: Promise<void> | undefined, ready = () => {}
  let closePrompt = () => {}
  const post = async (op: string, body: object = {}): Promise<{ status: number; body: any }> => {
    try {
      const r = await fetch(`/tvine/tab/${op}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tvine-tab': op === 'hello' ? '1' : tabId ?? '' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    } catch { return { status: 0, body: {} } }
  }
  const parse = (m: Event): any => { try { return JSON.parse((m as MessageEvent).data) } catch { return {} } }

  const released = () => {
    tabControl.remote = false
    flag(CTL_KEY, false)
    abortRunning()
    overlay.setPill(null)
  }
  // Stop must land: release is retried until the server says 200 (or that this tab/session is gone);
  // until then STOP_KEY makes any re-sent `control` (reconnect, reload) answer with release again.
  let releasing = false
  const release = async () => {
    if (releasing) return
    releasing = true
    for (let wait = 500; !closed; wait = Math.min(wait * 2, 10_000)) {
      const r = await post('release')
      if (r.status === 200 || r.status === 401 || r.status === 403) { flag(STOP_KEY, false); break }   // landed (or nothing left to release)
      await new Promise((ok) => { backoff = setTimeout(ok, wait) })
    }
    releasing = false
  }
  const stop = () => { flag(STOP_KEY, true); released(); void release() }
  const controlled = (d: { agent?: string }) => {
    closePrompt()
    if (flag(STOP_KEY)) { released(); void release(); return }   // the human said Stop: never silently resume
    tabControl.remote = true
    flag(CTL_KEY, true)
    overlay.setPill({ text: `Unverified agent "${String(d.agent ?? 'Agent')}" connected`, button: 'Stop', onClick: stop })
  }
  const allow = () => { flag(STOP_KEY, false); setStopped(false) }
  const ask = async (requestId: string) => {
    taken.delete('tvine-approve')   // used by the live mount: a later remount must not ask again
    const r = await post('request', { requestId })
    if (r.status !== 200) return   // expired, used, or busy (the server told the agent)
    if (webmcpActive()) { void post('approve', { requestId, allow: false, reason: 'busy' }); return }
    closePrompt()
    closePrompt = showRequest({
      name: String(r.body.name ?? 'Agent'),
      onAllow: () => { allow(); void post('approve', { requestId }) },
      onDeny: () => { void post('approve', { requestId, allow: false }) },
    })
  }
  const onCmd = async (d: { cmdId?: string; op?: string; payload?: any }) => {
    let result: unknown
    try {
      const p = d.payload ?? {}
      result = !tabControl.remote ? { kind: 'err', code: 'domain', reason: 'not_connected', message: 'this tab is not under agent control' }
        : d.op === 'ui' ? await withNav(() => tools.ui(p))
        : d.op === 'read' ? await withNav(() => tools.read_page(p))
        : d.op === 'expand' ? await withNav(() => tools.expand(p))
        : d.op === 'do' ? await withNav(() => tools.do(p))
        : { kind: 'err', code: 'invalid_param', message: 'unknown op' }
    } catch (e) { result = { kind: 'err', code: 'internal', message: e instanceof Error ? e.message : String(e) } }
    await post('result', { cmdId: d.cmdId, result })
  }

  const open = () => {
    if (closed) return
    const want = tabId ?? store()?.getItem(TAB_KEY) ?? ''
    const s = new EventSource(`/tvine/channel?tab=${encodeURIComponent(want)}&doc=${DOC}`)
    es = s
    let got = false
    s.addEventListener('hello', (m) => {
      got = true
      tabId = String(parse(m).tabId ?? '')
      try { store()?.setItem(TAB_KEY, tabId) } catch { /* private mode */ }
      ready()
      if (flag(STOP_KEY) && !releasing) void release()   // a Stop that may not have landed before the reload
    })
    s.addEventListener('control', (m) => controlled(parse(m)))
    s.addEventListener('release', () => released())
    s.addEventListener('cmd', (m) => { void onCmd(parse(m)) })
    s.addEventListener('update', (m) => { const d = parse(m); if (d.source === 'agent' && typeof d.action === 'string') outlineAction(d.action) })
    s.addEventListener('error', () => {
      s.close()
      if (!got) { hello = undefined; return }   // no session yet (401): nothing to control; a later ensure(true) mints one
      if (closed) return
      retry = setTimeout(open, RETRY_MS)
    })
  }
  // A cookie session first (minted after the server's origin + rate checks), then the stream; resolves on hello.
  const ensure = (mint: boolean) => (hello ??= (async () => {
    if (mint) await post('hello')
    await new Promise<void>((r) => { ready = r; open() })
  })())

  connect = () => {
    void ensure(true).then(() => {
      taken.delete('tvine-connect')   // only the live mount gets here (a discarded mount never opens its stream)
      closePrompt()
      closePrompt = showConnect(async (code) => {
        allow()
        const r = await post('approve', { code })
        return r.status === 200 ? null : String(r.body.error ?? 'that did not work')
      })
    })
  }
  const approve = takeParam('tvine-approve')
  const wantConnect = takeParam('tvine-connect') !== null
  if (approve) void ensure(true).then(() => ask(approve))
  else if (wantConnect) connect()
  else if (flag(CTL_KEY) || flag(STOP_KEY)) void ensure(false)   // reload of a controlled (or just stopped) tab

  return () => {
    closed = true
    clearTimeout(retry)
    clearTimeout(backoff)
    es?.close()
    closePrompt()
    if (tabControl.remote) { tabControl.remote = false; abortRunning(); overlay.setPill(null) }   // unmount ≠ release: CTL_KEY stays for the reload
    connect = undefined
  }
}
