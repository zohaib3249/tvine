// ModelAdmin and friends. docs/design/contrib/admin.md §1.
// Option values are developer config (trusted); request params are checked against them (views.ts).
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, ActionDef } from '../../core/types.js'
import type { Model } from '../../data/model.js'
import type { QuerySet } from '../../data/queryset.js'
import { permCodename } from '../../security/permissions.js'
import { staffGuard } from './hardening.js'
import type { UrlEntry } from '../../urls.js'
import type { FieldMeta } from './meta.js'

export type Ctx = ActionCtx
export type Perm = 'view' | 'add' | 'change' | 'delete'
type AnyModel = Model<any, any>

// ---- @display ---------------------------------------------------------------------------------------
export interface DisplayOpts { description?: string; ordering?: string; boolean?: boolean; emptyValue?: string }
const DISPLAY = Symbol.for('tvine.admin.display')
type Displayed = { [DISPLAY]?: DisplayOpts }
// method decorator (TC39 or legacy) or a plain wrapper: display({ description })(fn)
export function display(o: DisplayOpts) {
  return <F>(target: F, _ctx?: unknown, desc?: PropertyDescriptor): F => {
    const fn = (desc ? desc.value : target) as Displayed
    fn[DISPLAY] = o
    return (desc ?? target) as F
  }
}
export const displayOf = (fn: unknown): DisplayOpts | undefined => (fn as Displayed | undefined)?.[DISPLAY]

// ---- actions ----------------------------------------------------------------------------------------
export interface ActionResult { message?: string; level?: 'info' | 'success' | 'warning' | 'error'; download?: string | { url?: string; data?: string; filename: string; contentType: string } }   // a url, or inline data (text / base64)
// queryset = the selected rows (getQueryset-scoped); pks = their primary keys as strings
export type AdminActionFn = (admin: ModelAdmin, ctx: Ctx, queryset: QuerySet<any>, pks: string[]) => Promise<void | ActionResult>
// permissions: 'view' | 'add' | 'change' | 'delete' or any name X → ModelAdmin.hasXPermission(ctx)
export interface AdminActionOpts { name?: string; description?: string; permissions?: string[]; confirm?: boolean | string; humanOnly?: boolean }
export interface AdminAction extends AdminActionOpts { name: string; fn: AdminActionFn }

const camel = (s: string) => s.replace(/[^\w ]/g, '').trim().split(/\s+/).map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase())).join('')
export function adminAction(o: AdminActionOpts, fn: AdminActionFn): AdminAction {
  const name = o.name ?? (fn.name || camel(o.description ?? ''))
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`adminAction: give it a name (${JSON.stringify(name)} is not one)`)
  return { ...o, name, description: o.description ?? name, fn }
}
export const isAdminAction = (v: unknown): v is AdminAction => !!v && typeof v === 'object' && typeof (v as AdminAction).fn === 'function' && typeof (v as AdminAction).name === 'string'

// ---- list filters -------------------------------------------------------------------------------------
// a custom list filter: lookups() → [value, label] pairs; queryset() narrows for this.value().
export abstract class SimpleListFilter {
  title = ''
  parameterName = ''
  constructor(private readonly current: string | null = null) {}
  value(): string | null { return this.current }
  abstract lookups(ctx: Ctx, admin: ModelAdmin): [string, string][] | Promise<[string, string][]>
  abstract queryset(ctx: Ctx, qs: QuerySet<any>): QuerySet<any> | undefined | Promise<QuerySet<any> | undefined>
}
export type ListFilterClass = new (value?: string | null) => SimpleListFilter
export const isFilterClass = (v: unknown): v is ListFilterClass => typeof v === 'function' && v.prototype instanceof SimpleListFilter

// ---- shared permission defaults (has*Permission) ----------------------------------------------------
export interface Labelled { model: AnyModel; key(): string; app(): string }
async function modelPerm(ctx: Ctx, admin: Labelled, p: Perm): Promise<boolean> {
  const u = ctx.request.user
  if (!(u.isStaff === true && u.isActive !== false)) return false   // the per-model check; staffGuard already ran on the action
  if (u.isSuperuser) return true
  return !!u.hasPerm && (await u.hasPerm(permCodename(admin.app(), p, admin.model.name)))
}

export interface Fieldset { fields: string[]; classes?: string[]; description?: string }

abstract class BaseAdmin implements Labelled {
  model!: AnyModel
  fields: string[] | null = null
  exclude: string[] = []
  readonlyFields: string[] = []
  autocompleteFields: string[] = []
  rawIdFields: string[] = []
  ordering: string[] | null = null
  formfieldOverrides: Record<string, Partial<FieldMeta>> = {}   // by field name or ORM kind ('text': { kind: 'textarea' })
  widgets: Record<string, FieldMeta['kind']> = {}                // by field name: { status: 'segmented' } (radios), { notes: 'markdown' }
  verboseName: string | null = null
  verboseNamePlural: string | null = null
  /** @internal set by the site */ _key = ''
  key(): string { return this._key }
  app(): string { return this._key.split('.')[0]! }

  // the display string of a row
  str(obj: Record<string, unknown>): string {
    for (const k of ['name', 'title', 'username', 'email', 'label']) if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string
    return `${this.verboseName ?? this.key().split('.')[1]} object (${String(obj.id)})`
  }
  // getQueryset (ModelAdmin and InlineModelAdmin): every read and write of the admin goes through it
  // (scope rows per user here)
  getQueryset(_ctx: Ctx): QuerySet<any> { return this.model.objects }
  getReadonlyFields(_ctx: Ctx, _obj?: object): string[] { return this.readonlyFields }
  hasViewPermission(ctx: Ctx, _obj?: object): boolean | Promise<boolean> {
    return (async () => (await modelPerm(ctx, this, 'view')) || (await modelPerm(ctx, this, 'change')))()
  }
  hasAddPermission(ctx: Ctx, _obj?: object): boolean | Promise<boolean> { return modelPerm(ctx, this, 'add') }
  hasChangePermission(ctx: Ctx, _obj?: object): boolean | Promise<boolean> { return modelPerm(ctx, this, 'change') }
  hasDeletePermission(ctx: Ctx, _obj?: object): boolean | Promise<boolean> { return modelPerm(ctx, this, 'delete') }
}

// ---- inlines ----------------------------------------------------------------------------------------
export abstract class InlineModelAdmin extends BaseAdmin {
  abstract readonly kind: 'tabular' | 'stacked'
  fkName: string | null = null      // which fk to the parent (when the inline model has several)
  extra = 3
  maxNum: number | null = null
  minNum = 0
  canDelete = true
  name: string | null = null        // the formset key in admin.get / create / update (default: the model's short name)
}
export class TabularInline extends InlineModelAdmin { readonly kind = 'tabular' as const }
export class StackedInline extends InlineModelAdmin { readonly kind = 'stacked' as const }
export type InlineClass = new () => InlineModelAdmin

// ---- ModelAdmin -------------------------------------------------------------------------------------
export interface ListParams { q?: string; filters?: Record<string, string>; ordering?: string[]; page?: number; pageSize?: number; all?: boolean }
export interface AdminView { def: ActionDef; title?: string }

// one chart of a model (charts.ts): a time series of `aggregate(field)` on the date field, or a breakdown `by` a
// choice / boolean / foreign-key field (top N). type 'stat' = the total over the range with the previous period.
export interface ChartSpec {
  id?: string; title?: string
  type: 'line' | 'area' | 'bar' | 'stacked' | 'donut' | 'stat' | 'table'
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; by?: string; date?: string
  range?: '24h' | '7d' | '30d' | '90d' | '1y'; size?: 'sm' | 'md' | 'lg' | 'xl'; dashboard?: boolean
}
export class ModelAdmin<T extends object = any> extends BaseAdmin {
  listDisplay: (string | ((obj: T) => unknown))[] = ['__str__']
  listDisplayLinks: string[] | null = null
  listEditable: string[] = []
  listPerPage = 100
  listMaxShowAll = 200
  listFilter: (string | ListFilterClass)[] = []
  showFacets = true
  searchFields: string[] = []
  searchHelpText: string | null = null
  dateHierarchy: string | null = null
  sortableBy: string[] | null = null
  fieldsets: [string | null, Fieldset][] | null = null
  inlines: InlineClass[] = []
  saveOnTop = false
  showFullResultCount = true
  emptyValueDisplay = '-'
  actions: (AdminAction | string)[] = []
  actionsOnTop = true
  // false: agent-marked requests are refused for this model (owner ruling); 'confirm': an agent's writes answer
  // confirm_required by 'human' (the user must do it) — the default for auth.User / auth.Group (secreview-3 M3)
  agents: boolean | 'confirm' = true
  // dashboard + changelist charts (charts.ts): null = the automatic ones from the fields, false = none, or your own list
  charts: ChartSpec[] | false | null = null

  // getObject: undefined = not found (or outside getQueryset)
  async getObject(ctx: Ctx, pk: string | number): Promise<T | undefined> {
    return (await this.getQueryset(ctx).filter({ id: pk }).first()) as T | undefined
  }
  // changelist override point (the tasks Job admin lists from the broker); undefined = the ORM changelist
  changelist?(ctx: Ctx, p: ListParams): Promise<{ rows: T[]; count: number }>
  hasModulePermission(ctx: Ctx): boolean | Promise<boolean> {
    return (async () => {
      for (const p of ['view', 'add', 'change', 'delete'] as const) if (await modelPerm(ctx, this, p)) return true
      return false
    })()
  }
  // saveModel / deleteModel: values are validated, keyed by row property (fk → `<name>Id`)
  async saveModel(_ctx: Ctx, obj: T | undefined, values: Record<string, unknown>): Promise<T> {
    const m = this.model as AnyModel
    return (obj ? await m.update((obj as { id: string | number }).id, values) : await m.create(values)) as T
  }
  async deleteModel(_ctx: Ctx, obj: T): Promise<void> { await (this.model as AnyModel).delete((obj as { id: string | number }).id) }
  getActions(_ctx: Ctx): AdminAction[] {
    const out: AdminAction[] = [deleteSelected]
    for (const a of this.actions) {
      if (typeof a !== 'string') { out.push(a); continue }
      const fn = (this as unknown as Record<string, unknown>)[a]
      if (typeof fn !== 'function') throw new Error(`${this.constructor.name}.actions: no method "${a}"`)
      out.push({ name: a, description: displayOf(fn)?.description ?? a, fn: (_ad, ctx, qs, pks) => fn.call(this, ctx, qs, pks) })
    }
    return out
  }
  // getUrls: custom admin views under <admin urls>/<app>/<model>/ (contrib/admin/urls.ts)
  getUrls(): UrlEntry[] { return [] }
  // adminView(): a staff-only action around fn(params, ctx); needs view permission on the
  // model unless opts.permission names another (or a hasXPermission method)
  view(fn: (params: Record<string, unknown>, ctx: Ctx) => Promise<unknown>, opts: { readOnly?: boolean; permission?: string; title?: string } = {}): ActionDef {
    const admin = this
    const def = defineAction(fn.name || 'view', z.record(z.unknown()), async (params, ctx) => {
      if (!(await checkPerm(admin, ctx, opts.permission ?? 'view'))) throw new DomainError('forbidden', 'forbidden: not allowed')
      if (admin.agents === false && ctx.request.agent.is) throw new DomainError('forbidden', 'forbidden: not for agents')
      return fn.call(admin, params, ctx)
    }, { permissions: [staffGuard], ...(opts.readOnly ? { readOnly: true } : { confirm: (_p: unknown, ctx: ActionCtx) => (admin.agents === 'confirm' && ctx.request.agent.is ? { by: 'human' as const } : undefined) }) })
    if (opts.title) (def as { title?: string }).title = opts.title
    return def
  }
}

// a named permission check: view/add/change/delete or hasXPermission(ctx, obj)
export async function checkPerm(admin: BaseAdmin, ctx: Ctx, p: string, obj?: object): Promise<boolean> {
  const fn = (admin as unknown as Record<string, unknown>)[`has${p[0]!.toUpperCase()}${p.slice(1)}Permission`]
  if (typeof fn !== 'function') throw new Error(`${admin.constructor.name}: no has${p[0]!.toUpperCase()}${p.slice(1)}Permission for an action permission "${p}"`)
  return !!(await fn.call(admin, ctx, obj))
}

// the built-in action; views.ts runs it through the same delete path as admin.delete (PROTECT → nothing deleted)
export const deleteSelected: AdminAction = {
  name: 'deleteSelected', description: 'Delete selected', permissions: ['delete'], confirm: true,
  fn: async () => { throw new Error('deleteSelected runs in views.ts') },
}
