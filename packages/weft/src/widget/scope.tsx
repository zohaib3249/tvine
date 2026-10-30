'use client'
import { createContext, useContext, type ReactNode } from 'react'
import { joinId } from './ids.js'

// control-tree.md: the nearest scoping widget's full id ('' = page) plus every scope above it
// (nearest first, registered widgets and RSC containers alike). Context crosses portals, so ids and
// the hook chain follow the React tree, not the DOM. The chain is per mount, never keyed by id: the
// same entity scope in two places keeps two different chains.
export interface ScopeValue { id: string; up: readonly string[] }
export const WidgetScopeCtx = createContext<ScopeValue>({ id: '', up: [] })

export const useWidgetScope = (): string => useContext(WidgetScopeCtx).id
export const useScopeValue = (): ScopeValue => useContext(WidgetScopeCtx)

// Ancestors of whatever sits directly inside `s` (nearest first).
export const chainOf = (s: ScopeValue): readonly string[] => (s.id ? [s.id, ...s.up] : s.up)

// Rendered by RSC containers (Section/Data/Form/List) so client widgets learn their parent.
// `id` is the container's LOCAL segment and joins the outer scope (a server Section inside a client
// Dialog → `dialog:x > section:y`); `entity` ids stay global. The outer scopes ride along in `up`,
// so hook bubbling and vetoes pass through server-only containers to the widget outside.
export function WidgetScope({ id, entity, children }: { id: string; entity?: boolean; children?: ReactNode }) {
  const outer = useContext(WidgetScopeCtx)
  const value = { id: entity ? id : joinId(outer.id, id), up: chainOf(outer) }
  return <WidgetScopeCtx.Provider value={value}>{children}</WidgetScopeCtx.Provider>
}
