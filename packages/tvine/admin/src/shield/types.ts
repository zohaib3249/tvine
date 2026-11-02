// tvine.shield panel: the CONTRACT types (docs/design/contrib/shield.md, mirrored from warp/src/contrib/shield/types.ts —
// the admin package only imports weft) + the panel action result shapes the UI reads.
export type BotCategory = 'search' | 'ai-crawler' | 'ai-agent' | 'monitor' | 'seo' | 'scraper' | 'scanner' | 'automation' | 'browser' | 'unknown'
export type ChallengeLevel = 'pow' | 'checkbox' | 'captcha'
export type Op = 'eq' | 'neq' | 'in' | 'notIn' | 'contains' | 'startsWith' | 'endsWith' | 'regex' | 'gt' | 'lt' | 'cidr'
export interface Cond { field: string; op: Op; value: unknown }
export type Condition = Cond | { all: Condition[] } | { any: Condition[] } | { not: Condition }
export type Action =
  | { type: 'allow' } | { type: 'log' }
  | { type: 'challenge'; level: 'auto' | ChallengeLevel; ttl?: string }
  | { type: 'block'; status?: 403 | 404 | 429 | 451; message?: string }
  | { type: 'rateLimit'; limit: number; window: string; key: 'ip' | 'asn' | 'path' | 'ip+path' }
  | { type: 'custom'; name: string }
export interface Rule { id: string; name: string; enabled: boolean; order: number; when: Condition; then: Action; ttl?: string; hits?: number; hits24h?: number; spark?: number[] }
export interface SensorReport {
  webdriver: boolean; headless: string[]; webgl?: string; canvas?: string; audio?: string
  screen: string; tz: string; langs: string[]; touch: number; cores?: number; plugins: number
  behaviour: { moves: number; entropy: number; scrolls: number; keys: number; dwellMs: number }
}
export interface Signals {
  ip: string; ipNet: string
  country?: string; asn?: number; asnOrg?: string; asnKind?: 'datacenter' | 'residential' | 'mobile' | 'unknown'
  tor: boolean
  ua: string; uaFamily?: string
  bot: { name?: string; category: BotCategory; verified: boolean; spoofed: boolean; via?: 'rdns' | 'ip-range' | 'web-bot-auth' | 'token' }
  headerScore: number
  tls?: { ja3?: string; ja4?: string }
  path: string; method: string; host: string
  rate: { ip: number; asn: number; path: number }
  clearance?: { valid: boolean; level: ChallengeLevel; score: number; reason?: 'expired' | 'mismatch' | 'bad-signature' }
  sensor?: SensorReport
  score: number
}
export interface Decision { action: Action['type'] | 'pass'; ruleId?: string; level?: ChallengeLevel; status?: number; reason: string; mode: 'log' | 'enforce'; score: number; ray: string; ms: number }

// ---- panel action results ------------------------------------------------------------------------------------------
export type Mode = 'off' | 'log' | 'enforce'
export type Stance = 'allow' | 'challenge' | 'block'
export type Count = { key: string; label?: string; count: number }
// shield.overview { range } (series: one per decision, x = time bucket; histogram: 10 buckets of score 1..99)
export type Overview = {
  totals: { requests: number; blocked: number; challenged: number; passRate: number; avgScore: number; previous?: { requests: number; blocked: number; challenged: number; passRate: number; avgScore: number } }
  series: { groupBy?: 'hour' | 'day'; series: { name: string; label: string }[]; points: { x: string; values: number[] }[] }
  top: { ips: Count[]; asns: Count[]; countries: Count[]; bots: Count[] }
  histogram: number[]
}
export type ListEntry = { id: string; kind: 'ip' | 'cidr' | 'country' | 'asn'; value: string; list: 'allow' | 'deny'; note?: string }
export type BotInfo = { name: string; category: BotCategory; verified: boolean; via?: string; hits?: number }
export type Bots = { stances: Partial<Record<BotCategory, Stance>>; catalog: BotInfo[] }
export type EventRow = { ts: string; ray: string; ip?: string; country?: string; asn?: number; path: string; method?: string; bot?: string; score: number; decision: Decision['action'] | `would-${string}`; ruleId?: string
  ua?: string; uaFamily?: string; botCategory?: BotCategory; asnOrg?: string; status?: number; reason?: string; level?: ChallengeLevel; host?: string; mode?: 'log' | 'enforce'; solveMs?: number }
export type EventPage = { rows: EventRow[]; count: number; page: number; pages: number }
// shield.event { ray }
export type EventDetail = { event: EventRow; signals?: Signals; decision?: Decision; headers?: Record<string, string> }
export type TestResult = { signals: Signals; trace: { ruleId: string; matched: boolean; ms: number; name?: string }[]; decision: Decision; scoreParts?: { signal: string; weight: number }[] }
export type UserField = { name: string; label?: string; type: FieldType; choices?: string[] }
export type StatsBucket = '1m' | '5m' | '15m' | '1h' | '1d'
export type EventsConf = { logAll: boolean; samplePass: number; maxPerMinute: number; hardCapPerMinute: number; retentionDays: number; storeIp: boolean }
export type ShieldSettings = { mode: Mode; clearanceTtl: string; levels: ChallengeLevel[]; access: Condition; userFields?: UserField[]
  events?: EventsConf; stats?: { bucket: StatsBucket; retentionDays: number }; cleanup?: { enabled: boolean; schedule?: string }; dropped?: number }
export type IpdbStatus = { source: string; updatedAt?: string; ok: boolean; rows?: number; next?: string; message?: string }
export type FieldType = 'string' | 'number' | 'boolean' | 'ip' | 'country' | 'category' | 'kind' | 'list'

// ---- analytics (shield.analytics / shield.events / shield.ip / shield.rules.preview) --------------------------------
export type Range = '1h' | '24h' | '7d' | '30d'
export const FILTER_FIELDS = ['decision', 'country', 'asn', 'botCategory', 'botName', 'path', 'method', 'ip', 'ipNet', 'ruleId', 'uaFamily', 'status', 'mode', 'tlsJa4', 'host'] as const
export type FilterField = typeof FILTER_FIELDS[number]
export type Filter = { field: FilterField; op: 'eq' | 'neq'; value: string }
export type TopRow = { key: string; label?: string; count: number; mitigated: number }
export type TopKey = 'countries' | 'asns' | 'paths' | 'ips' | 'bots' | 'botCategories' | 'rules' | 'methods' | 'uaFamilies' | 'statuses' | 'ja4' | 'hosts'
type Totals = { requests: number; served: number; mitigated: number; blocked: number; challenged: number; rateLimited: number; solved: number; failed: number; logged: number; avgScore: number }
type CD = { groupBy?: 'hour' | 'day' | 'time'; series: { name: string; label: string }[]; points: { x: string; values: number[] }[] }
export type Analytics = {
  range: { from: string; to: string; step: string }; source: 'rollups' | 'events'; sampled: boolean; sampleRate: number
  totals: Totals & { previous?: Partial<Totals> }
  series: CD; decisions: CD; histogram: number[]
  funnel: { issued: number; solved: number; failed: number; solveMsP50?: number; solveMsP95?: number }
  geo: { country: string; requests: number; mitigated: number }[]
  top: Partial<Record<TopKey, TopRow[]>>
}
export type IpProfile = {
  ip: string; ipNet: string; country?: string; asn?: number; asnOrg?: string; asnKind?: string; tor: boolean
  lists: { kind: ListEntry['kind']; value: string; list: ListEntry['list']; id: string }[]
  counts: { requests: number; mitigated: number; byDecision: Record<string, number> }
  firstSeen?: string; lastSeen?: string; recent: EventRow[]
  test: { action: string; reason: string; ruleId?: string; score: number }
}
export type RulePreview = { matched: number; scanned: number; sample: EventRow[] }
