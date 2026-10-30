// Class-based generic views (DRF generics + mixins). Spec: docs/design/conventions/generic-views.md
// A view class exported from apps/<app>/views.ts is instantiated ONCE at discovery. Every call runs
// its hooks / @action method on a fresh `Object.create(view)`, so `this.x = …` never leaks between
// requests, and gets a fresh ViewCtx (action + validated params).
import { z } from 'zod'
import { DomainError } from '../core/errors.js'
import { ANONYMOUS, type ActionCtx, type ActionDef, type ActionId, type ActionRules, type Permission, type PermissionCtx } from '../core/types.js'
import { decodeCursor, MAX_IN, type Op, type Paginated, type QuerySet, type Where } from '../data/queryset.js'
import { hasDefault, pkField, type Field, type Kind } from '../data/fields.js'
import type { Model } from '../data/model.js'

type AnyField = Field<any, boolean, Kind, boolean>

type Out = Record<string, unknown>
export type Shapers = Record<string, (data: Out) => Out>    // apps/<app>/serializers.ts `serializers`

// The ActionCtx plus which generated/@action name is running and its validated params.
export type ViewCtx = ActionCtx & { action: string; actionId: ActionId; params: Record<string, unknown> }

export interface Serializer<T> {
  input?: z.ZodObject<z.ZodRawShape>                // create/update params; must be a plain z.object (update = .partial())
  readOnlyFields?: string[]                         // DRF read_only_fields: dropped from input; sending one → invalid_param
  output(obj: T, sctx: Record<string, unknown>): Out
}
export const defineSerializer = <T>(s: Serializer<T>): Serializer<T> => s

export abstract class View {
  static permissions: Permission[] = []             // static → merged into every action's rules
}

// ---- @action ------------------------------------------------------------------------------------
interface ActionOpts { rules?: ActionRules; permissions?: Permission[] }
const decorated = new WeakMap<Function, { schema: z.ZodType; opts: ActionOpts }>()

// TS 5 standard method decorator: registers the method as `<app>.<methodName>`, `this` = view.
export function action<S extends z.ZodType>(schema: S, opts: ActionOpts = {}) {
  return <This, F extends (this: This, params: z.infer<S>, ctx: ViewCtx) => Promise<unknown>>(
    method: F, context: ClassMethodDecoratorContext<This, F>,
  ): void => {
    if (context.static || context.private || typeof context.name !== 'string') {
      throw new Error(`@action ${String(context.name)}: needs a public, non-static, string-named method`)
    }
    decorated.set(method, { schema, opts })
  }
}

// ---- lookups ------------------------------------------------------------------------------------
const SUFFIX: Record<string, Op> = { '': 'eq', lt: 'lt', lte: 'lte', gt: 'gt', gte: 'gte', in: 'in', contains: 'contains', ne: 'ne' }

function fieldNamed(model: Model<any, any>, name: string): AnyField | undefined {
  return Object.entries(model.fields as Record<string, AnyField>).find(([n, f]) => n === name || f.key(n) === name)?.[1]
}

function parseLookup(l: string): { field: string; op: Op | undefined } {
  const [field, suffix = '', ...rest] = l.split('__')
  return { field, op: rest.length ? undefined : SUFFIX[suffix] }
}

// URL params arrive as strings; coerce through the field's type ("30" → 30, "a,b" → [a, b]).
// A blank string stays a string, so z.number rejects it (never silently 0).
const num = z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number())
function valueSchema(f: AnyField): z.ZodTypeAny {
  switch (f.kind) {
    // money: major units ("30" = $30). A URL string must be plain decimal (no 0x1E / 1e1 / 29.999…9
    // that Number() would round); the field's value schema then checks numbers sent as JSON.
    // The field's lookup()/toDb converts to cents.
    case 'money': return z.preprocess(v => (typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v) ? Number(v) : v), z.number())
      .refine(v => (f.zod() as z.AnyZodObject).shape.value.safeParse(v).success, 'money value must have at most 2 decimals')
    case 'id': case 'int': case 'float': return num
    case 'fk': return pkField(f.target!())[1].kind === 'id' ? num : z.string()
    case 'bool': return z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
    case 'datetime': return z.preprocess(v => (typeof v === 'string' || typeof v === 'number' ? new Date(v) : v), z.date())
    case 'enum': return f.zod()
    default: return z.string()
  }
}
function lookupSchema(f: AnyField, op: Op): z.ZodTypeAny {
  if (op === 'contains') return z.string()
  if (op === 'in') return z.preprocess(v => (typeof v === 'string' ? v.split(',') : v), z.array(valueSchema(f)).max(MAX_IN))
  return valueSchema(f)
}

// zod failure → DomainError invalid_param naming the offending param
function validate(schema: z.ZodTypeAny, raw: unknown, url = false, readOnly?: Set<string>): Record<string, unknown> {
  const input = url && raw && typeof raw === 'object'
    ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined))   // empty form field = absent
    : raw
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const i = r.error.issues[0]
  const field = i.code === 'unrecognized_keys' ? i.keys[0] : String(i.path[0] ?? '')
  const msg = i.code !== 'unrecognized_keys' ? `${field}: ${i.message}`
    : readOnly?.has(field) ? `"${field}" is read-only` : `unknown param "${field}"`
  throw new DomainError('invalid_param', msg, field)
}

// PermissionCtx from an ActionCtx (shared by checkPermissions and the page helper)
function permissionCtx(ctx: ActionCtx, action: ActionId): PermissionCtx {
  const r = ctx.request
  return { sid: ctx.sid, session: ctx.session, action, route: r?.route ?? '', user: r?.user ?? ANONYMOUS, agent: r?.agent, ip: r?.ip ?? '' }
}
async function runPermissions(perms: Permission[], pctx: PermissionCtx): Promise<void> {
  for (const p of perms) if (!(await p(pctx))) throw new DomainError('forbidden', `not allowed: ${pctx.action}`)
}

// ---- GenericView ----------------------------------------------------------------------------------
export type GeneratedAction = 'list' | 'get' | 'create' | 'update' | 'delete'

export abstract class GenericView<T extends object = any> extends View {
  static actions: readonly GeneratedAction[] = []
  abstract model: Model<any, T>
  lookupField = 'id'                                // DRF lookup_field
  lookupParam = 'id'                                // DRF lookup_url_kwarg
  serializer?: Serializer<T>
  permissions: Permission[] = []                    // runtime checks (getPermissions); static ones go in rules
  pageSize = 25
  maxPageSize = 100
  filters?: string[]                                // Django lookups; default: the model's enum/index fields
  searchFields?: string[]                           // ?q=; default: the model's searchable fields
  ordering: string[] = []                           // allowed ?sort= values (each also as '-field')
  shapers?: Shapers                                 // set by discovery from apps/<app>/serializers.ts

  getQueryset(_ctx: ViewCtx): QuerySet<T> { return this.model.objects }

  filterQueryset(qs: QuerySet<T>, ctx: ViewCtx): QuerySet<T> {
    const p = ctx.params
    const where: Where[] = []
    for (const l of effectiveFilters(this)) {
      if (p[l] === undefined) continue
      const { field, op } = parseLookup(l)
      where.push({ field, op: op!, value: p[l] })
    }
    if (where.length) qs = qs.filter(where)
    if (typeof p.q === 'string') qs = qs.search(p.q, this.searchFields as (keyof T & string)[] | undefined)
    if (typeof p.sort === 'string') qs = qs.order(p.sort)
    return qs
  }

  paginateQueryset(qs: QuerySet<T>, ctx: ViewCtx): Promise<Paginated<T>> {
    const cursor = typeof ctx.params.cursor === 'string' ? ctx.params.cursor : undefined
    return qs.page({ cursor, size: Math.min(this.pageSize, this.maxPageSize) })
  }

  async getObject(ctx: ViewCtx): Promise<T> {
    const v = ctx.params[this.lookupParam]
    const obj = await this.filterQueryset(this.getQueryset(ctx), ctx).filter({ [this.lookupField]: v } as never).first()
    if (!obj) throw new DomainError('not_found', `${this.model.name} ${String(v)} not found`, this.lookupParam)
    await this.checkObjectPermissions(ctx, obj)
    return obj
  }

  getPermissions(_ctx: ViewCtx): Permission[] { return this.permissions }

  checkPermissions(ctx: ViewCtx): Promise<void> {
    return runPermissions(this.getPermissions(ctx), permissionCtx(ctx, ctx.actionId))
  }

  // DRF has_object_permission. Default allow; override and throw DomainError('forbidden', …) to deny.
  async checkObjectPermissions(_ctx: ViewCtx, _obj: T): Promise<void> {}

  getSerializer(_ctx: ViewCtx): Serializer<T> { return this.serializer ?? defaultSerializer(this) }

  getSerializerContext(ctx: ViewCtx): Record<string, unknown> {
    return { request: ctx.request, user: ctx.request?.user ?? ANONYMOUS, view: this, action: ctx.action }
  }

  performCreate(data: Record<string, unknown>, _ctx: ViewCtx): Promise<T> { return this.model.create(data as never) }

  async performUpdate(obj: T, data: Record<string, unknown>, _ctx: ViewCtx): Promise<T> {
    if (!Object.keys(data).length) return obj
    return this.model.update((obj as { id: string | number }).id, data as never)
  }

  performDestroy(obj: T, _ctx: ViewCtx): Promise<void> { return this.model.delete((obj as { id: string | number }).id) }

  // Page-component helper: `await ProductList.queryset(searchParams)` → the same serialized Paginated
  // as `<app>.list`. Uses the def discovery registered (merged app + class + action permissions run
  // first, app shapers apply). Unknown URL keys (utm_*, …) are dropped here; the action stays strict.
  // Without a ctx the hooks see ANONYMOUS and request.query only.
  static async queryset<V extends GenericView>(
    this: (new () => V) & typeof GenericView,
    searchParams: URLSearchParams | Record<string, string | string[] | undefined>,
    ctx?: ActionCtx,
  ): Promise<Paginated<Out>> {
    const list = registeredList.get(this)
    if (!list) throw new Error(`${this.name}.queryset(): no registered list action; export the view from apps/<app>/views.ts and run discover() at boot`)
    const known = (list.schema as z.AnyZodObject).shape
    const query = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams()
    const params: Record<string, string> = {}
    if (searchParams instanceof URLSearchParams) {
      for (const k of new Set(query.keys())) if (Object.hasOwn(known, k)) params[k] = query.getAll(k).join(',')
    } else {
      for (const [k, v] of Object.entries(searchParams)) {
        if (v === undefined || !Object.hasOwn(known, k)) continue
        params[k] = Array.isArray(v) ? v.join(',') : v
        query.set(k, params[k])
      }
    }
    const c = ctx ?? ({ request: { query, user: ANONYMOUS } } as unknown as ActionCtx)
    await runPermissions(list.rules?.permissions ?? [], permissionCtx(c, list.id))
    return list.run(params, c) as Promise<Paginated<Out>>
  }
}

// discovery → page helper: the manifest's merged-rules copy of each view's list def
const generatedName = new WeakMap<ActionDef, GeneratedAction>()
const registeredList = new WeakMap<Function, ActionDef>()
export function bindRegistered(V: Function, original: ActionDef, registered: ActionDef): void {
  if (generatedName.get(original) === 'list') registeredList.set(V, registered)
}

// Concrete views: DRF generics names. Each is GenericView + which actions it generates.
export abstract class ListView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['list'] }
export abstract class DetailView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['get'] }
export abstract class CreateView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['create'] }
export abstract class UpdateView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['update'] }
export abstract class DeleteView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['delete'] }
export abstract class ListCreateView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['list', 'create'] }
export abstract class RetrieveUpdateView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['get', 'update'] }
export abstract class RetrieveDestroyView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['get', 'delete'] }
export abstract class RetrieveUpdateDestroyView<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['get', 'update', 'delete'] }
export abstract class ModelViewSet<T extends object = any> extends GenericView<T> { static actions: readonly GeneratedAction[] = ['list', 'get', 'create', 'update', 'delete'] }

const BASES = new Set<Function>([View, GenericView, ListView, DetailView, CreateView, UpdateView, DeleteView,
  ListCreateView, RetrieveUpdateView, RetrieveDestroyView, RetrieveUpdateDestroyView, ModelViewSet])

// A user's View subclass (the library's own bases are skipped when re-exported).
export const isViewClass = (v: unknown): v is new () => View =>
  typeof v === 'function' && v.prototype instanceof View && !BASES.has(v)

function effectiveFilters(v: GenericView): string[] {
  return v.filters ?? Object.entries(v.model.fields as Record<string, AnyField>)
    .filter(([, f]) => f.kind === 'enum' || f.opts.index).map(([n, f]) => f.key(n))
}
const effectiveSearch = (v: GenericView): string[] => v.searchFields ?? Object.entries(v.model.fields as Record<string, AnyField>)
  .filter(([, f]) => f.opts.searchable).map(([n, f]) => f.key(n))

// One default serializer per (model, app shapers): built once, so inputOf's per-serializer cache holds too.
const defaultSers = new WeakMap<object, Map<Shapers | undefined, Serializer<any>>>()
function defaultSerializer<T extends object>(v: GenericView<T>): Serializer<T> {
  let byShapers = defaultSers.get(v.model)
  if (!byShapers) defaultSers.set(v.model, (byShapers = new Map()))
  const cached = byShapers.get(v.shapers)
  if (cached) return cached
  // DRF: write_only fields are never output; hidden fields neither
  const hidden = new Set(Object.entries(v.model.fields as Record<string, AnyField>)
    .filter(([, f]) => f.opts.hidden || f.opts.writeOnly).map(([n, f]) => f.key(n)))
  const shape = v.shapers?.[v.model.name]
  const s: Serializer<T> = {
    input: createInput(v.model),
    output: (obj: T) => {
      const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !hidden.has(k)))
      return shape ? shape(out) : out
    },
  }
  byShapers.set(v.shapers, s)
  return s
}

// Write-protected by the model: readOnly, or hidden unless writeOnly; plus generated keys.
function modelReadOnly(model: Model<any, any>): Set<string> {
  return new Set(Object.entries(model.fields as Record<string, AnyField>)
    .filter(([, f]) => f.kind === 'id' || f.kind === 'uuid' || f.opts.auto || f.opts.readOnly || (f.opts.hidden && !f.opts.writeOnly))
    .map(([n, f]) => f.key(n)))
}

// model.schema minus write-protected fields; defaulted fields optional
function createInput(model: Model<any, any>): z.ZodObject<z.ZodRawShape> {
  const ro = modelReadOnly(model)
  const shape: z.ZodRawShape = {}
  for (const [n, f] of Object.entries(model.fields as Record<string, AnyField>)) {
    if (!ro.has(f.key(n))) shape[f.key(n)] = hasDefault(f) ? f.schema().optional() : f.schema()
  }
  return z.object(shape)
}

// The input a serializer really accepts: plain object, read-only keys removed, unknown keys rejected.
const inputs = new WeakMap<Serializer<any>, { schema: z.AnyZodObject; readOnly: Set<string> }>()
function inputOf(model: Model<any, any>, ser: Serializer<any>): { schema: z.AnyZodObject; readOnly: Set<string> } {
  let r = inputs.get(ser)
  if (!r) {
    const base = ser.input ?? createInput(model)
    if (!(base instanceof z.ZodObject)) {
      throw new Error(`serializer.input must be a plain z.object(...) so update can apply .partial(); refine individual fields instead`)
    }
    const readOnly = new Set([...modelReadOnly(model), ...(ser.readOnlyFields ?? [])])
    const drop = Object.fromEntries(Object.keys(base.shape).filter(k => readOnly.has(k)).map(k => [k, true as const]))
    inputs.set(ser, (r = { schema: base.omit(drop).strict(), readOnly }))
  }
  return r
}

// Boot: instantiate, validate config against the model, build every ActionDef (bare names).
export function viewActions(V: new () => View, opts: { shapers?: Shapers } = {}): ActionDef[] {
  const view = new V()
  const name = V.name || 'View'
  const fail = (msg: string): never => { throw new Error(`${name}: ${msg}`) }
  const statics = (V as unknown as typeof View).permissions ?? []
  const withPerms = (r: ActionRules = {}, extra: Permission[] = []): ActionRules => {
    const permissions = [...statics, ...extra, ...(r.permissions ?? [])]
    return { ...r, ...(permissions.length && { permissions }) }
  }
  const defs: ActionDef[] = []

  if (view instanceof GenericView) {
    const gv = view as GenericView
    if (opts.shapers) gv.shapers = opts.shapers
    if (!gv.model?.fields) fail('needs `model = SomeModel`')
    const model = gv.model
    const need = (what: string, f: string) => fieldNamed(model, f) ?? fail(`${what} "${f}": no field "${f}" on model ${model.name}`)
    for (const f of effectiveSearch(gv)) if (need('searchFields', f).kind === 'money') fail(`searchFields "${f}": a money field cannot be searched`)
    for (const f of gv.ordering) need('ordering', f)
    const lookupF = need('lookupField', gv.lookupField)
    const lookups: z.ZodRawShape = {}
    for (const l of effectiveFilters(gv)) {
      const { field, op } = parseLookup(l)
      if (!op) fail(`filter "${l}": unknown lookup (use exact, __lt, __lte, __gt, __gte, __in, __contains, __ne)`)
      const f = need(`filter "${l}"`, field)
      if (op === 'contains' && f.kind !== 'text') fail(`filter "${l}": __contains needs a text field ("${field}" is ${f.kind})`)
      lookups[l] = lookupSchema(f, op!).optional()
    }
    const sorts = gv.ordering.flatMap(f => [f, `-${f}`])
    const listSchema = z.object({
      ...(effectiveSearch(gv).length && { q: z.string().optional() }),
      ...(sorts.length && { sort: z.enum(sorts as [string, ...string[]]).optional() }),
      cursor: z.string().refine(c => { try { decodeCursor(c); return true } catch { return false } }, 'invalid cursor').optional(),
      ...lookups,
    }).strict()
    const lookupObj = z.object({ [gv.lookupParam]: valueSchema(lookupF) })

    // Advertised create/update schemas come from getSerializer() resolved per action at boot (no
    // request yet: ctx has the action name and ANONYMOUS). Switching serializers per REQUEST still
    // works at runtime but cannot change the advertised schema.
    const bootCtx = (a: GeneratedAction): ViewCtx =>
      ({ action: a, actionId: a, params: {}, request: { user: ANONYMOUS, query: new URLSearchParams() } } as unknown as ViewCtx)
    const inputFor = (ctx: ViewCtx) => {
      try { return inputOf(model, gv.getSerializer.call(Object.create(gv), ctx)) } catch (e) { return fail((e as Error).message) }
    }
    const actions = (V as unknown as typeof GenericView).actions
    const updIn = actions.includes('update') ? inputFor(bootCtx('update')).schema : undefined
    if (updIn && Object.hasOwn(updIn.shape, gv.lookupParam)) {
      fail(gv.lookupParam === gv.lookupField
        ? `lookup by writable field "${gv.lookupField}": set lookupParam (e.g. 'key') to make ${gv.lookupField} updatable, or list it in readOnlyFields`
        : `lookupParam "${gv.lookupParam}" collides with the writable field "${gv.lookupParam}"; rename the param`)
    }
    const schemas = {
      list: () => listSchema, get: () => lookupObj.strict(), delete: () => lookupObj.strict(),
      create: () => inputFor(bootCtx('create')).schema,
      update: () => lookupObj.merge(updIn!.partial()).strict(),
    } satisfies Record<GeneratedAction, () => z.ZodTypeAny>

    const rulesFor: Record<GeneratedAction, ActionRules> = {
      list: { readOnly: true }, get: { readOnly: true }, create: {}, update: {}, delete: { destructive: true },
    }
    type Self = GenericView
    const out = (v: Self, ctx: ViewCtx, obj: object) => v.getSerializer(ctx).output(obj, v.getSerializerContext(ctx))
    const bodies: Record<GeneratedAction, (v: Self, raw: unknown, ctx: ViewCtx) => Promise<unknown>> = {
      list: async (v, raw, ctx) => {
        ctx.params = validate(listSchema, raw, true)
        const page = await v.paginateQueryset(v.filterQueryset(v.getQueryset(ctx), ctx), ctx)
        return { ...page, items: page.items.map(o => out(v, ctx, o)) }
      },
      get: async (v, raw, ctx) => {
        ctx.params = validate(lookupObj.strict(), raw, true)
        return out(v, ctx, await v.getObject(ctx))
      },
      create: async (v, raw, ctx) => {
        const { schema, readOnly } = inputOf(model, v.getSerializer(ctx))
        ctx.params = validate(schema, raw, false, readOnly)
        return out(v, ctx, await v.performCreate(ctx.params, ctx))
      },
      update: async (v, raw, ctx) => {
        const { [gv.lookupParam]: key, ...rest } = (raw ?? {}) as Record<string, unknown>
        ctx.params = validate(lookupObj, { [gv.lookupParam]: key }, true)
        const { schema, readOnly } = inputOf(model, v.getSerializer(ctx))
        const data = validate(schema.partial(), rest, false, readOnly)
        const obj = await v.getObject(ctx)
        return out(v, ctx, await v.performUpdate(obj, data, ctx))
      },
      delete: async (v, raw, ctx) => {
        ctx.params = validate(lookupObj.strict(), raw, true)
        await v.performDestroy(await v.getObject(ctx), ctx)
        return null
      },
    }
    // permissions run first (DRF initial()), before params are validated or anything is read
    for (const a of actions) {
      const def: ActionDef = {
        id: a, schema: schemas[a](), rules: withPerms(rulesFor[a]),
        run: async (raw, ctx) => {
          const self = Object.create(gv) as Self
          const vctx: ViewCtx = { ...ctx, action: a, actionId: def.id, params: {} }
          await self.checkPermissions(vctx)
          return bodies[a](self, raw, vctx)
        },
      }
      generatedName.set(def, a)
      defs.push(def)
    }
  }

  // @action methods anywhere on the prototype chain (the most-derived implementation runs)
  const seen = new Set<string>()
  for (let p = Object.getPrototypeOf(view); p && p !== View.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) {
      if (seen.has(key) || key === 'constructor') continue
      seen.add(key)
      const fn = (view as unknown as Record<string, unknown>)[key]
      const meta = typeof fn === 'function' ? decorated.get(fn) : undefined
      if (!meta) continue
      const def: ActionDef = {
        id: key, schema: meta.schema, rules: withPerms(meta.opts.rules, meta.opts.permissions),
        run: async (raw, ctx) => {
          const self = Object.create(view) as View
          const vctx: ViewCtx = { ...ctx, action: key, actionId: def.id, params: {} }
          if (self instanceof GenericView) await self.checkPermissions(vctx)
          vctx.params = validate(meta.schema, raw)
          return (fn as (p: unknown, c: ViewCtx) => Promise<unknown>).call(self, vctx.params, vctx)
        },
      }
      defs.push(def)
    }
  }
  return defs
}
