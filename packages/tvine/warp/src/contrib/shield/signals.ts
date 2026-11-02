// tvine.shield signals (layers 1-3 + 7) and the 1..99 score. Pure where possible; the async parts (reverse DNS,
// the Web Bot Auth key directory) are cached and time-capped.
import { promises as dns } from 'node:dns'
import { createHash } from 'node:crypto'
import { ipKey } from '../../security/ratelimit.js'
import { asnKind, botOf, hasRanges, inRanges, isTor, lookupIp } from './data.js'
import { scoreSensor } from './sensor-score.js'
import type { BotCategory, SensorReport, Signals } from './types.js'

export const ipNetOf = (ip: string) => ipKey(ip).replace(/\.\d+$/, '.0/24')   // /24 (v4) or /64 (v6)
export const sha = (s: string, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n)

// ---- L3: UA family + header consistency ----------------------------------------------------------------------------
export function uaFamily(ua: string): string | undefined {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge'
  if (/OPR\//.test(ua)) return 'opera'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome'
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return 'safari'
  const m = /^([A-Za-z][\w.-]{0,30})\//.exec(ua)
  return m && m[1] !== 'Mozilla' ? m[1]!.toLowerCase() : undefined
}
const BROWSERS = new Set(['chrome', 'edge', 'opera', 'firefox', 'safari'])
const platformOf = (ua: string) => /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'Chrome OS' : /Linux/.test(ua) ? 'Linux' : undefined

// 0..1: how much this request looks like the real browser its UA claims (1 = every check holds). A non-browser UA
// scores 0.2 (consistent, but not a browser); an empty one 0.
export function headerScore(ua: string, h: (n: string) => string | undefined, secure: boolean): number {
  if (!ua) return 0
  const fam = uaFamily(ua)
  if (!fam || !BROWSERS.has(fam) || /HeadlessChrome/.test(ua)) return 0.2
  const checks: boolean[] = [!!h('accept'), !!h('accept-language'), !!h('accept-encoding')]
  const chUa = h('sec-ch-ua')
  const chromium = fam === 'chrome' || fam === 'edge' || fam === 'opera'
  const ver = Number(/(?:Chrome|CriOS)\/(\d+)/.exec(ua)?.[1] ?? 0)
  if (chromium && ver >= 90 && !/CriOS|Android.*wv/.test(ua) && secure) {
    checks.push(!!chUa)
    if (chUa) {
      checks.push(fam !== 'edge' || /Microsoft Edge/.test(chUa))
      checks.push(chUa.includes(`v="${ver}"`))   // the brand list carries the UA's major version
      const mob = h('sec-ch-ua-mobile'), plat = h('sec-ch-ua-platform')?.replace(/"/g, '')
      if (mob) checks.push((mob === '?1') === /Mobile/.test(ua))
      if (plat && platformOf(ua)) checks.push(plat === platformOf(ua))
    }
  }
  if ((fam === 'firefox' || fam === 'safari') && chUa) checks.push(false)   // they never send client hints
  if (secure) checks.push(!!h('sec-fetch-mode') && !!h('sec-fetch-dest'))
  return Math.round((checks.filter(Boolean).length / checks.length) * 100) / 100
}

// ---- L7: reverse + forward DNS (search engines), cached 1 h, 1.5 s cap -------------------------------------------------
export interface Resolver { reverse(ip: string): Promise<string[]>; lookup(host: string): Promise<string[]> }
export const resolver: { r: Resolver } = {
  r: { reverse: (ip) => dns.reverse(ip), lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address) },
}
const rdnsCache = new Map<string, { at: number; ok: boolean }>()
export const clearRdns = () => rdnsCache.clear()
const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), ms).unref())])
export async function verifyRdns(ip: string, suffixes: string[]): Promise<boolean> {
  const key = `${ip}|${suffixes.join(',')}`
  const hit = rdnsCache.get(key)
  if (hit && Date.now() - hit.at < 3_600_000) return hit.ok
  let ok = false
  try {
    const names = await timeout(resolver.r.reverse(ip), 1500)
    for (const n of names.slice(0, 5)) {
      const host = n.toLowerCase().replace(/\.$/, '')
      if (!suffixes.some((s) => host === s || host.endsWith(`.${s}`))) continue
      if ((await timeout(resolver.r.lookup(host), 1500)).includes(ip)) { ok = true; break }
    }
  } catch { ok = false }
  if (rdnsCache.size > 20_000) rdnsCache.clear()
  rdnsCache.set(key, { at: Date.now(), ok })
  return ok
}

// ---- L1 rate: requests in the last 60 s per key (sliding two-window estimate), this process --------------------------
// ponytail: per process; the rateLimit ACTION uses limiterFor (shared with redis), only the rate.* signal is local
const counters = new Map<string, { win: number; cur: number; prev: number }>()
export function hit(key: string, now = Date.now()): number {
  const win = Math.floor(now / 60_000)
  let c = counters.get(key)
  if (!c) { if (counters.size > 100_000) counters.clear(); counters.set(key, (c = { win, cur: 0, prev: 0 })) }
  if (c.win !== win) { c.prev = c.win === win - 1 ? c.cur : 0; c.cur = 0; c.win = win }
  c.cur++
  return Math.round(c.cur + c.prev * (1 - (now % 60_000) / 60_000))
}

// ---- assemble -------------------------------------------------------------------------------------------------------
export interface SignalInput {
  ip: string; method: string; path: string; host: string; secure: boolean
  header(name: string): string | undefined
  tls?: { ja3?: string; ja4?: string }
  verifiedAgent?: { directory: string; keyid: string }   // Web Bot Auth
  token?: boolean                                         // a valid Tvine API token (Bearer)
  clearance?: Signals['clearance']
  sensor?: SensorReport
  count?: boolean                                         // false: a dry run (shield.test) leaves the counters alone
}

export async function collectSignals(i: SignalInput): Promise<Signals> {
  const ua = (i.header('user-agent') ?? '').slice(0, 512)
  const geo = lookupIp(i.ip)
  const entry = ua ? botOf(ua) : undefined
  const fam = uaFamily(ua)
  let category: BotCategory = entry?.category ?? (fam && BROWSERS.has(fam) ? 'browser' : ua ? 'unknown' : 'automation')
  let name = entry?.name, verified = false, spoofed = false
  let via: Signals['bot']['via']
  if (i.verifiedAgent) { verified = true; via = 'web-bot-auth'; if (!entry || category === 'browser' || category === 'unknown') { category = 'ai-agent'; name ??= new URL(i.verifiedAgent.directory).host } }
  else if (i.token) { verified = true; via = 'token'; if (category !== 'browser') { category = 'ai-agent'; name ??= 'Tvine token' } }
  else if (entry?.rdns) { verified = await verifyRdns(i.ip, entry.rdns); via = verified ? 'rdns' : undefined; spoofed = !verified }
  else if (entry?.ranges && inRanges(entry.ranges, i.ip)) { verified = true; via = 'ip-range' }
  // ranges not loaded for that source: unverifiable, so neither verified nor spoofed
  else if (entry?.ranges && hasRanges(entry.ranges)) spoofed = true
  const count = i.count !== false
  const ipNet = ipNetOf(i.ip)
  const rate = count
    ? { ip: hit(`ip:${ipKey(i.ip)}`), asn: geo.asn ? hit(`asn:${geo.asn}`) : 0, path: hit(`path:${i.path}`) }
    : { ip: 0, asn: 0, path: 0 }
  const s: Signals = {
    ip: i.ip, ipNet, ...geo, asnKind: asnKind(geo.asn, geo.asnOrg), tor: isTor(i.ip),
    ua, ...(fam && { uaFamily: fam }),
    bot: { ...(name && { name }), category, verified, spoofed, ...(via && { via }) },
    headerScore: headerScore(ua, i.header, i.secure),
    ...(i.tls && (i.tls.ja3 || i.tls.ja4) && { tls: i.tls }),
    path: i.path, method: i.method, host: i.host, rate,
    ...(i.clearance && { clearance: i.clearance }),
    ...(i.sensor && { sensor: i.sensor }),
    score: 50,
  }
  s.score = score(s)
  return s
}

// ---- the score: 1 (bot) .. 99 (human) ---------------------------------------------------------------------------------
// Base by what the UA claims:          browser 20 + 60 x headerScore (20..80); unknown 25; ai-agent 30; monitor 20;
//                                      search (unverified) 15; seo / scraper / ai-crawler 10; automation 5; scanner 1
// Network (L1):                        datacenter -20, tor -15, residential / mobile +5
// Rate (L1):                           > 120/min from the ip -15, > 300/min -30
// Identity (L7):                       spoofed = 1 (strongest bot signal); verified = 50 (a known good bot)
// L4/L5 sensor (on /verify):           the mean of this score and sensor-score.ts's (its own weights there)
// Clearance:                           a valid clearance lifts the score to at least the score it was issued with
export const SCORE_BASE: Record<BotCategory, number> = { browser: 20, unknown: 25, 'ai-agent': 30, monitor: 20, search: 15, seo: 10, scraper: 10, 'ai-crawler': 10, automation: 5, scanner: 1 }
export function score(s: Signals): number {
  if (s.bot.spoofed) return 1
  if (s.bot.verified) return 50
  let n = s.bot.category === 'browser' ? 20 + 60 * s.headerScore : SCORE_BASE[s.bot.category]
  if (s.asnKind === 'datacenter') n -= 20
  else if (s.asnKind === 'residential' || s.asnKind === 'mobile') n += 5
  if (s.tor) n -= 15
  if (s.rate.ip > 300) n -= 30
  else if (s.rate.ip > 120) n -= 15
  if (s.sensor) n = (n + scoreSensor(s.sensor, s.clearance?.level).score) / 2
  if (s.clearance?.valid) n = Math.max(n, s.clearance.score)
  return Math.max(1, Math.min(99, Math.round(n)))
}
