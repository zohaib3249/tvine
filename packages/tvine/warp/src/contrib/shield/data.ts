// tvine.shield static data (L1 network + the bot catalog). Bundled: warp/data/shield/*.json.gz (bot catalog, curated
// datacenter ASNs, the AI-range seed), lazy loaded like contrib/auth/passwords.ts. Downloaded (tasks.ts) into
// settings.shield.ipdb.dir: DB-IP Lite country + ASN CSVs (dbip-*-lite.csv.gz, CC BY 4.0) and ranges.json.
// The ipdb is a sorted range table searched by binary search: pure TS, no native deps, ~1 µs a lookup.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { join } from 'node:path'
import { gunzip, gunzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import type { BotCategory } from './types.js'

const DATA = new URL('../../../data/shield/', import.meta.url)   // the same path from src/ and dist/
const bundled = <T>(name: string): T => JSON.parse(gunzipSync(readFileSync(new URL(name, DATA))).toString('utf8')) as T

// ---- bot catalog: [pattern, name, category, verify?]; first match wins ---------------------------------------------
export interface BotEntry { re: RegExp; name: string; category: BotCategory; rdns?: string[]; ranges?: string }
let catalog: BotEntry[] | undefined
export const botCatalog = (): BotEntry[] => (catalog ??= bundled<[string, string, BotCategory, { rdns?: string[]; ranges?: string }?][]>('bots.json.gz')
  .map(([p, name, category, v]) => ({ re: new RegExp(p, 'i'), name, category, ...v })))
export function botOf(ua: string): BotEntry | undefined {
  const u = ua.slice(0, 512)
  return botCatalog().find((b) => b.re.test(u))
}

// ---- datacenter ASNs ----------------------------------------------------------------------------------------------
let dc: Map<number, string> | undefined
export const datacenterAsns = () => (dc ??= new Map(Object.entries(bundled<Record<string, string>>('datacenter-asns.json.gz')).map(([k, v]) => [Number(k), v])))
const HOSTING = /hosting|cloud|server|data ?cent(er|re)|\bvps\b|colo(cation)?|dedicated|compute/i
const MOBILE = /mobile|wireless|cellular|\blte\b|\b[345]g\b/i
export function asnKind(asn: number | undefined, org = ''): 'datacenter' | 'residential' | 'mobile' | 'unknown' {
  if (asn === undefined) return 'unknown'
  if (datacenterAsns().has(asn) || HOSTING.test(org)) return 'datacenter'
  return MOBILE.test(org) ? 'mobile' : 'residential'
}

// ---- published AI-crawler ranges + Tor exits (seed bundled; ranges.update refreshes <dir>/ranges.json) ---------------
export interface RangesFile { sources: Record<string, string>; tor: string; prefixes: Record<string, string[]>; torExits: string[]; updatedAt?: string }
export const rangesSeed = () => bundled<RangesFile>('ai-ranges.json.gz')
const ranges = { lists: new Map<string, BlockList>(), tor: new Set<string>(), updatedAt: undefined as string | undefined }
export function setRanges(r: RangesFile): void {
  ranges.lists = new Map(Object.entries(r.prefixes).map(([k, list]) => {
    const b = new BlockList()
    for (const c of list) { const [a, bits] = c.split('/'); const v = isIP(a ?? ''); if (v && bits && Number(bits) <= (v === 6 ? 128 : 32)) b.addSubnet(a!, Number(bits), v === 6 ? 'ipv6' : 'ipv4') }
    return [k, b]
  }))
  ranges.tor = new Set(r.torExits)
  ranges.updatedAt = r.updatedAt
}
export const inRanges = (source: string, ip: string): boolean => { const b = ranges.lists.get(source), v = isIP(ip); return !!b && !!v && b.check(ip, v === 6 ? 'ipv6' : 'ipv4') }
export const hasRanges = (source: string) => (ranges.lists.get(source)?.rules.length ?? 0) > 0
export const isTor = (ip: string) => ranges.tor.has(ip)
export const rangesStatus = () => ({ sources: ranges.lists.size, prefixes: [...ranges.lists.values()].reduce((n, b) => n + b.rules.length, 0), torExits: ranges.tor.size, updatedAt: ranges.updatedAt ?? null })

// ---- ipdb: DB-IP Lite CSV → sorted [start, end] tables ---------------------------------------------------------------
export const COUNTRY_FILE = 'dbip-country-lite.csv.gz'
export const ASN_FILE = 'dbip-asn-lite.csv.gz'
export function ip6n(ip: string): bigint {
  const [head, tail] = ip.toLowerCase().split('::')
  const part = (s: string | undefined) => (s ? s.split(':') : []).flatMap((g) => (g.includes('.') ? (() => { const n = g.split('.').map(Number); return [((n[0]! << 8) | n[1]!).toString(16), ((n[2]! << 8) | n[3]!).toString(16)] })() : [g]))
  const h = part(head), t = part(tail)
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16) || 0), 0n)
}
const ip4n = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)

class RangeTable<V> {
  s4: number[] = []; e4: number[] = []; v4: V[] = []
  s6: bigint[] = []; e6: bigint[] = []; v6: V[] = []
  add(start: string, end: string, v: V): void {
    if (isIP(start) === 4) { this.s4.push(ip4n(start)); this.e4.push(ip4n(end)); this.v4.push(v) }
    else if (isIP(start) === 6) { this.s6.push(ip6n(start)); this.e6.push(ip6n(end)); this.v6.push(v) }
  }
  get size() { return this.s4.length + this.s6.length }
  find(ip: string): V | undefined {
    const ver = isIP(ip)
    if (!ver) return undefined
    const mapped = ver === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
    if (ver === 4 || mapped) return search(this.s4, this.e4, this.v4, ip4n(mapped ? mapped[1]! : ip))
    return search(this.s6, this.e6, this.v6, ip6n(ip))
  }
}
// DB-IP files are sorted by start; the last start <= ip, then check its end
function search<N extends number | bigint, V>(s: N[], e: N[], v: V[], x: N): V | undefined {
  let lo = 0, hi = s.length - 1, at = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid]! <= x) { at = mid; lo = mid + 1 } else hi = mid - 1 }
  return at >= 0 && x <= e[at]! ? v[at] : undefined
}

// one CSV line: start,end,a[,"b, with commas"]
function cells(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i <= line.length && out.length < 4) {
    if (line[i] === '"') {
      let j = i + 1, s = ''
      for (;;) { const q = line.indexOf('"', j); if (q < 0) { s += line.slice(j); i = line.length + 1; break } s += line.slice(j, q); if (line[q + 1] === '"') { s += '"'; j = q + 2 } else { i = q + 2; break } }
      out.push(s)
    } else { const c = line.indexOf(',', i); const end = c < 0 ? line.length : c; out.push(line.slice(i, end)); i = end + 1 }
  }
  return out
}

export const ipdb = { country: new RangeTable<string>(), asn: new RangeTable<number>(), orgs: new Map<number, string>(), loadedAt: undefined as string | undefined, dir: undefined as string | undefined }
export function parseCountry(csv: string): RangeTable<string> {
  const t = new RangeTable<string>()
  for (const line of csv.split('\n')) { const [a, b, c] = cells(line.trim()); if (a && b && c && c !== 'ZZ') t.add(a, b, c.toUpperCase()) }
  return t
}
export function parseAsn(csv: string, orgs: Map<number, string>): RangeTable<number> {
  const t = new RangeTable<number>()
  for (const line of csv.split('\n')) {
    const [a, b, n, org] = cells(line.trim())
    const asn = Number(n)
    if (!a || !b || !Number.isInteger(asn) || asn <= 0) continue
    t.add(a, b, asn)
    if (org && !orgs.has(asn)) orgs.set(asn, org)
  }
  return t
}
const gun = promisify(gunzip)
// loads whatever of the two files exists in dir (gz or plain csv); a missing file leaves that table empty
export async function loadIpdb(dir: string): Promise<{ country: number; asn: number }> {
  const read = async (f: string) => { try { const b = await readFile(join(dir, f)); return (f.endsWith('.gz') ? await gun(b) : b).toString('utf8') } catch { return undefined } }
  const c = (await read(COUNTRY_FILE)) ?? (await read(COUNTRY_FILE.replace(/\.gz$/, '')))
  const a = (await read(ASN_FILE)) ?? (await read(ASN_FILE.replace(/\.gz$/, '')))
  const orgs = new Map<number, string>()
  if (c !== undefined) ipdb.country = parseCountry(c)
  if (a !== undefined) { ipdb.asn = parseAsn(a, orgs); ipdb.orgs = orgs }
  ipdb.dir = dir
  ipdb.loadedAt = new Date().toISOString()
  return { country: ipdb.country.size, asn: ipdb.asn.size }
}
export function lookupIp(ip: string): { country?: string; continent?: string; asn?: number; asnOrg?: string } {
  const country = ipdb.country.find(ip), asn = ipdb.asn.find(ip), continent = country && continentOf(country)
  return { ...(country && { country }), ...(continent && { continent }), ...(asn !== undefined && { asn, asnOrg: ipdb.orgs.get(asn) }) }
}

// ---- continents: ISO-3166 alpha-2 → continent code (GeoNames' assignment: CY / RU EU, TR / CAUCASUS AS) ----------------
export const CONTINENTS: Record<string, string> = { AF: 'Africa', AN: 'Antarctica', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America' }
const BY_CONTINENT: Record<string, string> = {
  AF: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW',
  AN: 'AQ BV GS HM TF',
  AS: 'AE AF AM AZ BD BH BN BT CC CN GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
  EU: 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK',
  NA: 'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI',
  OC: 'AS AU CK CX FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
  SA: 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE',
}
const CONTINENT_OF = new Map(Object.entries(BY_CONTINENT).flatMap(([c, list]) => list.split(' ').map((k) => [k, c] as const)))
export const continentOf = (country: string): string | undefined => CONTINENT_OF.get(country.toUpperCase())

// ---- local traffic: loopback / private / link-local / ULA / CGNAT never have a country --------------------------------
const LOCAL = new BlockList()
for (const [a, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]] as const) LOCAL.addSubnet(a, bits, 'ipv4')
for (const [a, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) LOCAL.addSubnet(a, bits, 'ipv6')
export function isLocal(ip: string): boolean {
  const a = ip.replace(/^::ffff:(?=\d+\.)/i, ''), v = isIP(a)
  return !!v && LOCAL.check(a, v === 6 ? 'ipv6' : 'ipv4')
}
