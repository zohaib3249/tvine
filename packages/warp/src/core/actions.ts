import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { ActionCtx, ActionDef, ActionId, ActionRef, ActionRules } from './types.js'
import { isViewClass, viewActions } from '../views/generic.js'

export { DomainError } from './errors.js'

type Rate = NonNullable<ActionRules['rate']>
const APP_RE = /^[a-z][a-z0-9_]*$/

// Bare name here; the manifest rewrites id to `${app}.${name}` on register.
export function defineAction<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (params: z.infer<S>, ctx: ActionCtx) => Promise<unknown>,
  rules?: ActionRules,
): ActionDef<S> {
  return { id: name, schema, run, rules }
}

const isActionDef = (v: unknown): v is ActionDef =>
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

function checkRate(id: string, r?: Rate) {
  if (r && !(r.limit >= 1 && r.windowMs > 0)) {
    throw new Error(`action ${id}: invalid rate ${JSON.stringify(r)} (need limit >= 1 and windowMs > 0)`)
  }
}

const qualified = new WeakMap<ActionDef, ActionId>()

export class ActionManifest {
  private defs = new Map<ActionId, ActionDef>()
  private specs = new Map<ActionId, ActionRef['params']>() // ponytail: schemas are static and ids bounded, so no eviction

  constructor(private defaults: { rate?: Rate } = {}) {}

  // Boot-time scan of apps/*/views.ts. Pass settings.limits.rate as defaults.rate.
  // Exported View subclasses are instantiated and register their generated + @action actions.
  static async discover(appsDir: string, defaults: { rate?: Rate } = {}): Promise<ActionManifest> {
    const m = new ActionManifest(defaults)
    for (const app of (await readdir(appsDir)).sort()) {
      const dir = join(appsDir, app)
      if (!(await stat(dir)).isDirectory()) continue
      const views = join(dir, 'views.ts')
      if (!(await stat(views).catch(() => null))) continue
      if (!APP_RE.test(app)) throw new Error(`${views}: folder name "${app}" must match ${APP_RE}`)
      const mod = await import(pathToFileURL(views).href)
      const rulesFile = join(dir, 'rules.ts')
      const rules = (await stat(rulesFile).catch(() => null)) ? await import(pathToFileURL(rulesFile).href) : {}
      const serFile = join(dir, 'serializers.ts')
      const shapers = (await stat(serFile).catch(() => null)) ? (await import(pathToFileURL(serFile).href)).serializers : undefined
      const found: [string, ActionDef][] = []
      for (const [exp, v] of Object.entries(mod)) {
        if (isActionDef(v)) found.push([exp, v])
        else if (isViewClass(v)) {
          try { for (const d of viewActions(v, { shapers })) found.push([exp, d]) }
          catch (e) { throw new Error(`${views} export ${exp}: ${(e as Error).message}`) }
        }
      }
      // generic-views.md: a view action name used by several classes becomes <Class>.<name>
      const viewNames = found.filter(([e]) => isViewClass(mod[e])).map(([, d]) => d.id)
      for (const [exp, d] of found) {
        if (isViewClass(mod[exp]) && viewNames.filter((n) => n === d.id).length > 1) d.id = `${exp}.${d.id}`
        try {
          m.register(app, d, rules)
        } catch (e) {
          throw new Error(`${views} export ${exp}: ${(e as Error).message}`)
        }
      }
    }
    return m
  }

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
    checkRate(id, rules.rate)
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
