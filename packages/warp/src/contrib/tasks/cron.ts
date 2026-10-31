// 5-field cron (min hour dom month dow), UTC. `*`, `a-b`, `*/n`, `a-b/n`, `a/n`, lists, jan-dec / sun-sat
// names, 7 = Sunday, @yearly @annually @monthly @weekly @daily @midnight @hourly. dom and dow both restricted
// → a day matches either (Vixie cron).
export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const SPEC: [name: string, lo: number, hi: number, names?: string[], base?: number][] = [
  ['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12, MONTHS, 1], ['day of week', 0, 7, DAYS, 0],
]

export function parseCron(expr: string): Cron {
  const src = MACROS[expr.trim().toLowerCase()] ?? expr
  const parts = src.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron "${expr}": expected 5 fields (min hour dom month dow) or an @macro`)
  const sets = parts.map((p, i) => field(p, SPEC[i]!, expr))
  const dow = new Set([...sets[4]!].map((d) => (d === 7 ? 0 : d)))
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow, domStar: parts[2] === '*' || parts[2] === '?', dowStar: parts[4] === '*' || parts[4] === '?' }
}

function field(text: string, [name, lo, hi, names, base = 0]: (typeof SPEC)[number], expr: string): Set<number> {
  const bad = (why: string): never => { throw new Error(`cron "${expr}": ${name} "${text}" ${why}`) }
  const num = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1
    if (i >= 0) return i + base
    if (!/^\d+$/.test(s)) bad('is not a number')
    const n = Number(s)
    if (n < lo || n > hi) bad(`is out of range ${lo}-${hi}`)
    return n
  }
  const out = new Set<number>()
  for (const item of text.split(',')) {
    const [range, stepText, extra] = item.split('/')
    if (extra !== undefined || range === '') bad('is malformed')
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) && Number(stepText) > 0 ? Number(stepText) : bad('has a bad step')
    let a: number, b: number
    if (range === '*' || range === '?') [a, b] = [lo, name === 'day of week' ? 6 : hi]
    else if (range!.includes('-')) {
      const [x, y, z] = range!.split('-')
      if (z !== undefined) bad('is malformed')
      ;[a, b] = [num(x!), num(y!)]
      if (a > b) bad('has a reversed range')
    } else [a, b] = [num(range!), stepText === undefined ? num(range!) : hi]
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}

// The first fire time strictly after `after` (minute resolution, UTC). Jumps field by field: at most a few
// hundred steps even for sparse expressions; gives up after 5 years (e.g. 0 0 30 2 *).
export function nextFire(c: Cron | string, after: Date | number): Date {
  const cron = typeof c === 'string' ? parseCron(c) : c
  const t = new Date(typeof after === 'number' ? after : after.getTime())
  t.setUTCSeconds(0, 0)
  t.setUTCMinutes(t.getUTCMinutes() + 1)
  const limit = t.getTime() + 5 * 366 * 86_400_000
  const dayOk = (d: Date) => {
    const dom = cron.dom.has(d.getUTCDate()), dow = cron.dow.has(d.getUTCDay())
    if (cron.domStar && cron.dowStar) return true
    if (cron.domStar) return dow
    if (cron.dowStar) return dom
    return dom || dow
  }
  while (t.getTime() <= limit) {
    if (!cron.month.has(t.getUTCMonth() + 1)) { t.setUTCMonth(t.getUTCMonth() + 1, 1); t.setUTCHours(0, 0); continue }
    if (!dayOk(t)) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(0, 0); continue }
    if (!cron.hour.has(t.getUTCHours())) { t.setUTCHours(t.getUTCHours() + 1, 0); continue }
    if (!cron.minute.has(t.getUTCMinutes())) { t.setUTCMinutes(t.getUTCMinutes() + 1); continue }
    return t
  }
  throw new Error('cron: no fire time within 5 years')
}
