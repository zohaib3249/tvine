# tvine/admin

Django-admin-style panel for Tvine, built on Weft widgets and the admin API (`docs/design/contrib/admin.md`).
It talks to the backend only through `api.admin.*` / `api.auth.*`. It never touches models or the ORM.

## Mount

Nothing to mount. Put `'tvine.admin'` in `settings.installedApps` and add `tvine/admin` to the app's dependencies.
Warp then serves the panel at `settings.admin.path` (default `/admin`), before Next:

- An HTML shell for every page under the path. Its `<script>` carries the request's CSP nonce.
- `<path>/_static/admin.js` (React and the panel, prebuilt by this package's `pnpm build`) and `<path>/_static/admin.css`
  (Tailwind already applied, scoped under `.tva`).
- The browser renders the panel, and all data comes through `api.*` (`/tvine/api`). Not signed in, or not staff:
  the panel shows its own login (`auth.login`).

Register models in `apps/<app>/admin.ts` (docs/design/contrib/admin.md §1). In two-server mode, forward the admin path
from the Next server to the API server, the same way `/tvine/*` is forwarded.

### Override with your own page (SSR + customization)

A Next page at the same path wins: Warp sees the route and passes the request on.

```ts
// app/admin/[[...path]]/page.tsx
export { default, generateMetadata } from 'tvine/admin/page'
// app/admin/[[...path]]/layout.tsx
export { default } from 'tvine/admin/layout'
```

- This mount renders the first paint on the server (`admin.site` and the route's reads, in-process). After that the
  panel navigates on the client.
- `configureAdmin` (custom pages, widgets, `getUrls` views, slots) needs this mount, because the prebuilt bundle cannot
  import your components.
- Keep `<WeftRoot>` in the host's root layout. (The prebuilt shell renders its own.)
- At another path: `export default adminPage({ base: '/staff' })`, and set `settings.admin.path` to the same path.

## Routes

| URL | View |
|---|---|
| `/admin/` | Dashboard: `admin.site` widgets plus one card per app |
| `/admin/<app>/` | App index |
| `/admin/<app>/<model>/` | Changelist |
| `…/add/` · `…/<pk>/change/` · `…/<pk>/delete/` · `…/<pk>/history/` | Add / change form, delete confirmation (cascade tree from `admin.deletePreview`), history (`admin.history`) |
| `…/<getUrls path>` | Custom `getUrls` view. Renders the component registered as `'<app>.<model>:<url name>'`, with `args` taken from the path |
| `/admin/<page path>/` | `admin.site.registerPage` page. Renders the component registered under its `component` string |

Changelist query parameters follow Django:

| Param | Meaning |
|---|---|
| `q` | Search text |
| `o` | Ordering, comma list. `-` means descending. Shift-click a header to sort by several columns |
| `p` | Page number |
| `all=1` | Show all rows (up to `listMaxShowAll`) |
| any other key | Filter value, e.g. `status=paid` |
| `<field>__year` / `__month` / `__day` | Date hierarchy drill-down |

## What it does

- **Changelist:**
  - `listDisplay` columns, multi-sort, search with `searchHelp`
  - Filter sidebar with facet counts; on phones it becomes a drawer
  - Date hierarchy drill-down
  - Pagination plus "Show all"
  - Row selection, including "select all N" across pages (sends `selectAll` + the current filters + `q`)
  - Action bar: confirm dialog when the action sets `confirm`; `deleteSelected` shows the cascade preview; a toast shows the result; `download` saves a file
  - `listEditable` cells, saved in one `admin.listEdit` call, with errors shown per row
  - Column chooser and saved filters
  - Empty states and skeleton loading
- **Change form:** `tvine/forms` `<ModelForm>`:
  - Fieldsets, with `collapse` support
  - Inlines and readonly fields
  - Server field errors (`lines.0.qty` for inline rows)
  - Save / Save and continue / Save and add another (⌘S = save and continue)
  - Delete link, history link, and object-level `getUrls` buttons
  - Unsaved-changes guard: an in-app dialog when you navigate away, plus `beforeunload`
  - New file uploads are sent as multipart
- **Shell:**
  - Sidebar showing only the apps and models that `admin.site` returns, with a filter box; on phones it becomes a drawer
  - Top bar: ⌘K palette, dark-mode toggle, View site, user menu with Log out
  - Breadcrumbs and toasts
  - Shortcuts: `⌘K` palette (models, Add …, pages, recent objects, actions) · `/` focus search · `n` new object (changelist) · `g d` dashboard
- **Sign in:** when `admin.site` refuses the session, the panel shows a staff login (`auth.login`).

## Theme

`admin.site.theme = { brand, radius, dark: 'auto' | 'on' | 'off' }` becomes CSS variables on the `.tva` root.

| Variable | What it sets |
|---|---|
| `--tva-brand` | Brand color |
| `--tva-radius` | Corner radius |
| `--tva-bg`, `--tva-surface`, `--tva-sunken`, `--tva-line` | Surfaces and borders |
| `--tva-fg`, `--tva-muted` | Text colors |
| `--tva-danger`, `--tva-ok`, `--tva-warn` | Status colors |
| `--tva-accent` | Brand-colored text; lighter in dark mode for contrast |

- Override any of them with a CSS rule on `.tva`.
- The forms' `--tf-*` variables are mapped from these tokens.
- A user's dark/light choice is remembered on that browser.

## Customize

Needs the override mount above. Do this in a `'use client'` module of the host app, and render that module once in `app/admin/[[...path]]/layout.tsx` so it loads before the panel:

```tsx
'use client'
import { configureAdmin, lazyComponent, registerFieldWidget } from 'tvine/admin'

configureAdmin({
  components: {                                     // custom pages, dashboard widgets, getUrls views
    'reports#Export': lazyComponent(() => import('./reports')),
    'shop.order:refund': lazyComponent(() => import('./refund')),   // getUrls name 'refund' on shop.order
  },
  classNames: { sidebar: 'bg-slate-950 text-white' },               // per region: shell sidebar topbar main changelist table filters form dashboard
  slots: { dashboard: (def, p) => <><MyBanner />{def}</> },          // wrap or replace a region; p = { api, site, route, query, meta, navigate, base }
  brandLogo: <img src="/logo.svg" alt="" width={32} height={32} />,
  prefs: { get: (k) => …, set: (k, v) => … },                        // where saved filters / columns / recent objects live
})
registerFieldWidget('shop.product.color', ColorField)               // formfieldOverrides → forms registry (kind or app.model.field)
```

Custom components receive `{ api, site, route, query, meta?, navigate, base, data?, args? }`. Here `api(id, params)` is the same `api.*` call path the panel uses.

## Agent control

Every control is a Weft widget with a stable id. Plain buttons, links and inputs register through the Weft JSX runtime (`agentId`); regions are `useWidget` scopes. Examples:

```
admin:nav > link:shop.order                     admin:topbar > button:palette · drawer:menu · menu:user
admin:changelist > input:search · button:search-go · button:sort-email · select:action · button:run · button:select-all
admin:changelist > row:12 > checkbox:select · link:open · select:status (listEditable)
admin:changelist > admin:filters > button:status-paid · button:save-filter
admin:form > form:order > field:email           admin:form > form:order > inline:lines > row:pk1 > field:qty
admin:form > form:order > button:save · button:save-continue · button:save-add · link:delete
admin:delete > button:confirm                   (palette open) input:query · option:model:shop.order · option:add:shop.order
```

## Dev

`pnpm -C packages/admin test`. Tests run against `test/mock.ts`, an in-package mock of every §2 action. The mock is not part of the published `dist`.
