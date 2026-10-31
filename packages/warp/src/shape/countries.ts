// ISO 3166-1 alpha-2 codes with their E.164 calling code (one string, parsed once). Names come from
// Intl.DisplayNames in the viewer's locale, so there is no name table to keep up to date. Shared by the ORM
// (field.country / field.address / field.phone validation) and Weft (country / phone / address widgets).
const RAW = 'AD376 AE971 AF93 AG1 AI1 AL355 AM374 AO244 AQ672 AR54 AS1 AT43 AU61 AW297 AX358 AZ994 BA387 BB1 BD880 BE32 BF226 BG359 ' +
  'BH973 BI257 BJ229 BL590 BM1 BN673 BO591 BQ599 BR55 BS1 BT975 BV47 BW267 BY375 BZ501 CA1 CC61 CD243 CF236 CG242 CH41 CI225 CK682 ' +
  'CL56 CM237 CN86 CO57 CR506 CU53 CV238 CW599 CX61 CY357 CZ420 DE49 DJ253 DK45 DM1 DO1 DZ213 EC593 EE372 EG20 EH212 ER291 ES34 ' +
  'ET251 FI358 FJ679 FK500 FM691 FO298 FR33 GA241 GB44 GD1 GE995 GF594 GG44 GH233 GI350 GL299 GM220 GN224 GP590 GQ240 GR30 GS500 ' +
  'GT502 GU1 GW245 GY592 HK852 HM672 HN504 HR385 HT509 HU36 ID62 IE353 IL972 IM44 IN91 IO246 IQ964 IR98 IS354 IT39 JE44 JM1 JO962 ' +
  'JP81 KE254 KG996 KH855 KI686 KM269 KN1 KP850 KR82 KW965 KY1 KZ7 LA856 LB961 LC1 LI423 LK94 LR231 LS266 LT370 LU352 LV371 LY218 ' +
  'MA212 MC377 MD373 ME382 MF590 MG261 MH692 MK389 ML223 MM95 MN976 MO853 MP1 MQ596 MR222 MS1 MT356 MU230 MV960 MW265 MX52 MY60 ' +
  'MZ258 NA264 NC687 NE227 NF672 NG234 NI505 NL31 NO47 NP977 NR674 NU683 NZ64 OM968 PA507 PE51 PF689 PG675 PH63 PK92 PL48 PM508 ' +
  'PN64 PR1 PS970 PT351 PW680 PY595 QA974 RE262 RO40 RS381 RU7 RW250 SA966 SB677 SC248 SD249 SE46 SG65 SH290 SI386 SJ47 SK421 ' +
  'SL232 SM378 SN221 SO252 SR597 SS211 ST239 SV503 SX1 SY963 SZ268 TC1 TD235 TF262 TG228 TH66 TJ992 TK690 TL670 TM993 TN216 TO676 ' +
  'TR90 TT1 TV688 TW886 TZ255 UA380 UG256 UM1 US1 UY598 UZ998 VA39 VC1 VE58 VG1 VI1 VN84 VU678 WF681 WS685 YE967 YT262 ZA27 ZM260 ZW263'

export const COUNTRY_DIAL: ReadonlyMap<string, string> = new Map(RAW.split(' ').map((s) => [s.slice(0, 2), s.slice(2)]))
export const COUNTRY_CODES: readonly string[] = [...COUNTRY_DIAL.keys()]
export const isCountry = (c: unknown): c is string => typeof c === 'string' && COUNTRY_DIAL.has(c)

let names: Intl.DisplayNames | undefined
export function countryName(code: string, locale?: string): string {
  try { names = locale ? new Intl.DisplayNames([locale], { type: 'region' }) : names ?? new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return code }
  return names.of(code) ?? code
}

// E.164: '+' then 7–15 digits, no leading 0. `normalizePhone('0300 123 4567', 'PK')` → '+923001234567'.
export const E164 = /^\+[1-9]\d{6,14}$/
export function normalizePhone(raw: string, country?: string): string {
  let s = String(raw ?? '').trim().replace(/[\s().\- ]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  if (!s.startsWith('+') && s && country && COUNTRY_DIAL.has(country)) s = `+${COUNTRY_DIAL.get(country)}${s.replace(/^0+/, '')}`
  return s
}

// IPv4 dotted quad / IPv6 (incl. :: and an embedded v4 tail). Shared by field.ip and the ip widget.
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
export function isIp(s: unknown, version?: 4 | 6): boolean {
  if (typeof s !== 'string') return false
  if (version !== 6 && V4.test(s)) return true
  if (version === 4 || !s.includes(':') || s.length > 45) return false
  const [head, tail, ...more] = s.split('::')
  if (more.length) return false
  const parts = (x?: string) => (x ? x.split(':') : [])
  const h = parts(head), t = parts(tail)
  const last = (tail === undefined ? h : t).at(-1)
  const v4tail = !!last && last.includes('.')
  if (v4tail && !V4.test(last!)) return false
  const groups = [...h, ...t].filter((g, i, a) => !(v4tail && i === a.length - 1))
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false
  const n = groups.length + (v4tail ? 2 : 0)
  return tail === undefined ? n === 8 : n < 8
}
