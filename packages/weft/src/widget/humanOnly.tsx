'use client'
import { createContext, useEffect, useRef, type ReactNode } from 'react'
import type { WidgetSpec } from './types.js'

// widgets/human-only.md: a subtree only a human can operate. Every widget inside (declared, built-in,
// plain-HTML auto) gets spec.humanOnly = the innermost reason: the snapshot shows it locked with no
// controls, and the in-tab executor / callControl refuse it with `human_only` before any veto hook.
// In the browser, untrusted events (el.click(), dispatchEvent, WebMCP, page scripts) never reach the
// subtree's handlers. This is a UX guard; the security guard is defineAction(…, { humanOnly: true }).
export const HumanOnlyCtx = createContext<string | undefined>(undefined)

// The events a script would fake to operate a control. Focus/hover are not operations: left alone.
export const BLOCKED = ['click', 'dblclick', 'auxclick', 'contextmenu', 'input', 'beforeinput', 'change', 'submit', 'reset',
  'keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'] as const

// Capture on window (runs before React's root listeners, so onClickCapture handlers are covered too).
// ponytail: the app's own programmatic events inside the wrapper are blocked as well (a button calling
// hiddenFileInput.click()); use a <label> for those. React portals leave the DOM subtree: not covered here.
export function blockUntrusted(el: HTMLElement): () => void {
  const stop = (e: Event) => {
    if (e.isTrusted || !(e.target instanceof Node) || !el.contains(e.target)) return
    e.stopImmediatePropagation()
    e.preventDefault()
  }
  for (const t of BLOCKED) window.addEventListener(t, stop, true)
  return () => { for (const t of BLOCKED) window.removeEventListener(t, stop, true) }
}

export function HumanOnly({ reason, children }: { reason: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => (ref.current ? blockUntrusted(ref.current) : undefined), [])
  return (
    <HumanOnlyCtx.Provider value={reason || 'only a human can do this'}>
      <div ref={ref} data-tvine-human-only="" style={{ display: 'contents' }}>{children}</div>
    </HumanOnlyCtx.Provider>
  )
}

// Dev: a locked widget whose control submits a server action WITHOUT rules.humanOnly — the UI is locked,
// but `do` / MCP / HTTP can still call that action directly.
const warned = new Set<string>()
export function warnUnflagged(spec: WidgetSpec): void {
  if (!spec.humanOnly) return
  for (const c of Object.values(spec.controls ?? {})) {
    const p = c?.headless && 'params' in c.headless ? c.headless.params : undefined
    if (p && !p.humanOnly && !warned.has(p.id)) {
      warned.add(p.id)
      console.warn(`tvine: <HumanOnly> wraps a control that submits ${p.id}, which lacks { humanOnly: true }; agents can still call it directly (do / MCP / HTTP). Add the flag to the action.`)
    }
  }
}
