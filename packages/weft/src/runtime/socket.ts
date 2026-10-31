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

// Same-origin SSE: the httpOnly session cookie rides along, no sid in the URL.
// Reconnect + Last-Event-ID resume are the browser's job (EventSource), not ours.
export function useTvineChannel(opts: { enabled?: boolean; onUpdate?: () => void } = {}): {
  status: 'off' | 'connecting' | 'live' | 'expired'
  agentActive: boolean
  lastEvent?: TvineEvent
} {
  const enabled = opts.enabled ?? true
  const [status, setStatus] = useState<'off' | 'connecting' | 'live' | 'expired'>(enabled ? 'connecting' : 'off')
  const [agentActive, setAgentActive] = useState(false)
  const [lastEvent, setLastEvent] = useState<TvineEvent>()
  const cb = useRef(opts.onUpdate)
  useLayoutEffect(() => { cb.current = opts.onUpdate })

  useEffect(() => {
    if (!enabled) { setStatus('off'); setAgentActive(false); return }
    setStatus('connecting')
    const es = new EventSource('/tvine/channel')
    let decay: ReturnType<typeof setTimeout> | undefined
    const parse = (m: { data: string }): TvineEvent | undefined => { try { return JSON.parse(m.data) } catch { return undefined } }
    es.addEventListener('open', () => setStatus('live'))
    // 401/403/429 arrive as plain JSON before any frame: the browser fires `error` and goes CLOSED, never retrying.
    es.addEventListener('error', () => setStatus(es.readyState === EventSource.CLOSED ? 'expired' : 'connecting'))
    es.addEventListener('update', (m) => {
      const e = parse(m as MessageEvent); if (!e) return
      setLastEvent(e)
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

  return { status, agentActive, lastEvent }
}

// ---- Tab control (security.md §Remote agents, transports.md §Tab socket) ---------------------------
// The tab's own stream `/tvine/channel?tab=<id>`: hello {tabId} → this tab can be controlled by a REMOTE
// agent after the human clicks Allow in the trusted chrome. Forwarded `cmd` frames run here through the
// in-tab executor (vetoes, presence, idempotency) and are answered by a result POST. Every tab POST is
// same-origin with the httpOnly cookie and `x-tvine-tab`; no sid is ever readable here.
const TAB_KEY = 'tvine.tab'
const RETRY_MS = 2_000
let connect: (() => void) | undefined

// Opens the Connect box (pairing-code fallback); an app may put this behind a menu item.
export function openConnect(): void { connect?.() }

// Read and strip a one-time param from the address bar (approveUrl must not linger in history/Referer).
function takeParam(name: string): string | null {
  const l = (globalThis as any).location
  if (!l) return null
  const u = new URL(l.href)
  const v = u.searchParams.get(name)
  if (v === null) return null
  u.searchParams.delete(name)
  try { history.replaceState(history.state, '', u.pathname + u.search + u.hash) } catch { /* sandboxed */ }
  return v
}
const store = () => { try { return globalThis.sessionStorage } catch { return undefined } }

// agent-presence.md: an agent's server-side `do` → outline the mounted widget bound to that action, if any.
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
  if (typeof EventSource === 'undefined') return () => {}
  const overlay = getOverlay()
  const tools = pageTools('tab')
  let es: EventSource | undefined, tabId: string | undefined, closed = false, retry: ReturnType<typeof setTimeout> | undefined
  let hello: Promise<void> | undefined, ready = () => {}
  let closePrompt = () => {}
  const post = async (op: string, body: object = {}): Promise<{ status: number; body: any }> => {
    try {
      const r = await fetch(`/tvine/tab/${op}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tvine-tab': '1' }, body: JSON.stringify({ tabId, ...body }) })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    } catch { return { status: 0, body: {} } }
  }
  const parse = (m: Event): any => { try { return JSON.parse((m as MessageEvent).data) } catch { return {} } }

  const released = () => {
    tabControl.remote = false
    abortRunning()
    overlay.setPill(null)
  }
  const stop = () => { released(); void post('release') }
  const controlled = (d: { agent?: string }) => {
    closePrompt()
    tabControl.remote = true
    overlay.setPill({ text: `${String(d.agent ?? 'Agent')} (unverified) connected`, button: 'Stop', onClick: stop })
  }
  const ask = async (requestId: string) => {
    const r = await post('request', { requestId })
    if (r.status !== 200) return   // expired, used, or busy (the server told the agent)
    if (webmcpActive()) { void post('approve', { requestId, allow: false, reason: 'busy' }); return }
    closePrompt()
    closePrompt = showRequest({
      name: String(r.body.name ?? 'Agent'),
      onAllow: () => { setStopped(false); void post('approve', { requestId }) },
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
        : { kind: 'err', code: 'invalid_param', message: 'unknown op' }
    } catch (e) { result = { kind: 'err', code: 'internal', message: e instanceof Error ? e.message : String(e) } }
    await post('result', { cmdId: d.cmdId, result })
  }

  const open = () => {
    if (closed) return
    const want = tabId ?? store()?.getItem(TAB_KEY) ?? ''
    const s = new EventSource(`/tvine/channel?tab=${encodeURIComponent(want)}`)
    es = s
    let got = false
    s.addEventListener('hello', (m) => {
      got = true
      tabId = String(parse(m).tabId ?? '')
      try { store()?.setItem(TAB_KEY, tabId) } catch { /* private mode */ }
      ready()
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
      closePrompt()
      closePrompt = showConnect(async (code) => {
        const r = await post('approve', { code })
        return r.status === 200 ? null : String(r.body.error ?? 'that did not work')
      })
    })
  }
  const approve = takeParam('tvine-approve')
  const wantConnect = takeParam('tvine-connect') !== null
  if (approve) void ensure(true).then(() => ask(approve))
  else if (wantConnect) connect()
  else void ensure(false)

  return () => {
    closed = true
    clearTimeout(retry)
    es?.close()
    closePrompt()
    if (tabControl.remote) released()
    connect = undefined
  }
}
