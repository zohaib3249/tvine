'use client'
// Live updates for the dashboard + system pages: one EventSource per channel group (`/tvine/channel?group=admin:live`,
// cookie-authenticated, staff/superuser gated by the server). Frames are `event: admin`, data `{ type, ... }`.
// The browser reconnects by itself; a stream the server closed for good (401/403) falls back to polling.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Call } from './data.js'

export type LiveState = 'connecting' | 'live' | 'offline'
export type LiveFrame = { type: string; [k: string]: unknown }

type Hub = { es?: EventSource; subs: Set<(f: LiveFrame) => void>; states: Set<(s: LiveState) => void>; state: LiveState }
const hubs = new Map<string, Hub>()

function hub(group: string): Hub {
  let h = hubs.get(group)
  if (h) return h
  h = { subs: new Set(), states: new Set(), state: 'connecting' }
  hubs.set(group, h)
  const set = (s: LiveState) => { h!.state = s; for (const f of h!.states) f(s) }
  if (typeof EventSource !== 'function') { set('offline'); return h }
  const es = new EventSource(`/tvine/channel?group=${encodeURIComponent(group)}`)
  h.es = es
  es.onopen = () => set('live')
  es.onerror = () => set(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
  const onFrame = (e: MessageEvent) => {
    let f: unknown
    try { f = JSON.parse(e.data) } catch { return }
    // the server may wrap a frame in the channel envelope ({ kind: 'patch', changes })
    const v = (f && typeof f === 'object' && 'changes' in f ? (f as { changes: unknown }).changes : f) as LiveFrame
    if (v && typeof v === 'object' && typeof v.type === 'string') for (const s of h!.subs) s(v)
  }
  es.addEventListener('admin', onFrame as EventListener)
  es.addEventListener('patch', onFrame as EventListener)
  return h
}

export function useLive(group: string | null, onFrame?: (f: LiveFrame) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting')
  const cb = useRef(onFrame)
  cb.current = onFrame
  useEffect(() => {
    if (!group) return
    const h = hub(group)
    const sub = (f: LiveFrame) => cb.current?.(f)
    h.subs.add(sub); h.states.add(setState); setState(h.state)
    return () => {
      h.subs.delete(sub); h.states.delete(setState)
      if (!h.subs.size) { h.es?.close(); hubs.delete(group) }
    }
  }, [group])
  return state
}

// One api read kept fresh: reloads on a live frame (debounced ≥ 5 s), polls every 5 s while the stream is offline.
// A reload keeps the previous data on screen (refetch keeps the frame).
export function useLiveData<T>(call: Call, id: string, params: unknown, o: { group?: string | null; every?: number; types?: string[]; minMs?: number } = {}) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<{ code: string; message: string; reason?: string }>()
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(params ?? {})
  const seq = useRef(0)
  const load = useCallback(async () => {
    const n = ++seq.current
    setLoading(true)
    const r = await call(id, params ?? {})
    if (n !== seq.current) return
    setLoading(false)
    if (r.ok) { setData(r.data as T); setError(undefined) } else setError({ code: r.code, message: r.message, reason: r.reason })
  }, [call, id, key])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const last = useRef(0)
  const state = useLive(o.group ?? null, (f) => {
    if (o.types && !o.types.includes(f.type)) return
    if (timer.current) return
    const wait = Math.max(0, (o.minMs ?? 5000) - (Date.now() - last.current))   // ≥ minMs (5 s) between refetches (rate limits)
    timer.current = setTimeout(() => { timer.current = undefined; last.current = Date.now(); void load() }, wait)
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const poll = o.every ?? (state === 'offline' ? 5000 : 0)
  useEffect(() => {
    if (!poll) return
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load() }, poll)
    return () => clearInterval(t)
  }, [poll, load])
  return { data, error, loading, reload: load, live: o.group ? state : undefined }
}

export function LivePill({ state }: { state?: LiveState }) {
  if (!state) return null
  const text = state === 'live' ? 'Live' : state === 'connecting' ? 'Reconnecting…' : 'Offline · polling'
  return <span className="tva-live" data-state={state} role="status" aria-live="polite">{text}</span>
}
