// Type-level helpers the generated tvine-api.d.ts uses (docs/design/frontend/v2/core/api-client.md §Codegen).
// Types only: the generated file is type queries into the app's own views, always in sync, no compiler run.
import type { z } from 'zod'
import type { Paginated } from '../data/queryset.js'
import type { GeneratedAction } from '../views/generic.js'

type Row = Record<string, unknown>   // serializer output (Serializer.output returns a plain record)
type Method<V, K> = V extends abstract new (...a: any) => infer I ? K extends keyof I ? I[K] : never : never

// FBV: ActionIn<typeof views.add>. @action method: ActionIn<typeof views.ProductDetail, 'addToCart'>.
export type ActionIn<D, K extends string = never> = [K] extends [never]
  ? D extends { schema: infer S extends z.ZodTypeAny } ? z.input<S> : never
  : Method<D, K> extends (p: infer P, ...a: any) => any ? P : never
export type ActionOut<D, K extends string = never> = [K] extends [never]
  ? D extends { run(...a: any): Promise<infer R> } ? R : unknown
  : Method<D, K> extends (...a: any) => Promise<infer R> ? R : unknown

export interface ListParams { q?: string; sort?: string; cursor?: string; [filter: string]: unknown }
// Generated list/get/create/update/delete of a class view. JSON on the wire (a Date arrives as a string).
export type ViewIn<_V, A extends GeneratedAction> = A extends 'list' ? ListParams : Record<string, unknown>
export type ViewOut<_V, A extends GeneratedAction> = A extends 'list' ? Paginated<Row> : A extends 'delete' ? null : Row
