'use client'
import { useLayoutEffect, type ReactNode } from 'react'
import type { WidgetHooks } from '../widget/types.js'
import { getRegistry } from './registry.client.js'

// Root layout wrapper: owns the tab's registry and the page-level hooks (custom-logic.md §Global).
// Survives client navigation because it lives in the root layout. Socket/WebMCP/presence/nav
// wiring join here in W4/W7/W8.
export function WeftRoot({ hooks, children }: { hooks?: WidgetHooks; children?: ReactNode }) {
  useLayoutEffect(() => {
    const reg = getRegistry()
    reg.rootHooks = hooks
    return () => { if (reg.rootHooks === hooks) reg.rootHooks = undefined }
  }, [hooks])
  return <>{children}</>
}
