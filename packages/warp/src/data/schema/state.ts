// ProjectState (Django's ProjectState): pure data, never stored. It is REBUILT by replaying every
// migration's operations in dependency order; makemigrations diffs it against models.ts.
//   apps → models → { fields: name → FieldSpec, indexes: name → explicit (ops.addIndex) index }
// fks live on their field (kind 'fk', `to` = target model name); field-level `index: true` stays
// a field option (Django's db_index). Field instances are rebuilt from specs only to render DDL.
import { field } from '../fields.js'
import { FkField, pkField, type Field, type Kind, type ModelDef, type Opts } from '../fields/index.js'
import type { Model } from '../model.js'

export interface FieldSpec { kind: Kind; opts: Opts; values?: string[]; to?: string }
export interface IndexSpec { fields: string[]; unique?: boolean }
export interface ModelState { fields: Record<string, FieldSpec>; indexes: Record<string, IndexSpec> }
export interface ProjectState { apps: Record<string, Record<string, ModelState>> }
type AnyField = Field<any, boolean, Kind, boolean>

export const emptyState = (): ProjectState => ({ apps: {} })

// boolean flags that mean nothing when false; `default: false` is a real value and stays
const FLAGS = new Set(['optional', 'unique', 'searchable', 'index', 'auto'])
// view-only flags (generic views' serializers): no DDL, so they never enter state or migrations
const VIEW_ONLY = new Set(['hidden', 'readOnly', 'writeOnly'])

// Field → spec (Django's deconstruct). Opts sorted so specs and generated code are deterministic.
export function specOf(f: AnyField): FieldSpec {
  const opts: Record<string, unknown> = {}
  for (const k of Object.keys(f.opts).sort()) {
    const v = (f.opts as Record<string, unknown>)[k]
    if (v !== undefined && !VIEW_ONLY.has(k) && !(FLAGS.has(k) && v === false)) opts[k] = v
  }
  const s: FieldSpec = { kind: f.kind, opts }
  if (f.kind === 'enum') s.values = [...f.values!]
  if (f.kind === 'fk') s.to = f.target!().name
  return s
}

// spec → Field, fks resolved against `state` when their DDL is rendered
export function fieldOf(s: FieldSpec, state: ProjectState): AnyField {
  const o = s.opts
  switch (s.kind) {
    case 'id': return field.id()
    case 'enum': return field.enum(s.values!, o)
    case 'fk': return new FkField(() => modelDef(state, s.to!), o)
    default: return (field[s.kind] as (o: Opts) => AnyField)(o)
  }
}

export function findModel(state: ProjectState, name: string): { app: string; model: ModelState } | undefined {
  for (const [app, models] of Object.entries(state.apps)) if (models[name]) return { app, model: models[name] }
  return undefined
}

export function modelIn(state: ProjectState, app: string, name: string): ModelState {
  const m = state.apps[app]?.[name]
  if (!m) throw new Error(`unknown model "${name}" in app ${app}`)
  return m
}

export function modelDef(state: ProjectState, name: string): ModelDef {
  const m = findModel(state, name)?.model
  if (!m) throw new Error(`fk to unknown model "${name}"`)
  return { name, fields: Object.fromEntries(Object.entries(m.fields).map(([n, s]) => [n, fieldOf(s, state)])) }
}

// current models.ts, grouped by app (discoverModels)
export function stateFromModels(byApp: Record<string, Model<any, any>[]>): ProjectState {
  const s = emptyState()
  for (const [app, models] of Object.entries(byApp)) {
    if (models.length) s.apps[app] = {}
    for (const m of models) {
      pkField(m)
      s.apps[app][m.name] = { fields: Object.fromEntries(Object.entries(m.fields as Record<string, AnyField>).map(([n, f]) => [n, specOf(f)])), indexes: {} }
    }
  }
  return s
}

// replay a planned list of migrations (graph.order()) from nothing
export function replay(plan: { app: string; migration: { operations: { stateForwards(s: ProjectState, app: string): void }[] } }[]): ProjectState {
  const s = emptyState()
  for (const n of plan) for (const op of n.migration.operations) op.stateForwards(s, n.app)
  return s
}

// key-sorted JSON: equality that ignores field / model order (Django ignores field order too)
export function canon(v: unknown): string {
  return JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)
}
