'use client'
import { useEffect, useRef, useState } from 'react'
import type { TvineEvent } from '../types.js'

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
  cb.current = opts.onUpdate

  useEffect(() => {
    if (!enabled) { setStatus('off'); return }
    setStatus('connecting')
    const es = new EventSource('/tvine/channel')
    let decay: ReturnType<typeof setTimeout> | undefined
    const parse = (m: { data: string }): TvineEvent | undefined => { try { return JSON.parse(m.data) } catch { return undefined } }
    es.addEventListener('open', () => setStatus('live'))
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
