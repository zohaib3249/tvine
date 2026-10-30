import { readFileSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// The booted server's manifest, on globalThis: Next bundles its own copy of apps/ and warp into page
// chunks, and those copies were never discovered. They resolve their ids and view defs through this.
const LIVE = Symbol.for('tvine.actions')
const g = globalThis as { [LIVE]?: ActionManifest }
export const liveManifest = (): ActionManifest | undefined => g[LIVE]
export function setLiveManifest(m: ActionManifest | undefined): void { g[LIVE] = m }

// Imports an app module. App TypeScript (any .ts/.mts outside node_modules, so also what apps/ import) goes
// through esbuild: Node's own type stripping rejects decorator syntax (`@action`) and enums.
export async function importApp(file: string): Promise<Record<string, unknown>> {
  if (TS.test(file)) await (hooked ??= tsHooks())
  return import(pathToFileURL(file).href)
}
const TS = /\.m?ts$/
let hooked: Promise<void> | undefined
async function tsHooks(): Promise<void> {
  if (typeof registerHooks !== 'function') throw new Error(`loading TypeScript app modules needs Node >= 22.15 (this is ${process.version}); or compile apps/ to .js`)
  // hidden from bundlers: Next bundles warp into page chunks and must not follow esbuild's native binary
  const { transformSync } = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'esbuild')) as typeof import('esbuild')
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || url.includes('/node_modules/') || !TS.test(new URL(url).pathname)) return nextLoad(url, context)
      const file = fileURLToPath(url)
      const { code } = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm', target: 'node22', sourcefile: file, sourcemap: 'inline' })
      return { format: 'module', source: code, shortCircuit: true }
    },
  })
}

// Bare name here (or already `<app>.<name>`); the manifest rewrites id to `${app}.${name}` on register.
// An unregistered copy (a page bundle) reads its id from the live manifest by that name.
export function defineAction<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (params: z.infer<S>, ctx: ActionCtx) => Promise<unknown>,
  rules?: ActionRules,
): ActionDef<S> {
  let own: ActionId | undefined
  return {
    name,
    get id() { return own ?? liveId(name) },
    set id(v: ActionId) { own = v },
    schema, run, rules,
  }
}

function liveId(name: string): ActionId {
  const ids = liveManifest()?.named(name) ?? []
  if (ids.length > 1) throw new Error(`action "${name}" is defined by several apps (${ids.join(', ')}); page code cannot tell which — name it with its app: defineAction('${ids[0]}', …)`)
  return ids[0] ?? name
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

// Pure: ActionRef params from a def's zod object schema (weft / MCP / snapshot use it too). rules.bind keys
// come only from the signed bind (dispatch refuses them as params), so they are not advertised.
export function paramSpecs(def: Pick<ActionDef, 'schema' | 'rules'>): ActionRef['params'] {
  const schema = def.schema
  if (!(schema instanceof z.ZodObject)) return []
  const bound = def.rules?.bind ?? []
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).filter(([name]) => !bound.includes(name)).map(([name, f]) => {
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
  private names = new Map<string, ActionId[]>()                 // defineAction name → ids (page copies look up here)
  readonly views = new Map<string, Map<string, ActionDef>[]>()  // view fingerprint → its defs by action name (views/discover.ts)
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
    const dotted = def.name?.includes('.')   // defineAction('cart.x'): already qualified, must be this app's
    if (dotted && !def.name!.startsWith(`${app}.`)) throw new Error(`action "${def.name}": a dotted name must start with its app ("${app}.")`)
    const id = prev ?? (dotted ? def.name! : `${app}.${def.name ?? def.id}`)
    if (prev && !prev.startsWith(`${app}.`)) throw new Error(`action already registered as ${prev}; cannot register it under app "${app}"`)
    if (this.defs.has(id)) throw new Error(`duplicate id ${id}`)
    const mine = def.rules ?? {}
    const rules: ActionRules = {
      ...(this.defaults.rate && { rate: this.defaults.rate }),
      ...pick(appRules),
      ...mine,
    }
    const perms = [...(appRules.permissions ?? []), ...(mine.permissions ?? [])]
    if (perms.length) rules.permissions = perms
    checkRate(`action ${id}`, rules.rate)
    const names = new Set(paramSpecs({ schema: def.schema }).map((p) => p.name))
    for (const k of rules.bind ?? []) if (!names.has(k)) throw new Error(`action ${id}: bind key "${k}" is not a param of its schema`)
    qualified.set(def, id)
    def.id = id
    this.defs.set(id, { ...def, id, rules })
    if (def.name !== undefined) this.names.set(def.name, [...(this.names.get(def.name) ?? []).filter((x) => x !== id), id])
  }

  named(name: string): ActionId[] { return this.names.get(name) ?? [] }

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
