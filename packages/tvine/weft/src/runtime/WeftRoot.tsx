'use client'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { PresenceOptions, WidgetHooks } from '../widget/types.js'
import { getOverlay } from '../presence/overlay.js'
import { registerWebMcp } from './webmcp.js'
import { connectTab } from './socket.js'
import { watchNav } from './nav.js'
import { getRegistry } from './registry.client.js'
import { AutoOff } from '../jsx/AutoEl.js'
import { ConfirmHost } from './ConfirmHost.js'
import { devReload } from './devReload.js'

// Root layout wrapper: owns the page-level hooks (custom-logic.md §Global). Hooks are functions,
// so a server layout passes them through an app-owned 'use client' wrapper. Nested roots stack:
// every mounted root's hooks run, innermost first. Each root's hooks apply PAGE-WIDE (to every
// registered widget), not just to the widgets rendered inside it. `auto={false}`: the JSX runtime stays,
// auto-registration of plain HTML inside is skipped (jsx-runtime.md §Performance). W4: WebMCP tools are registered
// by default in development; production defaults to off (set inTab="on" to enable WebMCP + tab control).
// `presence={false}` hides outline/cursor/label, never the Stop pill. W8: root layout so registry/tab/nav survive navigations.
export function WeftRoot({ hooks, auto, children, inTab = process.env.NODE_ENV === 'production' ? 'off' : 'on', presence, header }: { hooks?: WidgetHooks; auto?: boolean; children?: ReactNode; inTab?: 'on' | 'off'; presence?: false | PresenceOptions; header?: string }) {
  const holder = useRef<{ hooks?: WidgetHooks }>({})
  useLayoutEffect(() => { holder.current.hooks = hooks })
  useLayoutEffect(() => getRegistry().addRoot(holder.current), [])
  useEffect(() => { const o = getOverlay(); o.enabled = presence !== false; o.options = presence || {} }, [presence])
  useEffect(() => watchNav(), [])
  // header: settings.header (scaffold sets data-tvine-header + TVINE_HEADER; prop wins)
  useEffect(() => (inTab === 'off' ? undefined : registerWebMcp({ header })), [inTab, header])
  // W7: the tab socket — a remote agent may control this tab after the human clicks Allow (production too)
  useEffect(() => (inTab === 'off' ? undefined : connectTab()), [inTab])
  // W10: dev tools (Alt+Shift+W gallery + the inspector's Widgets feed). The NODE_ENV test is inlined by every
  // bundler, so in a production build this branch and its dynamic import are dead code: no gallery chunk exists.
  // Keep the import INSIDE the if-block: bundlers drop a constant-false branch before collecting imports.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      let off: (() => void) | undefined, gone = false
      void import('../dev/Gallery.js').then((m) => { if (!gone) off = m.mountDevtools() }, () => {})
      const reload = devReload()   // tvine dev: reload after a server restart (404 under next dev alone: EventSource gives up)
      return () => { gone = true; off?.(); reload?.() }
    }
  }, [])
  return <>{auto === false ? <AutoOff>{children}</AutoOff> : children}<ConfirmHost /></>
}
