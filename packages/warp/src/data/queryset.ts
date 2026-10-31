// QuerySet: internal chain API over a DataSource. Devs reach it only as Model.objects.
// Spec: docs/design/conventions/orm-queryset.md
import { DomainError } from '../core/errors.js'
import { Expression, OrderBy, PrefetchNode, QNode, toQ, type Lookups } from './expressions.js'
import type { ForUpdate } from './sql/ast.js'
import type { ModelDef } from './fields/index.js'

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'
export type Where = { field: string; op: Op; value: unknown; not?: boolean }  // not: negated (exclude)
export type Order = { field: string; dir: 'asc' | 'desc'; nulls?: 'first' | 'last' }   // nulls absent: nulls sort smallest

export interface QuerySpec {
  where: Where[]
  order?: Order[]
  cursor?: string                  // opaque: base64url JSON of the last item's order-key values
  limit: number
  search?: { fields: string[]; term: string }
  // ---- advanced (engine sources only; orm-advanced.md) ----
  q?: QNode[]                      // Q filters, ANDed (a filter on an aggregate goes to HAVING)
  annotate?: [string, Expression][]
  values?: string[]                // values mode: output names ([] = every field + annotation)
  distinct?: true | string[]       // string[] = DISTINCT ON (postgres)
  related?: string[]               // selectRelated paths
  forUpdate?: ForUpdate
  count?: false                    // the caller does not need `total`
}

// spec features only an engine source understands
export const isAdvanced = (s: QuerySpec) =>
  !!(s.q?.length || s.annotate?.length || s.values || s.distinct || s.related?.length || s.forUpdate || s.order?.some(o => o.nulls))

export interface DataSource<T> {
  query(spec: QuerySpec): Promise<{ items: T[]; total?: number }>
  get(id: string | number): Promise<T | undefined>
  // Push-down writes (engine sources only); resolve to the number of rows touched.
  update?(where: Where[], patch: Record<string, unknown>, q?: QNode[]): Promise<number>
  delete?(where: Where[], q?: QNode[]): Promise<number>
  def?: ModelDef                   // engine sources: the model (subqueries, Meta.ordering)
  ext?: EngineExt                  // engine sources: the advanced API (orm-advanced.md §3)
}

// a hidden per-row property: the raw order-key values of a row whose order keys are not plain fields
export const CURSOR = Symbol('tvine.cursor')

export interface Paginated<T> {
  items: T[]; total?: number; pageSize: number; nextCursor?: string
}

const DEFAULT_PAGE = 25
const MAX_PAGE = 100

// JSON turns Date into a string and throws on bigint, so both are tagged on the wire.
function toWire(v: unknown): unknown {
  if (v instanceof Date) return { $date: v.getTime() }
  if (typeof v === 'bigint') return { $bigint: v.toString() }
  return v
}

function fromWire(v: unknown): unknown {
  if (v && typeof v === 'object' && '$date' in v) return new Date((v as { $date: number }).$date)
  if (v && typeof v === 'object' && '$bigint' in v) return BigInt((v as { $bigint: string }).$bigint)
  return v
}

// Cursor codec, shared with adapters. Values of the order keys (id is always last).
export function encodeCursor(order: Order[], item: object): string {
  const row = item as Record<string, unknown>
  return Buffer.from(JSON.stringify(order.map(o => toWire(row[o.field])))).toString('base64url')
}

export function decodeCursor(cursor: string): unknown[] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(v)) return v.map(fromWire)
  } catch { /* fall through */ }
  throw new DomainError('invalid_param', 'invalid cursor', 'cursor')
}

// Everything that needs the database engine (aggregates, bulk writes, prefetch, …). model.ts builds it.
export interface EngineExt {
  aggregate(spec: QuerySpec, aggs: [string, Expression][]): Promise<Record<string, unknown>>
  exists(spec: QuerySpec): Promise<boolean>
  prefetch(items: object[], lookups: (string | PrefetchNode)[]): Promise<void>
  atomic<R>(fn: () => Promise<R>): Promise<R>
  prepare(data: Record<string, unknown>): Record<string, unknown>          // validated create row (defaults filled)
  insert(row: Record<string, unknown>, ignoreConflicts?: boolean): Promise<any>
  insertMany(rows: Record<string, unknown>[], batchSize?: number): Promise<any[]>
  bulkUpdate(rows: Record<string, unknown>[], fields: string[], batchSize?: number): Promise<number>
}

interface State {
  where: Where[]; order: Order[]; ordered?: boolean; search?: QuerySpec['search']
  q?: QNode[]; annotate?: [string, Expression][]; values?: string[]; list?: 'tuple' | 'flat'
  distinct?: true | string[]; related?: string[]; prefetch?: (string | PrefetchNode)[]; forUpdate?: QuerySpec['forUpdate']
}

export const MAX_IN = 1000          // every value is a bound param; engines cap params per statement

function toWhere(w: Partial<Record<string, unknown>> | Where[]): Where[] {
  if (!Array.isArray(w)) return Object.entries(w).map(([field, value]) => ({ field, op: 'eq', value }))
  for (const c of w) {
    if (c.op === 'in' && Array.isArray(c.value) && c.value.length > MAX_IN) {
      throw new DomainError('invalid_param', `too many values in IN filter (max ${MAX_IN})`, c.field)
    }
  }
  return w
}

const SIMPLE_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'])
// a lookup object → flat Where (plain `field` / `field__op`) and Q leaves (relation paths, expressions,
// other lookups). Flat Where keeps the memory source and the exact SQL of plain filters.
function split(obj: Lookups, def?: ModelDef): { where: Where[]; q?: QNode } {
  const where: Where[] = [], rest: [string, unknown][] = []
  // a name that is not a column (a reverse relation / m2m accessor) is a Q leaf
  const plain = (n: string) => !def || Object.entries(def.fields).some(([x, f]) => f.kind !== 'm2m' && (x === n || f.key(x) === n))
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('__')
    if (v instanceof Expression || (parts.length <= 2 && !plain(parts[0]))) rest.push([k, v])
    else if (parts.length === 1) where.push({ field: k, op: 'eq', value: v })
    else if (parts.length === 2 && SIMPLE_OPS.has(parts[1])) where.push(...toWhere([{ field: parts[0], op: parts[1] as Op, value: v }]))
    else if (parts.length === 2 && parts[1] === 'isnull') where.push({ field: parts[0], op: v ? 'eq' : 'ne', value: null })
    else rest.push([k, v])
  }
  return { where, q: rest.length ? new QNode('and', rest) : undefined }
}

function clampSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_PAGE
  return Math.min(Math.max(Math.floor(size), 1), MAX_PAGE)
}

const parseOrder = (f: string | OrderBy): Order => {
  if (f instanceof OrderBy) {
    if (f.e.kind !== 'F') throw new Error('order() takes field / annotation names or F(name).asc()/.desc(); annotate an expression first')
    return { field: (f.e as unknown as { name: string }).name, dir: f.dir, ...(f.nulls ? { nulls: f.nulls } : {}) }
  }
  return f.startsWith('-') ? { field: f.slice(1), dir: 'desc' } : { field: f, dir: 'asc' }
}

export class QuerySet<T extends object> {
  constructor(
    private readonly source: DataSource<T>,
    private readonly state: State = { where: [], order: [] },
    private readonly defaultSearch: string[] = [],   // a model's `searchable` fields
  ) {}

  private with(patch: Partial<State>): QuerySet<any> {
    return new QuerySet(this.source, { ...this.state, ...patch }, this.defaultSearch)
  }
  private ext(what: string): EngineExt {
    if (!this.source.ext) throw new Error(`${what}() needs a database-backed model`)
    return this.source.ext
  }
  private get pk(): string { return this.source.def ? Object.entries(this.source.def.fields).find(([n]) => n === 'id')?.[0] ?? 'id' : 'id' }

  // filter({ a: 1, price__gt: 5, vendor__name: 'x' }) / filter(Q(...)) / filter(Exists(...)) / filter(Where[])
  filter(where: Partial<Record<keyof T & string, unknown>> | Lookups | Where[] | QNode | Expression): QuerySet<T> {
    if (where instanceof QNode || where instanceof Expression) return this.with({ q: [...(this.state.q ?? []), toQ(where)] })
    if (Array.isArray(where)) return this.with({ where: [...this.state.where, ...toWhere(where)] })
    const { where: ws, q } = split(where as Lookups, this.source.def)
    return this.with({ where: [...this.state.where, ...ws], ...(q ? { q: [...(this.state.q ?? []), q] } : {}) })
  }

  // One condition per plain-object call: NOT(a) AND NOT(b) differs from Django's NOT(a AND b). Chain
  // instead, or pass Q(...) — exclude(Q) is NOT(the whole Q), Django's semantics.
  exclude(where: Partial<Record<keyof T & string, unknown>> | Lookups | Where[] | QNode | Expression): QuerySet<T> {
    if (where instanceof QNode || where instanceof Expression) return this.with({ q: [...(this.state.q ?? []), toQ(where).not()] })
    if (!Array.isArray(where)) {
      const keys = Object.keys(where)
      if (keys.length > 1) throw new Error('exclude() takes one condition; use chained .exclude() calls or exclude(Q({...}))')
      const { where: ws, q } = split(where as Lookups, this.source.def)
      if (q) return this.with({ q: [...(this.state.q ?? []), q.not()] })
      return this.with({ where: [...this.state.where, ...ws.map(w => ({ ...w, not: true }))] })
    }
    const ws = toWhere(where)
    if (ws.length > 1) throw new Error('exclude() takes one condition; use chained .exclude() calls')
    return this.with({ where: [...this.state.where, ...ws.map(w => ({ ...w, not: true }))] })
  }

  // Replaces the previous order (Django order_by). 'field' asc, '-field' desc, F('f').desc({ nulls: 'last' }).
  order(...fields: (string | OrderBy)[]): QuerySet<T> {
    return this.with({ order: fields.map(parseOrder), ordered: true })
  }

  search(term: string, fields?: (keyof T & string)[]): QuerySet<T> {
    const f = fields ?? this.defaultSearch
    if (!f.length) throw new Error('search() needs fields: pass them, or mark model fields searchable')
    return this.with({ search: { fields: f, term } })
  }

  // ---- advanced chain (orm-advanced.md) --------------------------------------------------------------
  annotate<A extends Record<string, Expression>>(a: A): QuerySet<T & { [K in keyof A]: any }> {
    const add = Object.entries(a)
    const names = new Set((this.state.annotate ?? []).map(([n]) => n))
    for (const [n] of add) if (names.has(n)) throw new DomainError('invalid_param', `annotation "${n}" is already defined`, n)
    return this.with({
      annotate: [...(this.state.annotate ?? []), ...add],
      ...(this.state.values ? { values: [...this.state.values, ...add.map(([n]) => n)] } : {}),   // Django: annotations after values() are output too
    })
  }
  having(q: QNode | Lookups): QuerySet<T> { return this.with({ q: [...(this.state.q ?? []), toQ(q)] }) }
  values(...names: string[]): QuerySet<Record<string, any>> { return this.with({ values: names, list: undefined }) }
  valuesList(...args: (string | { flat?: boolean })[]): QuerySet<any> {
    const names = args.filter((a): a is string => typeof a === 'string')
    const flat = args.some(a => typeof a === 'object' && a.flat)
    if (flat && names.length !== 1) throw new Error('valuesList(..., { flat: true }) takes exactly one field')
    return this.with({ values: names, list: flat ? 'flat' : 'tuple' })
  }
  distinct(...fields: string[]): QuerySet<T> { return this.with({ distinct: fields.length ? fields : true }) }
  selectRelated(...paths: string[]): QuerySet<T> { return this.with({ related: [...(this.state.related ?? []), ...paths] }) }
  prefetchRelated(...lookups: (string | PrefetchNode)[]): QuerySet<T> { return this.with({ prefetch: [...(this.state.prefetch ?? []), ...lookups] }) }
  selectForUpdate(opts: { nowait?: boolean; skipLocked?: boolean; of?: string[] } = {}): QuerySet<T> {
    if (opts.nowait && opts.skipLocked) throw new Error('selectForUpdate: nowait and skipLocked are exclusive')
    return this.with({ forUpdate: opts })
  }

  // Ties are broken by id so the cursor is always unique (model rows; values rows keep the given order).
  private spec(limit: number, cursor?: string): QuerySpec & { order: Order[] } {
    const st = this.state
    const meta = this.source.def?.meta?.ordering
    const base = st.ordered || !meta ? st.order : meta.map(f => parseOrder(f))
    const order = st.values || base.some(o => o.field === this.pk) ? base : [...base, { field: this.pk, dir: 'asc' as const }]
    return {
      where: st.where, order, search: st.search, limit, cursor,
      ...(st.q?.length ? { q: st.q } : {}), ...(st.annotate?.length ? { annotate: st.annotate } : {}),
      ...(st.values ? { values: st.values } : {}), ...(st.distinct ? { distinct: st.distinct } : {}),
      ...(st.related?.length ? { related: st.related } : {}), ...(st.forUpdate ? { forUpdate: st.forUpdate } : {}),
    }
  }

  // a subquery source (Subquery / Exists / __in)
  __query(): { def: ModelDef; spec: QuerySpec } {
    if (!this.source.def) throw new Error('a subquery needs a database-backed model')
    return { def: this.source.def, spec: this.spec(0) }
  }

  private shape(items: any[]): any[] {
    if (!this.state.values || !this.state.list) return items
    if (this.state.list === 'flat') return items.map(r => Object.values(r)[0])
    return items.map(r => Object.values(r))
  }

  async page(opts: { cursor?: string; size?: number } = {}, count = true): Promise<Paginated<T>> {
    if (this.state.values) throw new Error('values() querysets are not paginated: use all() / first()')
    const size = clampSize(opts.size)
    const spec = this.spec(size + 1, opts.cursor)       // one extra row tells us if a next page exists
    const { items, total } = await this.source.query(count || !this.source.ext ? spec : { ...spec, count: false })
    const pageItems = items.slice(0, size)
    if (this.state.prefetch?.length) await this.ext('prefetchRelated').prefetch(pageItems, this.state.prefetch)
    const last = pageItems[size - 1] as Record<symbol, unknown[]> | undefined
    const nextCursor = items.length > size
      ? (last?.[CURSOR] ? Buffer.from(JSON.stringify(last[CURSOR].map(toWire))).toString('base64url') : encodeCursor(spec.order, pageItems[size - 1]))
      : undefined
    return { items: pageItems, ...(count ? { total } : {}), pageSize: size, nextCursor }
  }

  async all(limit = Infinity): Promise<T[]> {
    if (this.state.values) {
      const { items } = await this.source.query({ ...this.spec(limit), count: false })
      return this.shape(items)
    }
    const out: T[] = []
    let cursor: string | undefined
    do {
      const p = await this.page({ cursor, size: MAX_PAGE }, false)
      out.push(...p.items)
      cursor = p.nextCursor
    } while (cursor && out.length < limit)
    return out.slice(0, limit)
  }
  // every row in ONE query (prefetch / inBulk): no cursor loop
  async fetchAll(): Promise<T[]> {
    const { items } = await this.source.query({ ...this.spec(Infinity), count: false })
    if (this.state.prefetch?.length && !this.state.values) await this.ext('prefetchRelated').prefetch(items, this.state.prefetch)
    return this.shape(items)
  }

  async update(patch: Partial<Record<keyof T & string, unknown>> | Record<string, unknown>): Promise<number> {
    if (!this.source.update) throw new Error('this data source is read-only')
    return this.source.update(this.state.where, patch, this.state.q)
  }

  async delete(): Promise<number> {
    if (!this.source.delete) throw new Error('this data source is read-only')
    return this.source.delete(this.state.where, this.state.q)
  }

  async first(): Promise<T | undefined> {
    if (this.state.values) return (await this.all(1))[0]
    return (await this.page({ size: 1 }, false)).items[0]
  }

  // the last row under the current order (Django last(): the order reversed, id tiebreak included)
  async last(): Promise<T | undefined> {
    const order = this.spec(0).order
    const rev = (order.length ? order : [{ field: this.pk, dir: 'asc' as const }])
      .map(o => ({ field: o.field, dir: o.dir === 'asc' ? 'desc' as const : 'asc' as const, ...(o.nulls ? { nulls: o.nulls === 'first' ? 'last' as const : 'first' as const } : {}) }))
    return this.with({ order: rev, ordered: true }).first()
  }

  async count(): Promise<number> {
    const { total } = await this.source.query({ ...this.spec(0), limit: 0 })
    return total ?? (await this.all()).length
  }

  async exists(): Promise<boolean> {
    if (!this.source.ext) return (await this.count()) > 0
    return this.source.ext.exists(this.spec(1))
  }

  // aggregate({ total: Sum('price'), n: Count('id') }) → { total, n }
  async aggregate<A extends Record<string, Expression>>(aggs: A): Promise<{ [K in keyof A]: any }> {
    return this.ext('aggregate').aggregate({ ...this.spec(0), order: [] }, Object.entries(aggs)) as Promise<{ [K in keyof A]: any }>
  }

  // { id: row } for the given ids (IN batched at MAX_IN)
  async inBulk(ids: (string | number)[], opts: { field?: string } = {}): Promise<Record<string, T>> {
    const field = opts.field ?? this.pk
    const out: Record<string, T> = {}
    for (let i = 0; i < ids.length; i += MAX_IN) {
      for (const r of await this.filter([{ field, op: 'in', value: ids.slice(i, i + MAX_IN) }]).fetchAll()) {
        out[String((r as Record<string, unknown>)[this.keyOf(field)])] = r
      }
    }
    return out
  }
  private keyOf(name: string): string {
    const f = this.source.def?.fields[name]
    return f ? f.key(name) : name
  }

  // lookup keys usable as create() data: plain fields (and `__exact`), by their row key (vendor → vendorId)
  private createData(lookup: Lookups): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(lookup)) {
      const name = k.endsWith('__exact') ? k.slice(0, -7) : k
      if (name.includes('__') || v instanceof Expression) continue
      out[this.keyOf(name)] = v
    }
    return out
  }

  // [row, created]. Race-safe: insert-or-nothing, then re-read (orm-advanced.md §3)
  async getOrCreate(lookup: Lookups, defaults: Record<string, unknown> = {}): Promise<[T, boolean]> {
    const ext = this.ext('getOrCreate')
    return ext.atomic(async () => {
      const hit = await this.filter(lookup).first()
      if (hit) return [hit, false] as [T, boolean]
      const made = await ext.insert(ext.prepare({ ...this.createData(lookup), ...defaults }), true)
      if (made) return [made as T, true] as [T, boolean]
      const again = await this.filter(lookup).first()
      if (again) return [again, false] as [T, boolean]
      throw new DomainError('domain', `${this.source.def!.name}: a conflicting row exists (unique field) but does not match the lookup`)
    })
  }

  // [row, created]: lock the match (selectForUpdate) and update it with defaults, or create
  async updateOrCreate(lookup: Lookups, defaults: Record<string, unknown> = {}): Promise<[T, boolean]> {
    const ext = this.ext('updateOrCreate')
    return ext.atomic(async () => {
      const hit = await this.filter(lookup).selectForUpdate().first() as Record<string, unknown> | undefined
      if (!hit) {
        const [row, created] = await this.getOrCreate(lookup, defaults)
        if (created) return [row, true] as [T, boolean]
        return [await this.refresh(row as Record<string, unknown>, defaults), false] as [T, boolean]
      }
      return [await this.refresh(hit, defaults), false] as [T, boolean]
    })
  }
  private async refresh(row: Record<string, unknown>, patch: Record<string, unknown>): Promise<T> {
    const id = row[this.pk] as string | number
    if (Object.keys(patch).length) await this.source.update!([{ field: this.pk, op: 'eq', value: id }], patch)
    return (await this.source.get(id))!
  }

  // multi-row INSERTs (≤1000 rows, ≤30 000 params each) in one atomic block
  async bulkCreate(rows: Record<string, unknown>[], opts: { batchSize?: number } = {}): Promise<T[]> {
    const ext = this.ext('bulkCreate')
    const prepared = rows.map(r => ext.prepare(r))
    // the same keys in every row: an optional field left out of one row is explicit NULL there
    const keys = new Set(prepared.flatMap(r => Object.keys(r)))
    const pk = this.pk
    const uniform = prepared.map(r => Object.fromEntries([...keys].filter(k => k !== pk || r[pk] !== undefined).map(k => [k, r[k] ?? null])))
    if (uniform.some(r => pk in r) && !uniform.every(r => pk in r)) throw new DomainError('invalid_param', 'bulkCreate: give the id for every row or for none')
    return ext.insertMany(uniform, opts.batchSize)
  }

  async bulkUpdate(rows: object[], fields: string[], opts: { batchSize?: number } = {}): Promise<number> {
    return this.ext('bulkUpdate').bulkUpdate(rows as Record<string, unknown>[], fields, opts.batchSize)
  }
}
