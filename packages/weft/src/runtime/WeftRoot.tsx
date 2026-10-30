'use client'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { WidgetHooks } from '../widget/types.js'
import { getRegistry } from './registry.client.js'

// Root layout wrapper: owns the page-level hooks (custom-logic.md §Global). Hooks are functions,
// so a server layout passes them through an app-owned 'use client' wrapper. Nested roots stack:
// every mounted root's hooks run, innermost first. Socket/WebMCP/presence/nav join in W4/W7/W8.
export function WeftRoot({ hooks, children }: { hooks?: WidgetHooks; children?: ReactNode }) {
  const holder = useRef<{ hooks?: WidgetHooks }>({})
  useLayoutEffect(() => { holder.current.hooks = hooks })
  useLayoutEffect(() => getRegistry().addRoot(holder.current), [])
  return <>{children}</>
}
