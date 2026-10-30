// QuerySet: internal chain API over a DataSource. Devs reach it only as Model.objects.
// Spec: docs/design/conventions/orm-queryset.md

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'
export type Where = { field: string; op: Op; value: unknown; not?: boolean }  // not: negated (exclude)
export type Order = { field: string; dir: 'asc' | 'desc' }

export interface QuerySpec {
  where: Where[]
  order?: Order[]
  cursor?: string                  // opaque: base64url JSON of the last item's order-key values
  limit: number
  search?: { fields: string[]; term: string }
}

export interface DataSource<T> {
  query(spec: QuerySpec): Promise<{ items: T[]; total?: number }>
  get(id: string | number): Promise<T | undefined>
}

export interface Paginated<T> {
  items: T[]; total?: number; pageSize: number; nextCursor?: string
}

const DEFAULT_PAGE = 25
const MAX_PAGE = 100

// Cursor codec, shared with adapters. Values of the order keys (id is always last).
export function encodeCursor(order: Order[], item: object): string {
  const row = item as Record<string, unknown>
  return Buffer.from(JSON.stringify(order.map(o => row[o.field]))).toString('base64url')
}

export function decodeCursor(cursor: string): unknown[] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(v)) return v
  } catch { /* fall through */ }
  throw new Error('invalid cursor')
}

interface State { where: Where[]; order: Order[]; search?: QuerySpec['search'] }

function toWhere(w: Partial<Record<string, unknown>> | Where[]): Where[] {
  if (Array.isArray(w)) return w
  return Object.entries(w).map(([field, value]) => ({ field, op: 'eq', value }))
}

function clampSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_PAGE
  return Math.min(Math.max(Math.floor(size), 1), MAX_PAGE)
}

export class QuerySet<T extends object> {
  constructor(
    private readonly source: DataSource<T>,
    private readonly state: State = { where: [], order: [] },
  ) {}

  private with(patch: Partial<State>): QuerySet<T> {
    return new QuerySet(this.source, { ...this.state, ...patch })
  }

  filter(where: Partial<Record<keyof T & string, unknown>> | Where[]): QuerySet<T> {
    return this.with({ where: [...this.state.where, ...toWhere(where)] })
  }

  exclude(where: Partial<Record<keyof T & string, unknown>> | Where[]): QuerySet<T> {
    return this.with({ where: [...this.state.where, ...toWhere(where).map(w => ({ ...w, not: true }))] })
  }

  // Replaces the previous order (Django order_by). 'field' asc, '-field' desc.
  order(...fields: string[]): QuerySet<T> {
    return this.with({
      order: fields.map(f => (f.startsWith('-')
        ? { field: f.slice(1), dir: 'desc' as const }
        : { field: f, dir: 'asc' as const })),
    })
  }

  search(term: string, fields: (keyof T & string)[]): QuerySet<T> {
    return this.with({ search: { fields, term } })
  }

  // Ties are broken by id so the cursor is always unique.
  private spec(limit: number, cursor?: string): QuerySpec & { order: Order[] } {
    const order = this.state.order.some(o => o.field === 'id')
      ? this.state.order
      : [...this.state.order, { field: 'id', dir: 'asc' as const }]
    return { where: this.state.where, order, search: this.state.search, limit, cursor }
  }

  async page(opts: { cursor?: string; size?: number } = {}): Promise<Paginated<T>> {
    const size = clampSize(opts.size)
    const spec = this.spec(size + 1, opts.cursor)       // one extra row tells us if a next page exists
    const { items, total } = await this.source.query(spec)
    const pageItems = items.slice(0, size)
    const nextCursor = items.length > size ? encodeCursor(spec.order, pageItems[size - 1]) : undefined
    return { items: pageItems, total, pageSize: size, nextCursor }
  }

  async all(limit = Infinity): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    do {
      const p = await this.page({ cursor, size: MAX_PAGE })
      out.push(...p.items)
      cursor = p.nextCursor
    } while (cursor && out.length < limit)
    return out.slice(0, limit)
  }

  async first(): Promise<T | undefined> {
    return (await this.page({ size: 1 })).items[0]
  }

  async count(): Promise<number> {
    const { total } = await this.source.query({ ...this.spec(0), limit: 0 })
    return total ?? (await this.all()).length
  }
}
