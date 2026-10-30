// Class-based generic views (DRF generics + mixins). Spec: docs/design/conventions/generic-views.md
// A view class exported from apps/<app>/views.ts is instantiated ONCE at discovery; every request
// gets a fresh ViewCtx (action + params), so hooks never keep per-request state on `this`.
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
  input?: z.ZodType                                 // create/update params (update applies .partial())
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
const num = z.preprocess(v => (typeof v === 'string' ? Number(v) : v), z.number())
function valueSchema(f: AnyField): z.ZodTypeAny {
  switch (f.kind) {
    case 'id': case 'int': case 'float': case 'money': return num    // money compares in cents
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
function validate(schema: z.ZodTypeAny, raw: unknown, url = false): Record<string, unknown> {
  const input = url && raw && typeof raw === 'object'
    ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined))   // empty form field = absent
    : raw
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const i = r.error.issues[0]
  const field = i.code === 'unrecognized_keys' ? i.keys[0] : String(i.path[0] ?? '')
  throw new DomainError('invalid_param', i.code === 'unrecognized_keys' ? `unknown param "${field}"` : `${field}: ${i.message}`, field)
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

  async checkPermissions(ctx: ViewCtx): Promise<void> {
    const r = ctx.request
    const pctx: PermissionCtx = {
      sid: ctx.sid, session: ctx.session, action: ctx.actionId, route: r?.route ?? '',
      user: r?.user ?? ANONYMOUS, agent: r?.agent, ip: r?.ip ?? '',
    }
    for (const p of this.getPermissions(ctx)) {
      if (!(await p(pctx))) throw new DomainError('forbidden', `not allowed: ${ctx.action}`)
    }
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

  // Page-component helper: `await ProductList.queryset(searchParams)` → serialized Paginated.
  // Without a ctx the hooks see ANONYMOUS and request.query only.
  static async queryset<V extends GenericView>(
    this: (new () => V) & typeof GenericView,
    searchParams: URLSearchParams | Record<string, string | string[] | undefined>,
    ctx?: ActionCtx,
  ): Promise<Paginated<Out>> {
    let list = listDefs.get(this)
    if (!list) {
      list = viewActions(this).find(d => d.id === 'list')
      if (!list) throw new Error(`${this.name} has no list action`)
      listDefs.set(this, list)
    }
    const query = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams()
    const params: Record<string, string> = {}
    if (searchParams instanceof URLSearchParams) for (const k of new Set(query.keys())) params[k] = query.getAll(k).join(',')
    else for (const [k, v] of Object.entries(searchParams)) if (v !== undefined) params[k] = Array.isArray(v) ? v.join(',') : v
    return list.run(params, ctx ?? ({ request: { query, user: ANONYMOUS } } as unknown as ActionCtx)) as Promise<Paginated<Out>>
  }
}
const listDefs = new WeakMap<Function, ActionDef>()

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

const defaultSerializers = new WeakMap<GenericView, Serializer<any>>()
function defaultSerializer<T extends object>(v: GenericView<T>): Serializer<T> {
  let s = defaultSerializers.get(v)
  if (!s) {
    const hidden = new Set(Object.entries(v.model.fields as Record<string, AnyField>).filter(([, f]) => f.opts.hidden).map(([n, f]) => f.key(n)))
    const shape = v.shapers?.[v.model.name]
    s = {
      input: createInput(v.model),
      output: (obj: T) => {
        const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !hidden.has(k)))
        return shape ? shape(out) : out
      },
    }
    defaultSerializers.set(v, s)
  }
  return s
}

// model.schema minus id/uuid/auto fields; defaulted fields optional; unknown keys rejected
function createInput(model: Model<any, any>): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {}
  for (const [n, f] of Object.entries(model.fields as Record<string, AnyField>)) {
    if (f.kind === 'id' || f.kind === 'uuid' || f.opts.auto) continue
    shape[f.key(n)] = hasDefault(f) ? f.schema().optional() : f.schema()
  }
  return z.object(shape).strict()
}
const partialOf = (s: z.ZodTypeAny): z.ZodTypeAny => (s instanceof z.ZodObject ? s.partial() : s)

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
    for (const f of effectiveSearch(gv)) need('searchFields', f)
    for (const f of gv.ordering) need('ordering', f)
    const lookupF = need('lookupField', gv.lookupField)
    const lookups: z.ZodRawShape = {}
    for (const l of effectiveFilters(gv)) {
      const { field, op } = parseLookup(l)
      if (!op) fail(`filter "${l}": unknown lookup (use exact, __lt, __lte, __gt, __gte, __in, __contains, __ne)`)
      lookups[l] = lookupSchema(need(`filter "${l}"`, field), op!).optional()
    }
    const sorts = gv.ordering.flatMap(f => [f, `-${f}`])
    const listSchema = z.object({
      ...(effectiveSearch(gv).length && { q: z.string().optional() }),
      ...(sorts.length && { sort: z.enum(sorts as [string, ...string[]]).optional() }),
      cursor: z.string().refine(c => { try { decodeCursor(c); return true } catch { return false } }, 'invalid cursor').optional(),
      ...lookups,
    }).strict()
    const lookupObj = z.object({ [gv.lookupParam]: valueSchema(lookupF) })
    const input = gv.serializer?.input ?? createInput(model)
    const schemas: Record<GeneratedAction, z.ZodTypeAny> = {
      list: listSchema, get: lookupObj.strict(), delete: lookupObj.strict(), create: input,
      update: input instanceof z.ZodObject ? lookupObj.merge(input.partial()) : lookupObj.passthrough(),
    }

    const rulesFor: Record<GeneratedAction, ActionRules> = {
      list: { readOnly: true }, get: { readOnly: true }, create: {}, update: {}, delete: { destructive: true },
    }
    const out = (ctx: ViewCtx, obj: object) => gv.getSerializer(ctx).output(obj, gv.getSerializerContext(ctx))
    const bodies: Record<GeneratedAction, (raw: unknown, ctx: ViewCtx) => Promise<unknown>> = {
      list: async (raw, ctx) => {
        ctx.params = validate(listSchema, raw, true)
        const page = await gv.paginateQueryset(gv.filterQueryset(gv.getQueryset(ctx), ctx), ctx)
        return { ...page, items: page.items.map(o => out(ctx, o)) }
      },
      get: async (raw, ctx) => {
        ctx.params = validate(lookupObj.strict(), raw, true)
        return out(ctx, await gv.getObject(ctx))
      },
      create: async (raw, ctx) => {
        ctx.params = validate(gv.getSerializer(ctx).input ?? input, raw)
        return out(ctx, await gv.performCreate(ctx.params, ctx))
      },
      update: async (raw, ctx) => {
        const { [gv.lookupParam]: _id, ...rest } = (raw ?? {}) as Record<string, unknown>
        ctx.params = validate(lookupObj, { [gv.lookupParam]: _id }, true)
        const data = validate(partialOf(gv.getSerializer(ctx).input ?? input), rest)
        const obj = await gv.getObject(ctx)
        return out(ctx, await gv.performUpdate(obj, data, ctx))
      },
      delete: async (raw, ctx) => {
        ctx.params = validate(lookupObj.strict(), raw, true)
        await gv.performDestroy(await gv.getObject(ctx), ctx)
        return null
      },
    }
    // permissions run first (DRF initial()), before params are validated or anything is read
    for (const a of (V as unknown as typeof GenericView).actions) {
      const def: ActionDef = {
        id: a, schema: schemas[a], rules: withPerms(rulesFor[a]),
        run: async (raw, ctx) => {
          const vctx: ViewCtx = { ...ctx, action: a, actionId: def.id, params: {} }
          await gv.checkPermissions(vctx)
          return bodies[a](raw, vctx)
        },
      }
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
      const check = view instanceof GenericView ? (c: ViewCtx) => view.checkPermissions(c) : async () => {}
      const def: ActionDef = {
        id: key, schema: meta.schema, rules: withPerms(meta.opts.rules, meta.opts.permissions),
        run: async (raw, ctx) => {
          const vctx: ViewCtx = { ...ctx, action: key, actionId: def.id, params: {} }
          await check(vctx)
          vctx.params = validate(meta.schema, raw)
          return (fn as (p: unknown, c: ViewCtx) => Promise<unknown>).call(view, vctx.params, vctx)
        },
      }
      defs.push(def)
    }
  }
  return defs
}
