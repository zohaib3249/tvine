// tvine.shield events. Per request (never a DB query): the admin rollup tap (decision / category / score bucket, and
// country / asn / rule for the notable ones → admin_stat hourly rollups via the stats Collector, + the admin:live
// 'shield' nudge) and a throttled securityEvent line. ShieldEvent rows: every non-pass decision + samplePass of the
// passes, at most maxPerMinute per process (the rest counted in `dropped`), queued in memory and written in batches
// (every 2 s or 200 rows) outside the request and its transaction; a failed batch is logged and dropped.
import { createHmac } from 'node:crypto'
import { securityEvent } from '../../core/audit.js'
import { statTap } from '../../core/metrics.js'
import type { Settings } from '../../core/types.js'
import { getLogger } from '../../log.js'
import { secretKeys } from '../../security/signing.js'
import { ShieldEvent } from './models.js'
import { countHit } from './store.js'
import type { Decision, Signals } from './types.js'

export const ipHash = (ip: string) => createHmac('sha256', secretKeys()[0] ?? '').update(`shield:${ip}`).digest('hex').slice(0, 24)
const seen = new Map<string, number>()   // securityEvent throttle: one line per (decision, ip range) a minute
export const queue: Record<string, unknown>[] = []
export const counters = { written: 0, dropped: 0, failed: 0 }
let minute = 0, inMinute = 0, timer: NodeJS.Timeout | undefined, flushing: Promise<void> | undefined

export interface Outcome { failed?: boolean; passed?: boolean; solveMs?: number; sensorFlags?: string[]; fpHash?: string; level?: string }
export function record(settings: Settings, s: Signals, d: Decision, _req: unknown, o: Outcome = {}): void {
  const decision = o.failed ? 'challenge-failed' : o.passed ? 'challenge-passed' : d.action
  countHit(d.ruleId)
  statTap({ k: 'shield', decision, category: s.bot.category, mode: d.mode, score: s.score, ...(s.country && { country: s.country }), ...(s.asn && { asn: s.asn }), ...(d.ruleId && { rule: d.ruleId }) })
  const notable = decision !== 'pass' && decision !== 'allow'
  if (notable) {
    const k = `${decision}|${s.ipNet}`, now = Date.now()
    if ((seen.get(k) ?? 0) < now - 60_000) {
      if (seen.size > 10_000) seen.clear()
      seen.set(k, now)
      securityEvent(`shield_${decision.replace(/-/g, '_')}`, { ip: s.ip, path: s.path, ray: d.ray, rule: d.ruleId ?? null, bot: s.bot.name ?? s.bot.category, score: s.score, mode: d.mode, reason: d.reason.slice(0, 200) }, { settings, audit: false, level: 'info' })
    }
  }
  const ev = settings.shield.events
  if (!notable && Math.random() >= ev.samplePass) return
  const m = Math.floor(Date.now() / 60_000)
  if (m !== minute) { minute = m; inMinute = 0 }
  if (inMinute >= ev.maxPerMinute) { counters.dropped++; return }
  inMinute++
  queue.push(eventRow(s, d, decision, ev.storeIp, o))
  if (queue.length >= 200) void flushEvents()
  else if (!timer) { timer = setTimeout(() => { timer = undefined; void flushEvents() }, 2000); timer.unref() }
}

// the ONLY fields a ShieldEvent keeps (owner data policy): no query string (s.path is the normalized path), no
// cookies / Authorization / header list / body, sensor flags + fingerprint hash only
export function eventRow(s: Signals, d: Decision, decision: string, storeIp: boolean, o: Outcome = {}): Record<string, unknown> {
  const notable = decision !== 'pass' && decision !== 'allow'
  return {
    ts: new Date(), ray: d.ray, ip: storeIp ? s.ip : null, ipHash: ipHash(s.ip), ipNet: s.ipNet,
    country: s.country ?? null, asn: s.asn ?? null, asnOrg: s.asnOrg?.slice(0, 200) ?? null, asnKind: s.asnKind ?? null,
    method: s.method.slice(0, 10), host: s.host.slice(0, 255), path: s.path.split('?')[0]!.slice(0, 500), ua: s.ua.slice(0, 300), uaFamily: s.uaFamily ?? null,
    botName: s.bot.name ?? null, botCategory: s.bot.category, botVerified: s.bot.verified, botVia: s.bot.via ?? null, spoofed: s.bot.spoofed,
    score: s.score, headerScore: s.headerScore, tlsJa4: s.tls?.ja4?.slice(0, 100) ?? null,
    decision: d.mode === 'log' && notable && !decision.startsWith('challenge-') && decision !== 'log' ? `would-${decision}` : decision,
    ruleId: d.ruleId ?? null, level: o.level ?? d.level ?? null, status: d.status ?? null, reason: d.reason.slice(0, 200),
    outcome: o.passed ? 'passed' : o.failed ? 'failed' : null, solveMs: o.solveMs ?? null, sensorFlags: o.sensorFlags?.slice(0, 20).map((f) => f.slice(0, 40)) ?? null, fpHash: o.fpHash ?? null,
  }
}

const log = getLogger('tvine.shield')
export function flushEvents(): Promise<void> {
  if (flushing) return flushing.then(() => (queue.length ? flushEvents() : undefined))
  if (!queue.length) return Promise.resolve()
  const batch = queue.splice(0, queue.length)
  flushing = ShieldEvent.objects.bulkCreate(batch, { batchSize: 200 })
    .then(() => { counters.written += batch.length })
    .catch((e: unknown) => { counters.failed += batch.length; log.warn('shield events batch dropped', { rows: batch.length, error: String(e).slice(0, 200) }) })
    .finally(() => { flushing = undefined })
  return flushing
}
