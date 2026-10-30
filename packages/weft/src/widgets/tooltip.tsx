'use client'
import { useId, useState, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, part, type Slots, type SlotProps } from './_parts.js'

// widgets/tooltip.md: read-only. The text is in state from the declaration (agents never hover);
// shows on hover/focus, Esc hides. Trigger children stay agent-visible (outside AutoOff).
type S = { text: string }
export type TooltipProps = {
  name: string; content: string; children?: ReactNode
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'content', S>
}

const useTooltip = defineWidget<TooltipProps, S, Record<string, Control<any, any>>>({
  kind: 'tooltip',
  state: (p) => ({ text: p.content }),
  controls: () => ({}),
  describe: (p) => ({ label: p.content }),
  spec: (p) => ({ name: p.name }),
})

export function Tooltip(props: DefinedProps<TooltipProps, Record<string, Control<any, any>>>) {
  const { content, children, className, slots } = props
  const [open, setOpen] = useState(false)
  const w = useTooltip(props)
  const tid = useId()
  const s = { text: content }
  return part('span', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'tooltip', 'data-state': open ? 'open' : 'closed', 'aria-describedby': tid,
    onPointerEnter: () => setOpen(true), onPointerLeave: () => setOpen(false), onFocus: () => setOpen(true), onBlur: () => setOpen(false),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) },
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    {children}
    <AutoOff>{part('span', { id: tid, role: 'tooltip', hidden: !open }, slots?.content, s, content)}</AutoOff>
  </>)
}
