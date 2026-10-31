'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TvineEvent } from '../types.js'

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
