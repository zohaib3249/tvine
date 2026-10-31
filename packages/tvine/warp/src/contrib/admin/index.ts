// tvine/contrib/admin — the public face of tvine.admin (docs/design/contrib/admin.md). Enable it with
// settings.installedApps: ['tvine.auth', 'tvine.admin'] and register models in apps/<app>/admin.ts.
import { register, site } from './sites.js'

export const admin = { site, register }
export { AdminSite, AlreadyRegistered, NotRegistered, autodiscover, register, site, type AdminPage, type AdminWidget } from './sites.js'
export {
  ModelAdmin, InlineModelAdmin, TabularInline, StackedInline, SimpleListFilter, display, adminAction, deleteSelected,
  type ActionResult, type AdminAction, type AdminActionOpts, type Ctx, type DisplayOpts, type Fieldset, type ListParams,
} from './options.js'
export { labelOf, type FieldMeta, type MetaKind } from './meta.js'
export { LogEntry, ADDITION, CHANGE, DELETION } from './models.js'
export { logAction } from './views.js'
