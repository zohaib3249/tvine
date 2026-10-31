// tvine/admin client entry: the app, customization hooks and the shapes it consumes (admin.md §2/§3).
export { AdminApp, CustomComponent, lazyComponent, type AdminAppProps } from './app.js'
export { configureAdmin, useAdmin, type AdminConfig, type CustomProps, type Slot } from './ui.js'
export { registerFieldWidget, type FieldWidgetProps } from './forms-adapter.js'
export { parse, href, listParams, queryOf, toggleSort, type Route, type Query, type ListParams } from './routes.js'
export type * from './types.js'
