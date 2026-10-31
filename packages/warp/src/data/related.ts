// Relations at run time: prefetchRelated (one extra query per hop, IN batched at MAX_IN — no N+1) and
// the m2m / reverse-fk managers behind Model.related(). orm-advanced.md §3–4.
import { DomainError } from '../core/errors.js'
import { engineSource, insertMany } from './engine.js'
import { PrefetchNode, Subquery } from './expressions.js'
import type { ModelDef } from './fields/index.js'
import type { Model } from './model.js'
import { MAX_IN, QuerySet } from './queryset.js'
import { modelNamed, pkCol, relationOf, type Relation } from './registry.js'

type Row = Record<string, unknown>
const objectsOf = (def: ModelDef): QuerySet<any> =>
  modelNamed<Model<any, any>>(def.name)?.objects ?? new QuerySet<any>(engineSource(def))
const chunks = <X>(xs: X[]) => Array.from({ length: Math.ceil(xs.length / MAX_IN) }, (_, i) => xs.slice(i * MAX_IN, (i + 1) * MAX_IN))
const uniq = <X>(xs: X[]) => [...new Set(xs)]

function rel(def: ModelDef, name: string, path: string): Relation {
  const r = relationOf(def, name)
  if (!r) throw new DomainError('invalid_param', `prefetchRelated("${path}"): "${name}" is not a relation on ${def.name}`, path)
  return r
}

export async function prefetch(def: ModelDef, items: object[], lookups: (string | PrefetchNode)[]): Promise<void> {
  for (const l of lookups) {
    const path = typeof l === 'string' ? l : l.path
    await hop(def, items as Row[], path.split('__'), path, typeof l === 'string' ? undefined : l.queryset as QuerySet<any> | undefined)
  }
}

async function hop(def: ModelDef, items: Row[], parts: string[], path: string, qs?: QuerySet<any>): Promise<void> {
  if (!items.length) return
  const [head, ...rest] = parts
  const r = rel(def, head, path)
  const base = (!rest.length && qs) || objectsOf(r.target)
  const tpk = pkCol(r.target), spk = pkCol(def)
  const fetch = async (field: string, ids: unknown[]) => {
    const out: Row[] = []
    for (const c of chunks(uniq(ids))) out.push(...await base.filter([{ field, op: 'in', value: c }]).fetchAll())
    return out
  }
  let next: Row[]
  if (r.kind === 'fk') {
    const key = r.field.key(head)
    const got = await fetch(tpk, items.map(i => i[key]).filter(v => v != null))
    const by = new Map(got.map(g => [g[tpk], g]))
    for (const i of items) i[head] = i[key] == null ? null : by.get(i[key]) ?? null
    next = got
  } else if (r.kind === 'reverse') {
    const key = r.source.fields[r.field].key(r.field)
    const got = await fetch(r.field, items.map(i => i[spk]))
    const by = new Map<unknown, Row[]>()
    for (const g of got) by.set(g[key], [...(by.get(g[key]) ?? []), g])
    for (const i of items) i[head] = by.get(i[spk]) ?? []
    next = got
  } else {
    // through pairs, then the targets: two queries per batch
    const t = r.through
    const sk = t.def.fields[t.src].key(t.src), dk = t.def.fields[t.dst].key(t.dst)
    const pairs: Row[] = []
    for (const c of chunks(uniq(items.map(i => i[spk])))) {
      pairs.push(...await objectsOf(t.def).filter([{ field: t.src, op: 'in', value: c }]).values(sk, dk).fetchAll())
    }
    const got = await fetch(tpk, pairs.map(p => p[dk]))
    const by = new Map(got.map(g => [g[tpk], g]))
    const lists = new Map<unknown, Row[]>()
    for (const p of pairs) { const g = by.get(p[dk]); if (g) lists.set(p[sk], [...(lists.get(p[sk]) ?? []), g]) }
    for (const i of items) i[head] = lists.get(i[spk]) ?? []
    next = got
  }
  if (rest.length) await hop(r.target, next, rest, path, qs)
}

// Model.related('tags', id) / Model.related('product_set', id)
export interface RelatedManager<T extends object = any> {
  all(): QuerySet<T>
  add(...items: (string | number | object)[]): Promise<void>
  remove(...items: (string | number | object)[]): Promise<void>
  set(items: (string | number | object)[]): Promise<void>
  clear(): Promise<void>
}

export function related(def: ModelDef, name: string, id: string | number, atomic: <R>(fn: () => Promise<R>) => Promise<R>): RelatedManager {
  const r = relationOf(def, name)
  if (!r || r.kind === 'fk') throw new DomainError('invalid_param', `${def.name}.related("${name}"): not a many-to-many or reverse relation (an fk is read with get())`, name)
  const tpk = pkCol(r.target)
  const idOf = (x: string | number | object) => (typeof x === 'object' ? (x as Row)[tpk] as string | number : x)
  if (r.kind === 'reverse') {
    const refuse = async () => { throw new DomainError('invalid_param', `${def.name}.related("${name}"): set ${r.source.name}.${r.field} on the rows instead`) }
    return { all: () => objectsOf(r.source).filter({ [r.field]: id }), add: refuse, remove: refuse, set: refuse, clear: refuse }
  }
  const t = r.through
  const through = objectsOf(t.def)
  const sk = t.def.fields[t.src].key(t.src), dk = t.def.fields[t.dst].key(t.dst)
  const writable = () => {
    if (!t.auto) throw new DomainError('invalid_param', `${def.name}.${name} uses a custom through model (${t.def.name}): create / delete ${t.def.name} rows instead`)
  }
  const mine = () => through.filter({ [t.src]: id })
  const add = async (ids: (string | number)[]) => {
    for (const c of chunks(uniq(ids))) {
      const have = new Set(await mine().filter([{ field: t.dst, op: 'in', value: c }]).valuesList(dk, { flat: true }).fetchAll())
      const missing = c.filter(x => !have.has(x))
      if (missing.length) await insertMany(t.def, missing.map(x => ({ [sk]: id, [dk]: x })))
    }
  }
  const remove = async (ids: (string | number)[]) => {
    for (const c of chunks(uniq(ids))) await mine().filter([{ field: t.dst, op: 'in', value: c }]).delete()
  }
  return {
    all: () => objectsOf(r.target).filter({ [`${tpk}__in`]: Subquery(mine().values(t.dst)) }),
    add: (...items) => { writable(); return atomic(() => add(items.map(idOf))) },
    remove: (...items) => { writable(); return atomic(() => remove(items.map(idOf))) },
    clear: async () => { writable(); await mine().delete() },
    set: items => {
      writable()
      return atomic(async () => {
        const want = new Set(items.map(idOf))
        const have = await mine().valuesList(dk, { flat: true }).fetchAll() as (string | number)[]
        await remove(have.filter(x => !want.has(x)))
        await add([...want].filter(x => !have.includes(x)))
      })
    },
  }
}
