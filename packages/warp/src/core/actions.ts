import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { ActionCtx, ActionDef, ActionId, ActionRef, ActionRules } from './types.js'

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

function deriveSpec(schema: z.ZodTypeAny): ActionRef['params'] {
  if (!(schema instanceof z.ZodObject)) return []
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([name, f]) => {
    let inner = f
    let required = true
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      required = false
      inner = inner instanceof z.ZodOptional ? inner.unwrap() : inner.removeDefault()
    }
    return { name, type: paramType(inner), required }
  })
}

function checkRate(id: string, r?: Rate) {
  if (r && !(r.limit >= 1 && r.windowMs > 0)) {
    throw new Error(`action ${id}: invalid rate ${JSON.stringify(r)} (need limit >= 1 and windowMs > 0)`)
  }
}

export class ActionManifest {
  private defs = new Map<ActionId, ActionDef>()
  private specs = new Map<ActionId, ActionRef['params']>() // ponytail: schemas are static and ids bounded, so no eviction

  constructor(private defaults: { rate?: Rate } = {}) {}

  // Boot-time scan of apps/*/views.ts. Pass settings.limits.rate as defaults.rate.
  // Class-based Views (Task 7) are skipped here for now.
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
      for (const [exp, v] of Object.entries(mod)) {
        if (!isActionDef(v)) continue
        try {
          m.register(app, v, rules)
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
    const id = `${app}.${def.id}`
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
      this.specs.set(id, (s = deriveSpec(d.schema)))
    }
    return s
  }
}

// rules.ts may only contribute these keys.
const pick = ({ permissions: _p, rate, mcp }: Partial<ActionRules>): Partial<ActionRules> => ({
  ...(rate && { rate }), ...(mcp !== undefined && { mcp }),
})
