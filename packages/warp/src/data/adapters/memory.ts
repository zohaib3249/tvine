// In-process DataSource over an array. Used for demo and tests; the array is read live,
// so later pushes are visible to subsequent queries.
import { DomainError } from '../../core/errors.js'
import { decodeCursor, type DataSource, type Op, type Order, type QuerySpec, type Where } from '../queryset.js'

type Row = Record<string, unknown>

// money ({value, currency}) answers like the SQL field: an object compares amount AND currency, a bare
// number the amount; gt/lt use the amount
type Money = { value: number; currency: string }
const isMoney = (v: unknown): v is Money => typeof v === 'object' && v !== null && 'value' in v && 'currency' in v
const amt = (v: unknown) => (isMoney(v) ? v.value : v)
const same = (a: unknown, b: unknown) =>
  isMoney(a) && isMoney(b) ? a.value === b.value && a.currency === b.currency : amt(a) === amt(b)

// the money field's own refusal (data/fields/money.ts): an object filter value needs its currency
const checkMoneyFilter = (b: unknown) => {
  for (const x of Array.isArray(b) ? b : [b]) {
    if (typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as { currency?: unknown }).currency !== 'string') {
      throw new DomainError('invalid_param', 'a money filter object needs a currency (or pass a bare amount)')
    }
  }
}

function test(a: unknown, op: Op, b: unknown): boolean {
  if (isMoney(a)) checkMoneyFilter(b)
  switch (op) {
    case 'eq': return same(a, b)
    case 'ne': return !same(a, b)
    case 'gt': return (amt(a) as number) > (amt(b) as number)
    case 'gte': return (amt(a) as number) >= (amt(b) as number)
    case 'lt': return (amt(a) as number) < (amt(b) as number)
    case 'lte': return (amt(a) as number) <= (amt(b) as number)
    case 'in': return Array.isArray(b) && b.some(x => same(a, x))
    case 'contains': return typeof a === 'string' && a.toLowerCase().includes(String(b).toLowerCase())
  }
}

function matchWhere(row: Row, w: Where): boolean {
  const ok = test(row[w.field], w.op, w.value)
  return w.not ? !ok : ok
}

// Total order: nullish first, Dates by time. Anything else that is not comparable stays 0.
// ponytail: no per-type collation; strings compare by UTF-16 code unit.
function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  const xn = x == null
  const yn = y == null
  if (xn || yn) return xn === yn ? 0 : xn ? -1 : 1
  const p = x as number | bigint | string
  const q = y as number | bigint | string
  return p < q ? -1 : p > q ? 1 : 0
}

function cmpKeys(av: unknown[], bv: unknown[], order: Order[]): number {
  for (let i = 0; i < order.length; i++) {
    const c = cmp(av[i], bv[i])
    if (c) return order[i].dir === 'desc' ? -c : c
  }
  return 0
}

const keys = (row: Row, order: Order[]) => order.map(o => row[o.field])

export function memorySource<T extends { id: string | number }>(items: T[]): DataSource<T> {
  return {
    async query(spec: QuerySpec) {
      const term = spec.search?.term.toLowerCase()
      const fields = spec.search?.fields ?? []
      let rows = items.filter(item => {
        const row = item as unknown as Row
        if (!spec.where.every(w => matchWhere(row, w))) return false
        return !term || fields.some(f => String(row[f] ?? '').toLowerCase().includes(term))
      }) as unknown as Row[]
      const total = rows.length                           // matches before cursor/limit
      const order = spec.order ?? []
      rows.sort((x, y) => cmpKeys(keys(x, order), keys(y, order), order))
      if (spec.cursor) {
        const cv = decodeCursor(spec.cursor)
        if (cv.length !== order.length) throw new DomainError('invalid_param', 'invalid cursor', 'cursor')
        rows = rows.filter(r => cmpKeys(keys(r, order), cv, order) > 0)
      }
      return { items: rows.slice(0, spec.limit) as unknown as T[], total }
    },
    async get(id) {
      return items.find(x => x.id === id)
    },
  }
}
