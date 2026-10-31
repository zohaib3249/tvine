// docs/design/contrib/admin.md §2: FieldMeta / ModelMeta.form, exactly as the admin API (A) emits them.
// Shared with the admin UI (B); do not change these shapes here.
import type { ComponentType } from 'react'

export type FieldKind =
  | 'text' | 'textarea' | 'email' | 'url' | 'slug' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'datetime' | 'time'
  | 'duration' | 'uuid' | 'json' | 'choice' | 'fk' | 'm2m' | 'file' | 'image' | 'password' | 'rich'

export interface FieldMeta {
  name: string; label: string; help?: string; kind: FieldKind
  required: boolean; readOnly: boolean; nullable: boolean; default?: unknown
  choices?: { value: string; label: string }[]
  max?: number; min?: number; maxLength?: number; decimals?: number; currency?: string; multiple?: boolean
  relation?: { model: string; autocomplete: boolean; rawId: boolean }
  upload?: { accept: string; maxBytes: number }
}

export interface InlineMeta {
  name: string; kind: 'tabular' | 'stacked'; model: string; fk: string; fields: string[]
  extra: number; max: number; min: number; canDelete: boolean
  meta: Record<string, FieldMeta> | { fields: Record<string, FieldMeta> }   // §2 leaves it open: both accepted
}

export interface FormMeta {
  fieldsets: { title: string | null; classes?: string[]; fields: string[] }[]
  fields: Record<string, FieldMeta>
  inlines?: InlineMeta[]
}

// fk / m2m search (admin.autocomplete): `{ results: [{ pk, text }], more }`.
export type SearchResult = { pk: string; text: string }
export type Search = (q: string, page: number) => Promise<{ results: SearchResult[]; more: boolean }>

// What a field widget gets. `value` is in FORM shape (see values.ts); call onChange with form shape.
export interface FieldWidgetProps {
  meta: FieldMeta; value: any; onChange(v: any): void
  id: string; name: string; invalid: boolean; describedBy?: string; readOnly: boolean
  search?: Search
  model?: string   // 'app.model' (registry lookups)
}
export type FieldWidget = ComponentType<FieldWidgetProps>

export type Row = Record<string, any> & { pk?: string; DELETE?: boolean }
