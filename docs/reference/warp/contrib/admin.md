# tvine.admin

## What it is

`tvine.admin` is the built-in staff panel, modelled on Django's `django.contrib.admin`. You register models with a
`ModelAdmin` class in `apps/<app>/admin.ts`; Warp serves the panel at `settings.admin.path` (default `/admin`) with
changelists (filters, search, sorting, bulk actions, inline edits, charts), change forms with inlines, a dashboard,
an audit history per object, and a System section (health, traffic, agents, queries, jobs, logs, security). Every
screen reads and writes through `admin.*` actions, so permissions, rate limits and the audit trail apply.
Source: `packages/tvine/warp/src/contrib/admin/`.

## Install / enable

```ts
// config/settings.ts
export default defineSettings({
  installedApps: ['tvine.auth', 'tvine.admin', 'catalog', 'orders'],   // the panel's logins come from tvine.auth
  admin: { path: '/admin', title: 'Shop admin' },
})
```

Run `tvine migrate`, then `tvine createsuperuser`. No page file and no middleware is needed. At boot the admin
imports `admin.ts` of every installed app (project apps first, then contrib), then checks every registration: an
unknown field name in any option is a boot error naming the class.

`tvine.auth` registers `User` and `Group`; `tvine.tasks` registers `Job` (read-only, retry / revoke);
`tvine.audit` registers `AuditEntry` (read-only).

Optional REST paths for the admin API: `path('admin/', include('tvine.admin.urls'))`. Without it every call still
answers at `POST /tvine/api/admin.<name>`.

## Import

```ts
import { admin, register, site, ModelAdmin, TabularInline, StackedInline, SimpleListFilter, display, adminAction,
  deleteSelected, logAction, LogEntry, ADDITION, CHANGE, DELETION, type Ctx, type ActionResult } from 'tvine/contrib/admin'
```

`admin` is `{ site, register }`.

## Registering

```ts
admin.site.register(Model | Model[], AdminClass = ModelAdmin): void   // throws AlreadyRegistered
admin.register(Product, ProductAdmin)                                  // same, registers now
@admin.register(Product) class ProductAdmin extends ModelAdmin {}      // decorator (TC39 or legacy)
admin.site.unregister(Model)                                           // throws NotRegistered
admin.site.isRegistered(Model): boolean
```

A model's admin key is `'<app>.<model>'`: the app whose `models.ts` exports it, and the model name without its
`<app>_` prefix (`catalog_product` → `catalog.product`).

## ModelAdmin options

### List page (changelist)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listDisplay` | `(string \| (obj) => unknown)[]` | `['__str__']` | columns: field names, method names, functions, or `'__str__'` (the `str()` of the row). Not m2m fields. |
| `listDisplayLinks` | `string[] \| null` | first column | columns that link to the change form |
| `listEditable` | `string[]` | `[]` | fields editable in the list; each must be a field in `listDisplay` and not a link column |
| `listPerPage` | `number` | `100` | rows per page |
| `listMaxShowAll` | `number` | `200` | "show all" works up to this many rows; also caps `pageSize` |
| `listFilter` | `(string \| SimpleListFilter class)[]` | `[]` | sidebar filters: bool → Yes/No, date/datetime → Today / Past 7 days / This month / This year, fk → related rows (first 200), enum → its values, other → distinct values in use (first 200); optional fields add a "null" choice |
| `showFacets` | `boolean` | `true` | show a row count next to each filter choice |
| `searchFields` | `string[]` | `[]` | every search word must match one of these. Prefix `^` = starts with, `=` = exact, `@` or none = contains (all case-insensitive). `rel__field` follows relations. Not money fields. |
| `searchHelpText` | `string \| null` | `Search by <fields>` | text under the search box |
| `dateHierarchy` | `string \| null` | `null` | a date/datetime field: year → month → day drill-down (filters `<f>__year`, `__month`, `__day`, UTC) |
| `sortableBy` | `string[] \| null` | all fields | which field columns can be sorted (json columns never) |
| `ordering` | `string[] \| null` | model `meta.ordering`, else `['-id']` | default order; `'-rel__count'` orders by a related count |
| `showFullResultCount` | `boolean` | `true` | show the unfiltered total next to the filtered count |
| `emptyValueDisplay` | `string` | `'-'` | shown for empty cells |
| `actions` | `(AdminAction \| string)[]` | `[]` | bulk actions; a string names a method `(ctx, qs, pks)` of the class. `deleteSelected` is always added first. |
| `actionsOnTop` | `boolean` | `true` | action bar above the list |
| `charts` | `ChartSpec[] \| false \| null` | `null` | `null` = automatic charts, `false` = none, a list = yours (see [Charts](#charts)) |

### Change form

| Option | Type | Default | Meaning |
|---|---|---|---|
| `fields` | `string[] \| null` | every field | which fields the form shows, in order |
| `exclude` | `string[]` | `[]` | fields left out of the form |
| `fieldsets` | `[title \| null, { fields, classes?, description? }][] \| null` | `null` | grouped form sections; wins over `fields` |
| `readonlyFields` | `string[]` | `[]` | shown, never written (`auto` fields show only when listed here) |
| `autocompleteFields` | `string[]` | `[]` | fk / m2m fields picked with a search box (target admin needs `searchFields`) |
| `rawIdFields` | `string[]` | `[]` | fk / m2m fields typed as an id |
| `formfieldOverrides` | `Record<fieldName \| ormKind, Partial<FieldMeta>>` | `{}` | change any form field property: `{ text: { kind: 'textarea' } }`, `{ price: { suffix: 'EUR' } }` |
| `widgets` | `Record<fieldName, MetaKind>` | `{}` | pick an input per field: `{ status: 'segmented', notes: 'markdown' }` |
| `inlines` | `InlineClass[]` | `[]` | related rows edited on the same form |
| `saveOnTop` | `boolean` | `false` | save buttons above the form too |
| `verboseName` / `verboseNamePlural` | `string \| null` | from the model name | labels |

An fk / m2m field that is neither in `autocompleteFields` nor in `rawIdFields` is a dropdown of the related rows
(only the first 500); use `autocompleteFields` for big tables.

`MetaKind` values for `widgets` / `formfieldOverrides.kind`: `text textarea email url slug int decimal money bool
date datetime time duration uuid json choice fk m2m file image password rich color range phone search tags checkboxes
switch segmented rating otp markdown code daterange month week country address keyvalue list signature currency
percent ip slugAuto`.

### Agents and access

| Option | Type | Default | Meaning |
|---|---|---|---|
| `agents` | `boolean \| 'confirm'` | `true` | `false`: agent-marked requests are refused for this model; `'confirm'`: an agent's write answers `confirm_required` and only the human can confirm. `UserAdmin` and `GroupAdmin` use `false`. |

### Methods you can override

| Method | Default | Meaning |
|---|---|---|
| `str(obj)` | first of `name`, `title`, `username`, `email`, `label`, else `"<model> object (<id>)"` | the row's display text |
| `getQueryset(ctx)` | `model.objects` | every read and write goes through it: scope rows per user here |
| `getObject(ctx, pk)` | from `getQueryset` | `undefined` = not found |
| `getReadonlyFields(ctx, obj?)` | `readonlyFields` | |
| `saveModel(ctx, obj \| undefined, values)` | create or update | `values` are validated and keyed by row property (fk → `<name>Id`) |
| `deleteModel(ctx, obj)` | `model.delete(id)` | |
| `getActions(ctx)` | `deleteSelected` + `actions` | |
| `hasViewPermission(ctx, obj?)` | `view` or `change` permission | |
| `hasAddPermission` / `hasChangePermission` / `hasDeletePermission(ctx, obj?)` | the model permission | |
| `hasModulePermission(ctx)` | any of the four | |
| `changelist?(ctx, params)` | not set | return `{ rows, count }` to list from somewhere other than the ORM |
| `getUrls()` | `[]` | custom admin views (below) |
| `view(fn, { readOnly?, permission?, title? })` | — | wraps `fn(params, ctx)` as a staff-only action; needs `view` unless `permission` names another (`'change'`, or `X` → `hasXPermission`) |

The default permission checks: the user must be active staff; a superuser passes; otherwise the codename
`<app>.<view|add|change|delete>_<model>` (see [auth.md](auth.md#permissions-and-groups)).

### `@display`

```ts
display({ description?, ordering?, boolean?, emptyValue? })(fn)   // or as a method decorator
```

`description` = column label (or action label for string actions), `ordering` = a field to sort the column by,
`boolean: true` = show as a yes/no icon.

### Bulk actions: `adminAction`

```ts
adminAction(opts: { name?, description?, permissions?, confirm?, humanOnly? }, fn: (admin, ctx, queryset, pks) => Promise<void | ActionResult>)
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | `fn.name`, else camelCased `description` | must be an identifier |
| `description` | `string` | `name` | label in the action menu |
| `permissions` | `string[]` | `[]` | `'view' \| 'add' \| 'change' \| 'delete'` or any `X` → `hasXPermission(ctx)` must pass |
| `confirm` | `boolean \| string` | `false` | the panel asks before running (a string is the question) |
| `humanOnly` | `boolean` | — | hidden from and refused for agents |

`queryset` holds only the selected rows (through `getQueryset`); `pks` are their keys as strings. Return
`{ message?, level?: 'info' | 'success' | 'warning' | 'error', download? }`; `download` is a url string or
`{ url? | data?, filename, contentType }`. One `LogEntry` per row is written.

### List filters: `SimpleListFilter`

```ts
class InStock extends SimpleListFilter {
  title = 'Stock'
  parameterName = 'stock'
  lookups() { return [['out', 'Out of stock'], ['low', 'Below 5']] as [string, string][] }
  queryset(_ctx, qs) { return this.value() === 'out' ? qs.filter({ stock: 0 }) : this.value() === 'low' ? qs.filter({ stock__lt: 5 }) : qs }
}
```

### Inlines: `TabularInline` / `StackedInline`

Set `model` and any of the shared options (`fields`, `exclude`, `readonlyFields`, `autocompleteFields`,
`rawIdFields`, `ordering`, `formfieldOverrides`, `widgets`, `verboseName(Plural)`, `str`, `getQueryset`,
`has*Permission`) plus:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `fkName` | `string \| null` | the only fk to the parent | which fk, when the inline model has several |
| `extra` | `number` | `3` | empty rows offered |
| `maxNum` | `number \| null` | `null` (UI max 1000) | at most this many rows |
| `minNum` | `number` | `0` | at least this many rows |
| `canDelete` | `boolean` | `true` | rows can be deleted |
| `name` | `string \| null` | model short name | key of the rows in `admin.get` / `create` / `update` |

`tabular` = a grid, `stacked` = one form per row.

### Custom views: `getUrls`

```ts
getUrls() { return [path('<int:id>/invoice/', this.view(this.invoice, { title: 'Invoice' }), { name: 'invoice' })] }
async invoice(params: Record<string, unknown>, ctx: Ctx) { /* return data */ }
```

Each one becomes the action `admin.<app>_<model>_<name>` (staff only; a raw `defineAction` def is made staff-only
too unless it has `public: true`) and the route `<app>/<model>/<route>` under `tvine.admin.urls`. The model page
lists them (`name`, `path`, `title`). How the panel renders a custom view's result: Not covered here (frontend
`configureAdmin` in `tvine/admin`).

## Charts

`ChartSpec`: `{ id?, title?, type, aggregate?, field?, by?, date?, range?, size?, dashboard? }`.

| Key | Values | Default | Meaning |
|---|---|---|---|
| `type` | `line area bar stacked donut stat table` | — | renderer; `stat` = total over the range plus the period before |
| `aggregate` | `count sum avg min max` | `count` | `sum`…`max` need a number/money `field` |
| `field` | field name | — | what to aggregate |
| `by` | choice / bool / fk field | — | a breakdown (top 8 + Other) instead of a time series |
| `date` | date field | `dateHierarchy`, else the first date field | x axis |
| `range` | `24h 7d 30d 90d 1y` | the page's range | |
| `size` | `sm md lg xl` | | |
| `dashboard` | `boolean` | `true` | also show on the dashboard |

Automatic charts (`charts = null`): with a date field, "New <rows>" stat, a sum stat of the first money/decimal
field, "<rows> over time" area, a sum-per-period bar; then donuts by the first two enum / bool / fk fields (list
filters first). Charts use the changelist queryset and filters. Results are cached 60 s per user in the default cache.

## Site, pages and widgets

`admin.site` options (set them in any `admin.ts`): `siteHeader` (`'Tvine administration'`), `siteTitle`
(`'Tvine site admin'`, `settings.admin.title` wins), `indexTitle` (`'Site administration'`), `siteUrl` (`'/'`).

```ts
admin.site.registerPage({ path, title, icon?, section?, component, permission? })
admin.site.registerWidget({ id, title, size, data?, type?, refreshMs?, component?, permission? })
```

| Widget key | Type | Meaning |
|---|---|---|
| `id` | `string` | unique; `settings.admin.dashboard.widgets` orders by it |
| `title` | `string` | |
| `size` | `'sm' \| 'md' \| 'lg' \| 'xl'` | |
| `data` | `ActionDef` or `(ctx, { range }) => unknown` | a function returns `ChartData`, `{ value, previous? }` or `{ columns, rows }` |
| `type` | `line area bar stacked donut stat table custom` | default `custom` with a `component`, else `stat` |
| `refreshMs` | `number` | auto refresh |
| `component` | `string` | a frontend component name (`'module#Export'`), for `type: 'custom'` and pages |
| `permission` | codename | only users holding it see it (superusers always) |

Built-in dashboard widgets (when `settings.admin.stats.enabled`): `kpi.requests`, `kpi.errors`, `kpi.latency`,
`kpi.agents`, `traffic.requests`, `traffic.status`, `traffic.latency`, `logins` (superuser), `agents.activity`,
`agents.top`, `actions.top`, `actions.slowest`, `searches.top`, `pages.top`, `searches.none`; plus `activity`
(recent actions) and up to 16 model charts when `dashboard.autoCharts`. Each staff user's layout is saved per user.

## System pages

Actions `admin.system.<page>`, staff only (`staffGuard`), read only.

| Page | Who |
|---|---|
| `health`, `traffic`, `metrics`, `agents`, `queries`, `search`, `pages` | staff |
| `jobs` | staff with `tasks.view_job` |
| `logs`, `security` | superuser |
| `revokeTab` (stop an agent's tab control) | superuser |

## Hardening (`settings.admin`)

Every `admin.*` action runs `staffGuard`: active staff, then these settings.

| Key | Effect |
|---|---|
| `allowIps: ['10.0.0.0/8', '203.0.113.7']` | staff may use the admin only from these addresses / CIDRs; also adds `tvine.middleware.IpFilter` on the panel path. A bad entry is a boot error. Refusals log `ip_refused`. |
| `require2fa: true` | staff without confirmed TOTP get `two_factor_required` (set it up with `auth.totpBegin` / `auth.totpConfirm`) |
| `idleMs: 900_000` | no admin use for this long (or since sign-in) → `reauth_required` |

`UserAdmin` also asks for a password typed in the last 10 minutes (and a session, not a token) before changing a
password or the staff / superuser flags. Passwords change only through the user's "Change password" view.

## Settings: `settings.admin.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `path` | `string` | `'/admin'` | panel URL |
| `title` | `string` | — | browser title (overrides `site.siteTitle`) |
| `theme.brand` | `string` | — | accent color |
| `theme.radius` | `string` | — | corner radius |
| `theme.dark` | `'auto' \| 'on' \| 'off'` | `'auto'` | |
| `allowIps` | `string[]` | — | see Hardening |
| `require2fa` | `boolean` | — | see Hardening |
| `idleMs` | `number` | — | see Hardening |
| `dashboard.widgets` | `string[]` | `[]` | widget ids shown first, in this order |
| `dashboard.autoCharts` | `boolean` | `true` | model charts on the dashboard |
| `stats.enabled` | `boolean` | `true` | collect traffic / action / query rollups (`admin_stat` table) |
| `stats.retentionDays` | `number` | `30` | rollup rows kept |
| `stats.flushMs` | `number` | `60_000` | rollup write interval (min 1000) |
| `stats.searches.enabled` | `boolean` | `true` | count visitor searches (an action's `rules.search` param) |
| `stats.searches.minCount` | `number` | `3` | a term shows once this many sessions searched it |
| `stats.pages.enabled` | `boolean` | `true` | count page views |
| `stats.pages.keepParams` | `string[]` | `[]` | query params kept in counted page paths |

## Examples

### 1. Products

```ts
// apps/catalog/admin.ts
import { admin, adminAction, display, ModelAdmin } from 'tvine/contrib/admin'
import { Product } from './models.ts'

export const restock = adminAction({ description: 'Restock to 20', permissions: ['change'], confirm: 'Set stock to 20?' },
  async (_a, _ctx, qs) => { const n = await qs.update({ stock: 20 }); return { message: `${n} restocked`, level: 'success' } })

class ProductAdmin extends ModelAdmin {
  listDisplay = ['name', 'category', 'price', 'stock', 'available']
  listFilter = ['category', 'published']
  listEditable = ['stock']
  searchFields = ['^sku', 'name', 'category__name']
  autocompleteFields = ['category']
  readonlyFields = ['createdAt']
  actions = [restock]
  available = display({ description: 'Available', boolean: true })((p: any) => p.stock > 0)
  str(p: any) { return String(p.name) }
}
admin.site.register(Product, ProductAdmin)
```

### 2. Orders with lines, grouped form, scoped rows

```ts
// apps/orders/admin.ts
import { admin, ModelAdmin, TabularInline, type Ctx } from 'tvine/contrib/admin'
import { Order, OrderLine } from './models.ts'

class LineInline extends TabularInline {
  model = OrderLine
  fields = ['product', 'qty', 'price']
  autocompleteFields = ['product']
  extra = 0
}

@admin.register(Order)
class OrderAdmin extends ModelAdmin {
  listDisplay = ['id', 'customer', 'status', 'total', 'createdAt']
  listFilter = ['status', 'createdAt']
  dateHierarchy = 'createdAt'
  inlines = [LineInline]
  widgets = { status: 'segmented' as const }
  fieldsets: ModelAdmin['fieldsets'] = [
    [null, { fields: ['customer', 'status'] }],
    ['Money', { fields: ['total'], classes: ['collapse'] }],
  ]
  // shop staff see only their store's orders
  getQueryset(ctx: Ctx) { return ctx.request.user.isSuperuser ? Order.objects : Order.objects.filter({ storeId: Number((ctx.request.user as any).storeId) }) }
}
```

### 3. A dashboard widget

```ts
admin.site.registerWidget({
  id: 'low-stock', title: 'Running low', size: 'md', type: 'table', permission: 'catalog.view_product',
  data: async () => {
    const rows = await Product.objects.filter({ stock__lt: 5 }).order('stock').all(8)
    return { columns: ['Product', 'Stock'], rows: rows.map((p) => [p.name, p.stock]) }
  },
})
```

### 4. Locked-down admin

```ts
admin: { path: '/staff', allowIps: ['10.0.0.0/8'], require2fa: true, idleMs: 15 * 60_000, dashboard: { widgets: ['low-stock', 'kpi.requests'], autoCharts: true, } }
```

## Gotchas

- `listEditable` fields must also be in `listDisplay` and must not be the link column (the first column by default).
- Option names are checked at boot; a typo fails the boot with the class name.
- `getQueryset` is the only row scope: actions, charts, search, autocomplete and deletes all go through it.
- Deleting a row whose foreign keys use `PROTECT` / `RESTRICT` (the fk default) deletes nothing and lists the
  protected rows.
- Agents use the admin like staff unless `agents` says otherwise. `mcp: { exclude: ['admin.*'] }` in settings keeps
  the `admin.*` actions out of the typed MCP tool list.
- The `admin_stat` rollups add up across server and worker processes; `1h` ranges read in-process numbers.
- `registerPage` / `component` need a frontend component registered with `configureAdmin` from `tvine/admin`.

## See also

- [auth.md](auth.md): staff, permissions, groups, 2FA
- [tasks.md](tasks.md): the Job admin
- [audit.md](audit.md): the AuditEntry admin and LogEntry vs audit rows
- [../models.md](../models.md): field kinds the form maps to inputs
- [../actions.md](../actions.md): `defineAction`, used by `view()` and widgets
