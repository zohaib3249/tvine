'use client'
import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'
import { getRegistry } from '../runtime/registry.client.js'
import { joinId } from './ids.js'

// control-tree.md: the nearest scoping widget's full id ('' = page). Context crosses portals,
// so ids follow the React tree, not the DOM.
export const WidgetScopeCtx = createContext('')

export const useWidgetScope = (): string => useContext(WidgetScopeCtx)

// Rendered by RSC containers (Section/Data/Form/List) so client widgets learn their parent.
// `id` is the container's LOCAL segment and joins the outer scope (a server Section inside a client
// Dialog → `dialog:x > section:y`); `entity` ids stay global. The container is not a registry entry,
// so it records its outer scope: hook bubbling and vetoes pass through it to the widget outside.
export function WidgetScope({ id, entity, children }: { id: string; entity?: boolean; children?: ReactNode }) {
  const outer = useWidgetScope()
  const value = entity ? id : joinId(outer, id)
  useLayoutEffect(() => getRegistry().addScope(value, outer), [value, outer])
  return <WidgetScopeCtx.Provider value={value}>{children}</WidgetScopeCtx.Provider>
}
