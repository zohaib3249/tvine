// The condition builder's catalog: the contract's rule fields (Signals) and the panel-access user fields, the ops each
// field type allows, and the small pure helpers the builder + tests share. Conditions stay the contract JSON throughout.
import type { BotCategory, Cond, Condition, FieldType, Op, UserField } from './types.js'

export type Field = { name: string; label: string; type: FieldType; choices?: string[]; help?: string }
export const BOT_CATEGORIES: { value: BotCategory; label: string; help: string }[] = [
  { value: 'search', label: 'Search engines', help: 'Googlebot, Bingbot, Applebot… They index your pages so people can find you. Verified by reverse DNS.' },
  { value: 'ai-crawler', label: 'AI crawlers', help: 'GPTBot, ClaudeBot, CCBot, Bytespider… They copy pages to train or ground AI models. No visitor is waiting.' },
  { value: 'ai-agent', label: 'AI agents acting for users', help: 'Claude-User, ChatGPT-User, Perplexity-User, MCP clients. A person asked an AI to open this page right now.' },
  { value: 'monitor', label: 'Uptime monitors', help: 'Pingdom, UptimeRobot, Datadog synthetics. They check that your site is up.' },
  { value: 'seo', label: 'SEO tools', help: 'Ahrefs, Semrush, Moz. They map links and keywords for marketers.' },
  { value: 'scraper', label: 'Scrapers', help: 'Price and content scrapers that copy your data in bulk.' },
  { value: 'scanner', label: 'Vulnerability scanners', help: 'sqlmap, Nikto, Nuclei, zgrab. They probe for security holes.' },
  { value: 'automation', label: 'Automation tools', help: 'curl, python-requests, Go http, headless browsers. Scripts with no browser behind them.' },
]
export const COUNTRIES = ['US', 'CA', 'MX', 'BR', 'AR', 'GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'ES', 'PT', 'IT', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'RO', 'UA', 'RU', 'TR', 'IL', 'SA', 'AE', 'EG', 'NG', 'KE', 'ZA', 'IN', 'PK', 'BD', 'CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH', 'AU', 'NZ', 'IR', 'KP']

export const RULE_FIELDS: Field[] = [
  { name: 'ip', label: 'IP address', type: 'ip' }, { name: 'cidr', label: 'IP range (CIDR)', type: 'ip' },
  { name: 'country', label: 'Country', type: 'country' }, { name: 'asn', label: 'ASN (network)', type: 'number' },
  { name: 'asn.kind', label: 'Network kind', type: 'kind', choices: ['datacenter', 'residential', 'mobile', 'unknown'] },
  { name: 'tor', label: 'Tor exit node', type: 'boolean' },
  { name: 'path', label: 'Path', type: 'string' }, { name: 'method', label: 'Method', type: 'kind', choices: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
  { name: 'host', label: 'Host', type: 'string' }, { name: 'ua', label: 'User agent', type: 'string' },
  { name: 'bot.name', label: 'Bot name', type: 'string' }, { name: 'bot.category', label: 'Bot category', type: 'category' },
  { name: 'bot.verified', label: 'Bot is verified', type: 'boolean' },
  { name: 'score', label: 'Score (1 bot … 99 human)', type: 'number' },
  { name: 'rate.ip', label: 'Requests/min from IP', type: 'number' }, { name: 'rate.asn', label: 'Requests/min from ASN', type: 'number' },
  { name: 'rate.path', label: 'Requests/min to path', type: 'number' }, { name: 'tls.ja4', label: 'TLS JA4 fingerprint', type: 'string' },
  { name: 'header.', label: 'Header…', type: 'string' }, { name: 'clearance', label: 'Has valid clearance', type: 'boolean' },
]
export const USER_FIELDS: Field[] = [
  { name: 'isSuperuser', label: 'Is superuser', type: 'boolean' }, { name: 'isStaff', label: 'Is staff', type: 'boolean' },
  { name: 'email', label: 'Email', type: 'string' }, { name: 'username', label: 'Username', type: 'string' },
  { name: 'groups', label: 'Groups', type: 'list' },
]
export const userFields = (extra: UserField[] = []): Field[] =>
  [...USER_FIELDS, ...extra.filter((f) => !USER_FIELDS.some((u) => u.name === f.name)).map((f) => ({ name: f.name, label: f.label ?? f.name, type: f.type, choices: f.choices }))]

export const OP_LABEL: Record<Op, string> = {
  eq: 'is', neq: 'is not', in: 'is one of', notIn: 'is not one of', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
  regex: 'matches regex', gt: 'greater than', lt: 'less than', cidr: 'is in range (CIDR)',
}
export const OPS: Record<FieldType, Op[]> = {
  string: ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'regex'],
  number: ['eq', 'neq', 'gt', 'lt', 'in', 'notIn'],
  boolean: ['eq'],
  ip: ['cidr', 'eq', 'neq', 'in', 'notIn'],
  country: ['in', 'notIn', 'eq', 'neq'],
  category: ['eq', 'neq', 'in', 'notIn'],
  kind: ['eq', 'neq', 'in', 'notIn'],
  list: ['contains'],
}
export const isMulti = (op: Op) => op === 'in' || op === 'notIn'
export const fieldOf = (fields: Field[], name: string): Field =>
  fields.find((f) => f.name === name) ?? (name.startsWith('header.') ? fields.find((f) => f.name === 'header.') : undefined) ?? { name, label: name, type: 'string' }

// a fresh leaf for a field: its first op and a value of the right shape
export function leaf(f: Field, op: Op = OPS[f.type][0]!): Cond {
  const value = isMulti(op) ? [] : f.type === 'boolean' ? true : f.type === 'number' ? 0 : f.choices?.[0] ?? (f.type === 'category' ? 'ai-crawler' : f.type === 'country' ? 'US' : '')
  return { field: f.name === 'header.' ? 'header.x-requested-with' : f.name, op, value }
}
// keep a value when an op changes between single and multi (eq 'US' → in ['US'])
export function coerce(v: unknown, op: Op, type: FieldType): unknown {
  if (isMulti(op)) return Array.isArray(v) ? v : v === '' || v === undefined ? [] : [v]
  const one = Array.isArray(v) ? v[0] : v
  if (type === 'number') return Number(one ?? 0) || 0
  if (type === 'boolean') return typeof one === 'boolean' ? one : one === 'true'
  return one ?? ''
}
export const isGroup = (c: Condition): c is { all: Condition[] } | { any: Condition[] } => 'all' in c || 'any' in c
export const kidsOf = (c: Condition): Condition[] => ('all' in c ? c.all : 'any' in c ? c.any : [])

// a plain-words sentence for a condition (rule list, the access summary): "country is one of US, CA and score less than 30"
export function describe(c: Condition, fields: Field[] = RULE_FIELDS): string {
  if ('not' in c) return `not (${describe(c.not, fields)})`
  if ('all' in c || 'any' in c) {
    const k = kidsOf(c)
    if (!k.length) return 'every request'
    const s = k.map((x) => (isGroup(x) && kidsOf(x).length > 1 ? `(${describe(x, fields)})` : describe(x, fields))).join('all' in c ? ' and ' : ' or ')
    return s
  }
  const f = fieldOf(fields, c.field)
  const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value)
  return `${c.field.startsWith('header.') ? c.field : f.label.toLowerCase()} ${OP_LABEL[c.op]} ${v || '…'}`
}

// CIDR / IP shape check for the value inputs (server validates for real)
export const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+:[0-9a-f:]*)$/i
export const CIDR_RE = /^(\d{1,3}(\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+:[0-9a-f:]*\/\d{1,3})$/i
