import { statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ActionCtx, ActionDef, ActionId, ActionRef, ActionRules } from './types.js'
import { checkRate } from '../security/ratelimit.js'

export { DomainError } from './errors.js'

export type Rate = NonNullable<ActionRules['rate']>
export const APP_RE = /^[a-z][a-z0-9_]*$/

// THE loader rule for apps/<app>/<name> (views, rules, serializers, middleware, models) and cwd settings:
// source .ts or compiled .js/.mjs. Two side by side (a stale build next to the source) is refused, never guessed.
export function appModule(dir: string, name: string): string | undefined {
  const found = ['.ts', '.js', '.mjs'].map((x) => join(dir, name + x)).filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile())
  if (found.length > 1) throw new Error(`${found.join(' and ')}: more than one ${name} module; delete the stale one`)
  return found[0]
}

// Bare name here; the manifest rewrites id to `${app}.${name}` on register.
export function defineAction<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (params: z.infer<S>, ctx: ActionCtx) => Promise<unknown>,
  rules?: ActionRules,
): ActionDef<S> {
  return { id: name, schema, run, rules }
}

export const isActionDef = (v: unknown): v is ActionDef =>
  typeof v === 'object' && v !== null &&
  typeof (v as ActionDef).id === 'string' && typeof (v as ActionDef).run === 'function' &&
  typeof (v as ActionDef).schema?.safeParse === 'function'

function paramType(t: z.ZodTypeAny): string {
  if (t instanceof z.ZodString) return 'string'
  if (t instanceof z.ZodNumber) return 'number'
  if (t instanceof z.ZodBoolean) return 'boolean'
  if (t instanceof z.ZodEnum) return 'enum'
  return 'json'
}

// Pure: ActionRef params from a def's zod object schema (weft / MCP / snapshot use it too).
export function paramSpecs(def: Pick<ActionDef, 'schema'>): ActionRef['params'] {
  const schema = def.schema
  if (!(schema instanceof z.ZodObject)) return []
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([name, f]) => {
    let inner = f
    let required = true
    for (;;) {
      if (inner instanceof z.ZodOptional) { required = false; inner = inner.unwrap() }
      else if (inner instanceof z.ZodDefault) { required = false; inner = inner.removeDefault() }
      else if (inner instanceof z.ZodEffects) inner = inner.innerType()     // preprocess/refine keep the base type
      else break
    }
    return { name, type: paramType(inner), required }
  })
}

const qualified = new WeakMap<ActionDef, ActionId>()

export class ActionManifest {
  private defs = new Map<ActionId, ActionDef>()
  private specs = new Map<ActionId, ActionRef['params']>() // ponytail: schemas are static and ids bounded, so no eviction

  constructor(private defaults: { rate?: Rate } = {}) {}

  // Boot-time scan of apps/*/views.ts lives in views/discover.ts (core never imports views).

  // appRules = exports of apps/<app>/rules.ts. Precedence: action > app > settings.
  // Permissions are cumulative (app then action; first deny wins per permissions.md).
  register(app: string, def: ActionDef, appRules: Partial<ActionRules> = {}): void {
    if (!APP_RE.test(app)) throw new Error(`app name "${app}" must match ${APP_RE}`)
    // W1: the final id is written onto the caller's def object, so `import { addToCart }` sees
    // 'cart.addToCart'. A def keeps one id for life (re-registering under the same id is fine).
    const prev = qualified.get(def)
    const id = prev ?? `${app}.${def.id}`
    if (prev && !prev.startsWith(`${app}.`)) throw new Error(`action already registered as ${prev}; cannot register it under app "${app}"`)
    if (this.defs.has(id)) throw new Error(`duplicate id ${id}`)
    const own = def.rules ?? {}
    const rules: ActionRules = {
      ...(this.defaults.rate && { rate: this.defaults.rate }),
      ...pick(appRules),
      ...own,
    }
    const perms = [...(appRules.permissions ?? []), ...(own.permissions ?? [])]
    if (perms.length) rules.permissions = perms
    checkRate(`action ${id}`, rules.rate)
    const names = new Set(paramSpecs(def).map((p) => p.name))
    for (const k of rules.bind ?? []) if (!names.has(k)) throw new Error(`action ${id}: bind key "${k}" is not a param of its schema`)
    qualified.set(def, id)
    def.id = id
    this.defs.set(id, { ...def, id, rules })
  }

  get(id: ActionId) { return this.defs.get(id) }
  byApp(app: string) { return [...this.defs.values()].filter((d) => d.id.startsWith(`${app}.`)) }
  all() { return [...this.defs.values()] }

  paramSpecs(id: ActionId): ActionRef['params'] {
    let s = this.specs.get(id)
    if (!s) {
      const d = this.defs.get(id)
      if (!d) return []
      this.specs.set(id, (s = paramSpecs(d)))
    }
    return s
  }
}

// rules.ts may only contribute these keys.
const pick = ({ permissions: _p, rate, mcp }: Partial<ActionRules>): Partial<ActionRules> => ({
  ...(rate && { rate }), ...(mcp !== undefined && { mcp }),
})
