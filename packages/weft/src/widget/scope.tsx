'use client'
import { createContext, useContext, type ReactNode } from 'react'

// control-tree.md: the nearest scoping widget's full id ('' = page). Context crosses portals,
// so ids follow the React tree, not the DOM.
export const WidgetScopeCtx = createContext('')

export const useWidgetScope = (): string => useContext(WidgetScopeCtx)

// Rendered by RSC containers (Section/Data/Form/List/Page, W6) so client widgets learn their parent.
export function WidgetScope({ id, children }: { id: string; children?: ReactNode }) {
  return <WidgetScopeCtx.Provider value={id}>{children}</WidgetScopeCtx.Provider>
}
