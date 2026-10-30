// diff(from, to) → operations per app (Django's autodetector, minimal). Renames are NEVER guessed:
// a renamed field/model is remove + add, so the drop guard fires and the dev writes
// ops.renameField / ops.renameModel by hand. Explicit indexes (ops.addIndex) are migration-only
// and left alone; field-level `index: true` changes are an alterField.
import { canon, type ModelState, type ProjectState } from './state.js'
import { makeOp, type Operation } from './operations.js'

// new models, fk targets first (cycles keep their order: sqlite checks fks on write, not create)
function creationOrder(models: Record<string, ModelState>, names: string[]): string[] {
  const out: string[] = [], seen = new Set<string>()
  const visit = (n: string) => {
    if (seen.has(n)) return
    seen.add(n)
    for (const f of Object.values(models[n].fields)) if (f.kind === 'fk' && names.includes(f.to!)) visit(f.to!)
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
    // order: removals before the deletes they may block, creates before the fields that point at them
    for (const m of common) for (const n of Object.keys(F[m].fields)) if (!(n in T[m].fields)) list.push(makeOp({ kind: 'removeField', model: m, name: n }))
    for (const m of Object.keys(F)) if (!T[m]) list.push(makeOp({ kind: 'deleteModel', model: m }))
    for (const m of creationOrder(T, Object.keys(T).filter(m => !F[m]))) list.push(makeOp({ kind: 'createModel', model: m, fields: T[m].fields }))
    for (const m of common) {
      for (const [n, f] of Object.entries(T[m].fields)) if (!(n in F[m].fields)) list.push(makeOp({ kind: 'addField', model: m, name: n, field: f }))
    }
    for (const m of common) {
      for (const [n, f] of Object.entries(T[m].fields)) {
        if (n in F[m].fields && canon(f) !== canon(F[m].fields[n])) list.push(makeOp({ kind: 'alterField', model: m, name: n, field: f }))
      }
    }
    if (list.length) out[app] = list
  }
  return out
}
