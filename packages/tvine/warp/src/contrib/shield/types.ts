// tvine.shield contract types (docs/design/contrib/shield.md CONTRACT). Shared by the engine, the challenge page
// and the /shield panel: change only via the coordinator.
export type BotCategory = 'search' | 'ai-crawler' | 'ai-agent' | 'monitor' | 'seo' | 'scraper' | 'scanner' | 'automation' | 'browser' | 'unknown'
export interface Signals {
  ip: string; ipNet: string                       // ipNet = /24 (v4) or /64 (v6) via ipKey
  country?: string; asn?: number; asnOrg?: string; asnKind?: 'datacenter' | 'residential' | 'mobile' | 'unknown'
  tor: boolean
  ua: string; uaFamily?: string                   // e.g. 'chrome', 'firefox', 'safari', 'curl'
  bot: { name?: string; category: BotCategory; verified: boolean; spoofed: boolean; via?: 'rdns' | 'ip-range' | 'web-bot-auth' | 'token' }
  headerScore: number                             // 0..1 consistency (1 = consistent real browser)
  tls?: { ja3?: string; ja4?: string }
  path: string; method: string; host: string
  rate: { ip: number; asn: number; path: number } // requests in the last 60 s
  clearance?: { valid: boolean; level: ChallengeLevel; score: number; reason?: 'expired' | 'mismatch' | 'bad-signature' }
  sensor?: SensorReport                           // present only on /verify and when a clearance carries it
  score: number                                   // 1 (bot) .. 99 (human)
}
export type ChallengeLevel = 'pow' | 'checkbox' | 'captcha'
export type Op = 'eq' | 'neq' | 'in' | 'notIn' | 'contains' | 'startsWith' | 'endsWith' | 'regex' | 'gt' | 'lt' | 'cidr'
export interface Cond { field: string; op: Op; value: unknown }
export type Condition = Cond | { all: Condition[] } | { any: Condition[] } | { not: Condition }
export type Action =
  | { type: 'allow' } | { type: 'log' }
  | { type: 'challenge'; level: 'auto' | ChallengeLevel; ttl?: string }
  | { type: 'block'; status?: 403 | 404 | 429 | 451; message?: string }
  | { type: 'rateLimit'; limit: number; window: string; key: 'ip' | 'asn' | 'path' | 'ip+path' }
  | { type: 'custom'; name: string }               // shield.registerRule(name, fn)
export interface Rule { id: string; name: string; enabled: boolean; order: number; when: Condition; then: Action; ttl?: string; hits?: number }
export interface Decision { action: Action['type'] | 'pass'; ruleId?: string; level?: ChallengeLevel; status?: number; reason: string; mode: 'log' | 'enforce'; score: number; ray: string; ms: number }
export interface SensorReport {
  webdriver: boolean; headless: string[]; webgl?: string; canvas?: string; audio?: string
  screen: string; tz: string; langs: string[]; touch: number; cores?: number; plugins: number
  behaviour: { moves: number; entropy: number; scrolls: number; keys: number; dwellMs: number }
}
