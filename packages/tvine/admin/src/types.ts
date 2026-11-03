// The admin API shapes (docs/design/contrib/admin.md §2). The UI reads only these, through api.*.
export type Perms = { view: boolean; add: boolean; change: boolean; delete: boolean }
export type SiteModel = { key: string; name: string; namePlural: string; perms: Perms }
export type SiteApp = { label: string; name: string; models: SiteModel[] }
export type SitePage = { path: string; title: string; icon?: string; section?: string; component: string }
export type SiteWidget = { id: string; title: string; size?: 'sm' | 'md' | 'lg'; data?: { id: string; params?: Record<string, unknown> } | string; component?: string }
export type Theme = { brand?: string; radius?: string | number; dark?: 'auto' | 'on' | 'off' }
export type Site = {
  header: string; title: string; indexTitle: string; siteUrl?: string; theme?: Theme
  apps: SiteApp[]; pages?: SitePage[]; widgets?: SiteWidget[]
}

export type Choice = { value: string; label: string }
// Form shapes are shared with tvine/forms (part C) — one definition.
import type { FieldKind, FieldMeta, FormMeta, InlineMeta } from '../../weft/dist/forms/index.js'
export type { FieldKind, FieldMeta, FormMeta, InlineMeta }
export type Fieldset = FormMeta['fieldsets'][number]
export type Column = { name: string; label: string; sortable: boolean; kind?: string }
export type FilterMeta = { name: string; label: string; kind: 'choice' | 'boolean' | 'date' | 'related' | 'custom'; choices?: Choice[] }
export type ActionMeta = { name: string; description: string; confirm?: boolean | string }
export type ModelMeta = {
  key: string; name: string; namePlural: string; pk: string
  display: {
    listDisplay: Column[]; listDisplayLinks?: string[]; listEditable?: string[]; listPerPage?: number
    dateHierarchy?: string | null; searchHelp?: string | null; emptyValueDisplay?: string; actions: ActionMeta[]
    filters: FilterMeta[]; search?: boolean; listMaxShowAll?: number
  }
  form: FormMeta; perms: Perms; urls?: { name: string; path: string; title: string }[]
}
export type Display = string | number | boolean | null | { text: string; href?: string; value?: unknown }
export type Row = { pk: string; values: Record<string, Display> }
export type Facet = { value: string; label: string; count: number }
export type ListResult = { rows: Row[]; count: number; page: number; pages: number; facets?: Record<string, Facet[]> }
export type ObjectData = { pk: string; values: Record<string, unknown>; display: string; inlines?: Record<string, { rows: Record<string, unknown>[] }>; perms?: Perms }
// admin.deletePreview: objects = the cascade tree, protected = rows that block the delete
export type DeleteNode = { model: string; pk: string; repr: string; children?: DeleteNode[]; field?: string }
export type DeletePreview = { objects: DeleteNode[]; protected?: DeleteNode[]; summary?: Record<string, number>; permsNeeded?: string[] }
// changeMessage = a JSON list: [{added:{}}, {changed:{fields:[…]}}, {deleted:{…}}, {action:'markShipped'}]
export type LogEntry = { id: string | number; actionTime: string; user: { id: string; name: string }; actionFlag: number; action: 'add' | 'change' | 'delete' | string; objectRepr?: string; changeMessage?: unknown }
export type ActionResult = { message?: string; level?: 'success' | 'info' | 'warning' | 'error'; download?: string | { url?: string; data?: string; filename?: string; contentType?: string } }
export type FieldErrors = Record<string, string>
export type User = { id: string; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }
