'use client'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { PresenceOptions, WidgetHooks } from '../widget/types.js'
import { getOverlay } from '../presence/overlay.js'
import { registerWebMcp } from './webmcp.js'
import { getRegistry } from './registry.client.js'

// Root layout wrapper: owns the page-level hooks (custom-logic.md §Global). Hooks are functions,
// so a server layout passes them through an app-owned 'use client' wrapper. Nested roots stack:
// every mounted root's hooks run, innermost first. Each root's hooks apply PAGE-WIDE (to every
// registered widget), not just to the widgets rendered inside it. W4: WebMCP tools are registered by default,
// in production too (`inTab="off"` is the app's opt-out); `presence={false}` hides outline/cursor/label, never the Stop pill.
export function WeftRoot({ hooks, children, inTab = 'on', presence }: { hooks?: WidgetHooks; children?: ReactNode; inTab?: 'on' | 'off'; presence?: false | PresenceOptions }) {
  const holder = useRef<{ hooks?: WidgetHooks }>({})
  useLayoutEffect(() => { holder.current.hooks = hooks })
  useLayoutEffect(() => getRegistry().addRoot(holder.current), [])
  useEffect(() => { const o = getOverlay(); o.enabled = presence !== false; o.options = presence || {} }, [presence])
  useEffect(() => (inTab === 'off' ? undefined : registerWebMcp()), [inTab])
  return <>{children}</>
}
