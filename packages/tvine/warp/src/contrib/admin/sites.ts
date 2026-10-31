// AdminSite (Django django.contrib.admin.sites): the registry, site options, custom pages/widgets, and
// autodiscover of apps/<app>/admin.ts at boot. docs/design/contrib/admin.md §1.
import { appModule, importApp } from '../../core/actions.js'
import { installedApps } from '../../core/apps.js'
import type { ActionDef } from '../../core/types.js'
import type { Fields, ModelDef } from '../../data/fields/index.js'
import { discoverModels } from '../../data/migrate.js'
import type { Model } from '../../data/model.js'
import { relationOf } from '../../data/registry.js'
import { include, path, type UrlEntry, type UrlPattern } from '../../urls.js'
import { staffGuard } from './hardening.js'
import { isFilterClass, ModelAdmin, type InlineModelAdmin } from './options.js'

type AnyModel = Model<any, any>
export interface AdminPage { path: string; title: string; icon?: string; section?: string; component: string; permission?: string }
// data: an action (the UI calls it), or a function the dashboard runs through admin.widget with the chosen range
// (return ChartData, { value, previous? } or { columns, rows }). type picks the renderer; refreshMs = its auto-refresh.
export interface AdminWidget {
  id: string; title: string; size: 'sm' | 'md' | 'lg' | 'xl'; data?: ActionDef | ((ctx: any, p: { range?: unknown }) => unknown)
  type?: 'line' | 'area' | 'bar' | 'stacked' | 'donut' | 'stat' | 'table' | 'custom'; refreshMs?: number; component?: string; permission?: string
}

export class AlreadyRegistered extends Error { name = 'AlreadyRegistered' }
export class NotRegistered extends Error { name = 'NotRegistered' }

export class AdminSite {
  siteHeader = 'Tvine administration'
  siteTitle = 'Tvine site admin'
  indexTitle = 'Site administration'
  siteUrl = '/'
  readonly pages: AdminPage[] = []
  readonly widgets: AdminWidget[] = []
  private readonly reg = new Map<AnyModel, ModelAdmin>()
  private readonly labels = new Map<string, string>()   // model name → app label (from discoverModels)
  private urlCache = new Map<ModelAdmin, { entries: UrlEntry[]; defs: ActionDef[] }>()

  register(models: AnyModel | AnyModel[], adminClass: new () => ModelAdmin = ModelAdmin): void {
    for (const model of Array.isArray(models) ? models : [models]) {
      if (this.reg.has(model)) throw new AlreadyRegistered(`The model ${model.name} is already registered`)
      const a = new adminClass()
      a.model = model
      for (const I of a.inlines) { const i = new I(); if (!i.model) throw new Error(`${I.name}: set model`) }
      this.reg.set(model, a)
    }
  }
  unregister(model: AnyModel): void {
    if (!this.reg.delete(model)) throw new NotRegistered(`The model ${model.name} is not registered`)
  }
  isRegistered(model: AnyModel): boolean { return this.reg.has(model) }
  registerPage(p: AdminPage): void { this.pages.push(p) }
  registerWidget(w: AdminWidget): void { this.widgets.push(w) }

  // '<app>.<model>': the app whose models.ts exports it; the model name without its '<app>_' prefix
  keyOf(def: ModelDef): string {
    const app = this.labels.get(def.name) ?? (def.name.includes('_') ? def.name.split('_')[0]! : def.name)
    return `${app}.${def.name.startsWith(`${app}_`) ? def.name.slice(app.length + 1) : def.name}`
  }
  admins(): ModelAdmin[] {
    for (const a of this.reg.values()) a._key = this.keyOf(a.model)
    return [...this.reg.values()]
  }
  adminFor(key: string): ModelAdmin | undefined { return this.admins().find((a) => a._key === key) }
  inlinesOf(a: ModelAdmin): InlineModelAdmin[] {
    return a.inlines.map((I) => { const i = new I(); i._key = this.keyOf(i.model); return i })
  }

  setLabels(models: Record<string, AnyModel[]>): void {
    for (const [app, ms] of Object.entries(models)) for (const m of ms) this.labels.set(m.name, app)
  }

  // getUrls() of every admin, once: the routes (urls.ts) and the action defs they run (registered at discovery)
  private custom(a: ModelAdmin): { entries: UrlEntry[]; defs: ActionDef[] } {
    let c = this.urlCache.get(a)
    if (c) return c
    const [app, model] = a._key.split('.')
    const entries = a.getUrls()
    const defs: ActionDef[] = []
    const walk = (es: UrlEntry[]) => {
      for (const e of es) {
        if (e.kind === 'include') { if (Array.isArray(e.module)) walk(e.module); continue }
        const def = (e as UrlPattern).view as ActionDef
        def.name = `admin.${app}_${model}_${e.name ?? def.name}`
        // a raw def (not this.view()) is staff-only like the rest of the admin; `public: true` on the def opts out
        const perms = def.rules?.permissions ?? []
        if (!(def as { public?: boolean }).public && !perms.includes(staffGuard)) def.rules = { ...def.rules, permissions: [staffGuard, ...perms] }
        defs.push(def)
      }
    }
    walk(entries)
    this.urlCache.set(a, (c = { entries, defs }))
    return c
  }
  customViews(): ActionDef[] { return this.admins().flatMap((a) => this.custom(a).defs) }
  customUrls(): UrlEntry[] {
    return this.admins().filter((a) => this.custom(a).entries.length).map((a) => {
      const [app, model] = a._key.split('.')
      return path(`${app}/${model}/`, include(this.custom(a).entries, { namespace: `${app}_${model}` }))
    })
  }
  customUrlMeta(a: ModelAdmin): { name: string; path: string; title: string }[] {
    const out: { name: string; path: string; title: string }[] = []
    for (const e of this.custom(a).entries) if (e.kind === 'path') {
      const d = e.view as ActionDef & { title?: string }
      out.push({ name: e.name ?? d.name!, path: e.route, title: d.title ?? e.name ?? d.name! })
    }
    return out
  }

  // Django system checks for every registered admin: unknown names fail at boot, naming the class
  check(): void {
    for (const a of this.admins()) {
      const where = `${a.constructor.name} (${a._key})`
      const fields = a.model.fields
      const has = (n: string) => n in fields
      const display = new Set(a.listDisplay.map((c) => (typeof c === 'string' ? c : c.name)))
      for (const c of a.listDisplay) {
        if (typeof c !== 'string' || c === '__str__' || typeof (a as unknown as Record<string, unknown>)[c] === 'function') continue
        if (!has(c)) throw new Error(`${where}.listDisplay: "${c}" is not a field or a method`)
        if (fields[c]!.kind === 'm2m') throw new Error(`${where}.listDisplay: "${c}" is a many-to-many field`)
      }
      for (const c of a.listEditable) if (!display.has(c) || !has(c) || (a.listDisplayLinks ?? [[...display][0]]).includes(c)) throw new Error(`${where}.listEditable: "${c}" must be a field in listDisplay and not a link`)
      for (const f of a.listFilter) if (!isFilterClass(f) && !has(f)) throw new Error(`${where}.listFilter: "${String(f)}" is not a field`)
      for (const s of a.searchFields) {
        const p = s.replace(/^[\^=@]/, '').split('__')
        if (!has(p[0]!) && !relationOf(a.model, p[0]!)) throw new Error(`${where}.searchFields: "${s}" does not start with a field`)
        if (p.length === 1 && fields[p[0]!]?.kind === 'money') throw new Error(`${where}.searchFields: "${s}" is a money field`)
      }
      if (a.dateHierarchy && fields[a.dateHierarchy]?.kind !== 'datetime' && fields[a.dateHierarchy]?.kind !== 'date') throw new Error(`${where}.dateHierarchy: "${a.dateHierarchy}" is not a date or datetime field`)
      for (const n of [...a.autocompleteFields, ...a.rawIdFields]) if (!['fk', 'm2m'].includes(fields[n]?.kind ?? '')) throw new Error(`${where}: "${n}" is not a foreign key or many-to-many field`)
      for (const n of [...(a.fields ?? []), ...a.exclude, ...(a.fieldsets ?? []).flatMap(([, f]) => f.fields)]) {
        if (!has(n) && !a.readonlyFields.includes(n)) throw new Error(`${where}: "${n}" is not a field`)
      }
      for (const i of this.inlinesOf(a)) if (!fkTo(i, a.model)) throw new Error(`${where}: ${i.constructor.name} has no foreign key to ${a.model.name}`)
    }
  }
}

// the inline model's fk to the parent (fkName or the only one)
export function fkTo(i: InlineModelAdmin, parent: AnyModel): string | undefined {
  const fks = Object.entries(i.model.fields as Fields).filter(([n, f]) => f.kind === 'fk' && f.target!().name === parent.name && (!i.fkName || i.fkName === n))
  return fks.length === 1 ? fks[0]![0] : undefined
}

export const site = new AdminSite()

// @admin.register(Order) (TC39 or legacy class decorator) — or admin.site.register(Order, OrderAdmin)
export function register(...models: AnyModel[]) {
  return <C extends new () => ModelAdmin>(cls: C, _ctx?: unknown): C => { site.register(models, cls); return cls }
}

// Django autodiscover(): app labels for every model, then each installed app's admin module (project apps,
// then contrib — tvine.auth / tvine.tasks register theirs). Returns the custom views' action defs.
let found: Promise<ActionDef[]> | undefined
const seen = new Set<string>()
export async function autodiscover(appsDir: string, installed: readonly string[] = []): Promise<ActionDef[]> {
  const key = `${appsDir}\0${installed.join(',')}`
  if (found && seen.has(key)) return found
  seen.add(key)
  return (found = (async () => {
    try { site.setLabels(await discoverModels(appsDir, { installed })) } catch { /* no models: nothing to label */ }
    for (const { dir } of installedApps(appsDir, installed)) {
      const f = appModule(dir, 'admin')
      if (f) await importApp(f)
    }
    site.check()
    return site.customViews()
  })())
}
