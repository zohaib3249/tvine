// diff(from, to) → operations per app (Django's autodetector, minimal). Renames are NEVER guessed:
// a renamed field/model is remove + add, so the drop guard fires and the dev writes
// ops.renameField / ops.renameModel by hand. Meta indexes / unique-together / constraints are owned by
// models.ts (Django): removals come first (before the fields they cover go), additions last.
// Field-level `index: true` changes are an alterField.
import { canon, fieldOf, type ModelState, type ProjectState } from './state.js'
import { makeOp, type Operation } from './operations.js'

// new models, fk targets first (cycles keep their order: sqlite checks fks on write, not create)
function creationOrder(models: Record<string, ModelState>, names: string[]): string[] {
  const out: string[] = [], seen = new Set<string>()
  const visit = (n: string) => {
    if (seen.has(n)) return
    seen.add(n)
    for (const f of Object.values(models[n].fields)) {
      if ((f.kind === 'fk' || (f.kind === 'm2m' && !f.through)) && names.includes(f.to!)) visit(f.to!)
    }
    out.push(n)
  }
  names.forEach(visit)
  return out
}

export function diff(from: ProjectState, to: ProjectState): Record<string, Operation[]> {
  const out: Record<string, Operation[]> = {}
  for (const app of [...new Set([...Object.keys(from.apps), ...Object.keys(to.apps)])].sort()) {
    const F = from.apps[app] ?? {}, T = to.apps[app] ?? {}
    const common = Object.keys(T).filter(m => F[m])
    const list: Operation[] = []
    const same = (a: unknown, b: unknown) => canon(a) === canon(b)
    const late: Operation[] = []
    // Meta removals first: an index / constraint / unique set may cover a field that goes below
    for (const m of common) {
      const a = F[m], b = T[m]
      for (const [n, c] of Object.entries(a.constraints ?? {})) if (!same(c, b.constraints?.[n])) list.push(makeOp({ kind: 'removeConstraint', model: m, name: n }))
      for (const [n, ix] of Object.entries(a.indexes)) if (!same(ix, b.indexes[n])) list.push(makeOp({ kind: 'removeIndex', model: m, name: n }))
      const ua = a.unique ?? [], ub = b.unique ?? []
      const kept = ua.filter(u => ub.some(v => same(u, v)))
      if (kept.length !== ua.length) list.push(makeOp({ kind: 'alterUniqueTogether', model: m, unique: kept }))
      if (!same(kept, ub)) late.push(makeOp({ kind: 'alterUniqueTogether', model: m, unique: ub }))
      for (const [n, ix] of Object.entries(b.indexes)) if (!same(ix, a.indexes[n])) late.push(makeOp({ kind: 'addIndex', model: m, name: n, fields: ix.fields, ...(ix.unique ? { unique: true } : {}) }))
      for (const [n, c] of Object.entries(b.constraints ?? {})) if (!same(c, a.constraints?.[n])) late.push(makeOp({ kind: 'addConstraint', model: m, constraint: c }))
    }
    // order: removals before the deletes they may block, creates before the fields that point at them
    for (const m of common) for (const n of Object.keys(F[m].fields)) if (!(n in T[m].fields)) list.push(makeOp({ kind: 'removeField', model: m, name: n }))
    for (const m of Object.keys(F)) if (!T[m]) list.push(makeOp({ kind: 'deleteModel', model: m }))
    for (const m of creationOrder(T, Object.keys(T).filter(m => !F[m]))) {
      const t = T[m]
      list.push(makeOp({ kind: 'createModel', model: m, fields: t.fields, ...(Object.keys(t.indexes).length ? { indexes: t.indexes } : {}),
        ...(t.unique?.length ? { unique: t.unique } : {}), ...(t.constraints && Object.keys(t.constraints).length ? { constraints: t.constraints } : {}) }))
    }
    for (const m of common) {
      for (const [n, f] of Object.entries(T[m].fields)) if (!(n in F[m].fields)) list.push(makeOp({ kind: 'addField', model: m, name: n, field: f }))
    }
    for (const m of common) {
      for (const [n, f] of Object.entries(T[m].fields)) {
        if (!(n in F[m].fields) || canon(f) === canon(F[m].fields[n])) continue
        // a different column set (int → fk, money ↔ scalar) cannot be altered in place without losing data
        const was = fieldOf(F[m].fields[n], from).columns(n), now = fieldOf(f, to).columns(n)
        if (was.join() !== now.join()) {
          throw new Error(`column shape changed for ${m}.${n} (${was.join(', ')} → ${now.join(', ')}): write removeField + addField (needs --allow-drop) or a runSQL data migration`)
        }
        list.push(makeOp({ kind: 'alterField', model: m, name: n, field: f }))
      }
    }
    list.push(...late)
    if (list.length) out[app] = list
  }
  return out
}
