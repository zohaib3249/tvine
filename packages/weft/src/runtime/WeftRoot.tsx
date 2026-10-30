'use client'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { WidgetHooks } from '../widget/types.js'
import { getRegistry } from './registry.client.js'
import { AutoOff } from '../jsx/AutoEl.js'

// Root layout wrapper: owns the page-level hooks (custom-logic.md §Global). Hooks are functions,
// so a server layout passes them through an app-owned 'use client' wrapper. Nested roots stack:
// every mounted root's hooks run, innermost first. Each root's hooks apply PAGE-WIDE (to every
// registered widget), not just to the widgets rendered inside it. `auto={false}`: the JSX runtime stays,
// auto-registration of plain HTML inside is skipped (jsx-runtime.md §Performance). Socket/WebMCP/presence/nav join in W4/W7/W8.
export function WeftRoot({ hooks, auto, children }: { hooks?: WidgetHooks; auto?: boolean; children?: ReactNode }) {
  const holder = useRef<{ hooks?: WidgetHooks }>({})
  useLayoutEffect(() => { holder.current.hooks = hooks })
  useLayoutEffect(() => getRegistry().addRoot(holder.current), [])
  return auto === false ? <AutoOff>{children}</AutoOff> : <>{children}</>
}
