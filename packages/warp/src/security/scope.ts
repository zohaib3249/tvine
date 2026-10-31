// The one row-scoping path (Django get_queryset): every read of a view's or an admin's rows goes through scoped(),
// so a new code path cannot forget the per-user / per-tenant scope by reaching for `model.objects`.
import type { QuerySet } from '../data/queryset.js'

export interface Scoping<C, T extends object = any> { getQueryset(ctx: C): QuerySet<T> }
export const scoped = <C, T extends object>(v: Scoping<C, T>, ctx: C): QuerySet<T> => v.getQueryset(ctx)
