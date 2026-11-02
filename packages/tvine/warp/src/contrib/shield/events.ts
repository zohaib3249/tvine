// tvine.shield events: the admin rollup tap (+ the admin:live 'shield' nudge, via the Collector), throttled
// securityEvent lines, ShieldEvent rows (every non-pass decision up to 50/s, passes sampled by settings.shield.events.sample).
import { createHmac } from 'node:crypto'
import { securityEvent } from '../../core/audit.js'
import { statTap } from '../../core/metrics.js'
import type { Settings } from '../../core/types.js'
import { secretKeys } from '../../security/signing.js'
import { ShieldEvent } from './models.js'
import { countHit } from './store.js'
import type { Decision, Signals } from './types.js'

export const ipHash = (ip: string) => createHmac('sha256', secretKeys()[0] ?? '').update(`shield:${ip}`).digest('hex').slice(0, 24)
const seen = new Map<string, number>()   // securityEvent throttle: one line per (decision, ip range) a minute
let second = 0, written = 0

export function record(settings: Settings, s: Signals, d: Decision, _req: unknown, o: { failed?: boolean; passed?: boolean; dryRun?: boolean } = {}): void {
  if (o.dryRun) return
  const decision = o.failed ? 'challenge-failed' : o.passed ? 'challenge-passed' : d.action
  countHit(d.ruleId)
  statTap({ k: 'shield', decision, category: s.bot.category, mode: d.mode })
  const notable = decision !== 'pass' && decision !== 'allow'
  if (notable) {
    const k = `${decision}|${s.ipNet}`, now = Date.now()
    if ((seen.get(k) ?? 0) < now - 60_000) {
      if (seen.size > 10_000) seen.clear()
      seen.set(k, now)
      securityEvent(`shield_${decision.replace(/-/g, '_')}`, { ip: s.ip, path: s.path, ray: d.ray, rule: d.ruleId ?? null, bot: s.bot.name ?? s.bot.category, score: s.score, mode: d.mode, reason: d.reason.slice(0, 200) }, { settings, audit: false, level: 'info' })
    }
  }
  const sec = Math.floor(Date.now() / 1000)
  if (sec !== second) { second = sec; written = 0 }
  if (notable ? written >= 50 : Math.random() >= settings.shield.events.sample) return
  written++
  void ShieldEvent.create({
    ray: d.ray, ipHash: ipHash(s.ip), ip: settings.shield.events.storeIp ? s.ip : null, country: s.country ?? null, asn: s.asn ?? null,
    path: s.path.slice(0, 500), bot: s.bot.name ?? null, category: s.bot.category, score: s.score, decision, ruleId: d.ruleId ?? null, mode: d.mode,
  } as never).catch(() => undefined)   // not migrated yet / db down: the request never fails for an event row
}
