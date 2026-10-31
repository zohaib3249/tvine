// dumpdata / loaddata (Django's fixtures, BACKLOG #6): JSON `[{ model: 'app.model', pk, fields }]`,
// models in fk dependency order, loaded inside ONE atomic() block, upserted by pk through the model
// API (so money / datetime / json go through their fields). m2m fields dump as id lists.
import { DomainError } from '../core/errors.js'
import { atomic, resetSequences } from './engine.js'
import { concrete, pkField, type Fields } from './fields/index.js'
import type { Model } from './model.js'

export interface FixtureRow { model: string; pk: string | number; fields: Record<string, unknown> }
type M = Model<Fields, any>

// targets before the models pointing at them (cycles keep their given order)
function ordered(models: [string, M][]): [string, M][] {
  const byName = new Map(models.map(([app, m]) => [m.name, [app, m] as [string, M]]))
  const out: [string, M][] = [], seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name) || !byName.has(name)) return
    seen.add(name)
    const [, m] = byName.get(name)!
    // fk targets first. A custom through model has its own fks to both sides, so it lands after its owner.
    for (const f of Object.values(m.fields)) if (f.kind === 'fk') visit(f.target!().name)
    out.push(byName.get(name)!)
  }
  [...byName.keys()].sort().forEach(visit)
  return out
}

function pick(byApp: Record<string, M[]>, labels: string[]): [string, M][] {
  const all = Object.entries(byApp).flatMap(([app, ms]) => ms.map(m => [app, m] as [string, M]))
  if (!labels.length) return all
  return labels.flatMap(l => {
    const [app, model] = l.split('.')
    const hit = all.filter(([a, m]) => a === app && (!model || m.name === model))
    if (!hit.length) throw new Error(`dumpdata: no models match "${l}" (use app or app.model)`)
    return hit
  })
}

// a required self-fk (tree with NOT NULL parent): parents before children; a cycle cannot load
function selfOrdered<X extends { m: M; r: FixtureRow }>(rows: X[]): X[] {
  const out: X[] = [], placed = new Set<string>()
  const key = (m: M, pk: unknown) => `${m.name}#${String(pk)}`
  const parentsOf = (x: X) => Object.entries(x.m.fields)
    .filter(([, f]) => f.kind === 'fk' && f.target!().name === x.m.name && !f.opts.optional)
    .map(([n, f]) => x.r.fields[n] ?? x.r.fields[f.key(n)]).filter(v => v != null)
  const inBatch = new Set(rows.map(x => key(x.m, x.r.pk)))
  let left = rows
  while (left.length) {
    const ready = left.filter(x => parentsOf(x).every(p => p === x.r.pk || placed.has(key(x.m, p)) || !inBatch.has(key(x.m, p))))
    if (!ready.length) throw new DomainError('invalid_param', `fixture rows of ${left[0].m.name} reference each other through a required fk (a cycle): make it optional`)
    for (const x of ready) { out.push(x); placed.add(key(x.m, x.r.pk)) }
    left = left.filter(x => !ready.includes(x))
  }
  return out
}

const jsonValue = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v)

export async function dumpData(byApp: Record<string, M[]>, labels: string[] = []): Promise<FixtureRow[]> {
  const out: FixtureRow[] = []
  for (const [app, m] of ordered(pick(byApp, labels))) {
    const [pk] = pkField(m)
    const m2m = Object.entries(m.fields).filter(([, f]) => f.kind === 'm2m' && !f.through).map(([n]) => n)
    const rows = await m.objects.order(pk).prefetchRelated(...m2m).fetchAll() as Record<string, unknown>[]
    for (const r of rows) {
      const fields: Record<string, unknown> = {}
      for (const [n, f] of concrete(m.fields)) if (n !== pk) fields[f.key(n)] = jsonValue(r[f.key(n)])
      for (const n of m2m) fields[n] = (r[n] as Record<string, unknown>[]).map(x => x[pkField(m.fields[n].target!())[0]])
      out.push({ model: `${app}.${m.name}`, pk: r[pk] as string | number, fields })
    }
  }
  return out
}

export async function loadData(byApp: Record<string, M[]>, rows: FixtureRow[]): Promise<number> {
  const models = new Map(Object.entries(byApp).flatMap(([app, ms]) => ms.map(m => [`${app}.${m.name}`, m] as [string, M])))
  const order = new Map(ordered([...models].map(([k, m]) => [k.split('.')[0], m])).map(([, m], i) => [m.name, i]))
  const parsed = rows.map((r, i) => {
    const m = r && typeof r === 'object' ? models.get(r.model) : undefined
    if (!m) throw new DomainError('invalid_param', `fixture row ${i}: unknown model ${JSON.stringify(r?.model)} (expected app.model)`)
    if (r.pk === undefined || !r.fields || typeof r.fields !== 'object') throw new DomainError('invalid_param', `fixture row ${i} (${r.model}) needs pk and fields`)
    return { m, r }
  }).sort((a, b) => order.get(a.m.name)! - order.get(b.m.name)!)   // stable: file order within a model
  return atomic(async () => {
    const links: [M, string | number, string, unknown[]][] = []
    const fills: [M, string | number, Record<string, unknown>][] = []   // optional self-fks: set after every row exists
    for (const { m, r } of selfOrdered(parsed)) {
      const [pk] = pkField(m)
      const data: Record<string, unknown> = {}, later: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r.fields)) {
        const e = Object.entries(m.fields).find(([n, x]) => n === k || x.key(n) === k)
        if (!e) throw new DomainError('invalid_param', `fixture ${r.model} ${r.pk}: unknown field "${k}"`)
        const [, f] = e
        if (f.kind === 'm2m') { links.push([m, r.pk, k, v as unknown[]]); continue }
        if (f.kind === 'fk' && f.target!().name === m.name && f.opts.optional && v != null) { later[k] = v; data[k] = null; continue }
        data[k] = f.kind === 'datetime' && typeof v === 'string' ? new Date(v) : v
      }
      if (await m.get(r.pk)) await m.update(r.pk, data)
      else await m.create({ [pk]: r.pk, ...data })
      if (Object.keys(later).length) fills.push([m, r.pk, later])
    }
    for (const [m, pk, patch] of fills) await m.update(pk, patch)
    for (const [m, pk, name, ids] of links) await m.related(name, pk).set(ids as (string | number)[])
    await resetSequences([...new Set(parsed.map(p => p.m))])
    return parsed.length
  })
}
