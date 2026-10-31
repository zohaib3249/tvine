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
export type FieldKind =
  | 'text' | 'textarea' | 'email' | 'url' | 'slug' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'datetime' | 'time'
  | 'duration' | 'uuid' | 'json' | 'choice' | 'fk' | 'm2m' | 'file' | 'image' | 'password' | 'rich'
export type FieldMeta = {
  name: string; label: string; help?: string; kind: FieldKind; required: boolean; readOnly: boolean; nullable: boolean
  default?: unknown; choices?: Choice[]; max?: number; min?: number; maxLength?: number; decimals?: number; currency?: string
  multiple?: boolean; relation?: { model: string; autocomplete: boolean; rawId: boolean }; upload?: { accept: string; maxBytes: number }
}
export type Fieldset = { title: string | null; classes?: string[]; fields: string[] }
export type InlineMeta = {
  name: string; kind: 'tabular' | 'stacked'; model: string; fk: string; fields: string[]; extra: number; max?: number; min?: number
  canDelete: boolean; meta: { fields: Record<string, FieldMeta> } & Partial<FormMeta>
}
export type FormMeta = { fieldsets: Fieldset[]; fields: Record<string, FieldMeta>; inlines: InlineMeta[] }
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
export type DeleteNode = { label: string; model?: string; pk?: string; children?: DeleteNode[]; protected?: boolean }
export type DeletePreview = { tree: DeleteNode[]; protected?: DeleteNode[]; counts?: Record<string, number> }
export type LogEntry = { id: string | number; actionTime: string; user: string; action: 'add' | 'change' | 'delete' | string; message?: string; changeMessage?: string }
export type ActionResult = { message?: string; level?: 'success' | 'info' | 'warning' | 'error'; download?: string | { url?: string; data?: string; filename?: string; contentType?: string } }
export type FieldErrors = Record<string, string>
export type User = { id: string; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }
