// Model defs by name + relation lookup (forward fk, reverse fk, m2m both ways). The compiler uses it
// for lookup paths (`vendor__name`, `product_set__price`, `tags__name`); related.ts for prefetch,
// m2m managers and onDelete. Last definition per name wins (like modelRegistry()).
import { pkField, throughOf, type Field, type Kind, type ModelDef, type Through } from './fields/index.js'

type AnyField = Field<any, boolean, Kind, boolean>
const defs = new Map<string, ModelDef>()
const objects = new Map<string, unknown>()     // model name → its Model (model.ts)

let checked = false
export const registerDef = (def: ModelDef, model?: unknown): void => { defs.set(def.name, def); if (model) objects.set(def.name, model); checked = false }
// register + run the clash check; a clashing definition is not kept (the previous one, if any, stays)
export function defineChecked(def: ModelDef, model: unknown): void {
  const prev = [defs.get(def.name), objects.get(def.name)] as const
  registerDef(def, model)
  try { checkRelations() } catch (e) {
    if (prev[0]) { defs.set(def.name, prev[0]); objects.set(def.name, prev[1]) } else { defs.delete(def.name); objects.delete(def.name) }
    checked = false
    throw e
  }
}

// reverse-accessor clash checks: every reverse name on a model is unique
// and does not shadow one of its fields. Run at boot (discoverModels) and before the first relation lookup.
export function checkRelations(): void {
  if (checked) return
  const seen = new Map<string, string>()   // `<target>.<reverse name>` → the field that claims it
  for (const src of defs.values()) {
    for (const [n, f] of Object.entries(src.fields)) {
      if (f.kind !== 'fk' && f.kind !== 'm2m') continue
      let target: ModelDef
      try { target = f.target!() } catch { continue }   // target not defined yet: checked on a later call
      const name = reverseName(src, f), key = `${target.name}.${name}`, who = `${src.name}.${n}`
      const prev = seen.get(key)
      if (prev && prev !== who) throw new Error(`${prev} and ${who} both give ${target.name} the reverse name "${name}": set relatedName on one of them`)
      if (target.fields[name]) throw new Error(`${who}: its reverse name "${name}" clashes with the field ${target.name}.${name}: set relatedName`)
      seen.set(key, who)
    }
  }
  checked = true
}
export const modelNamed = <M>(name: string): M | undefined => objects.get(name) as M | undefined
export const allDefs = (): ModelDef[] => [...defs.values()]

export type Relation =
  // fk: this model holds `col` → target pk
  | { kind: 'fk'; name: string; field: AnyField; col: string; target: ModelDef }
  // reverse fk: `source.col` → this model's pk (many)
  | { kind: 'reverse'; name: string; source: ModelDef; field: string; col: string; target: ModelDef }
  // m2m (either direction): through.src → this model, through.dst → target
  | { kind: 'm2m'; name: string; through: Through; srcCol: string; dstCol: string; target: ModelDef }

const colOf = (def: ModelDef, field: string) => def.fields[field].columns(field)[0]
export const reverseName = (source: ModelDef, f: AnyField) => f.opts.relatedName ?? `${source.name}_set`

// `name` as a relation from `def` (field name or reverse accessor), or undefined
export function relationOf(def: ModelDef, name: string): Relation | undefined {
  checkRelations()
  const own = def.fields[name]
  if (own?.kind === 'fk') return { kind: 'fk', name, field: own, col: colOf(def, name), target: own.target!() }
  if (own?.kind === 'm2m') {
    const t = throughOf(def, name, own)
    return { kind: 'm2m', name, through: t, srcCol: colOf(t.def, t.src), dstCol: colOf(t.def, t.dst), target: own.target!() }
  }
  if (own) return undefined
  for (const src of defs.values()) {
    for (const [n, f] of Object.entries(src.fields)) {
      if ((f.kind !== 'fk' && f.kind !== 'm2m') || f.target!().name !== def.name || reverseName(src, f) !== name) continue
      if (f.kind === 'fk') return { kind: 'reverse', name, source: src, field: n, col: colOf(src, n), target: src }
      const t = throughOf(src, n, f)   // reverse m2m: walk the through table the other way
      return { kind: 'm2m', name, through: { ...t, src: t.dst, dst: t.src }, srcCol: colOf(t.def, t.dst), dstCol: colOf(t.def, t.src), target: src }
    }
  }
  return undefined
}

// every fk (in any registered model, incl. auto through tables) pointing at `def`
export function referencesTo(def: ModelDef): { source: ModelDef; field: string; f: AnyField }[] {
  const out: { source: ModelDef; field: string; f: AnyField }[] = []
  for (const src of defs.values()) {
    for (const [n, f] of Object.entries(src.fields)) {
      if (f.kind === 'fk' && f.target!().name === def.name) out.push({ source: src, field: n, f })
    }
  }
  return out
}

export const pkCol = (def: ModelDef) => pkField(def)[0]
