'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'
import { showPopover } from './_position.js'

// widgets/popover.md: non-modal, native `popover` (top layer, Esc + light dismiss via toggle event).
// Content mounts only while open, so closed content never reaches the agent view.
// ponytail: no anchor positioning math; style placement with CSS anchor() / data-side.
type C = Record<string, Control<any, any>>
type S = { open: boolean }
export type PopoverProps = {
  name: string; label: string; trigger?: ReactNode; children?: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'
  open?: boolean; defaultOpen?: boolean; onOpenChange?(open: boolean): void
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'trigger' | 'content', S>
}

const usePopover = defineWidget<PopoverProps, S, C>({
  kind: 'popover',
  state: (p) => ({ open: !!p.open }),
  controls: ({ props: p, el }): C => {
    const click = async (_a: unknown, ctx: Parameters<Control['run']>[1]) => { inner<HTMLButtonElement>(ctx, el(), '[data-part=trigger]').click() }
    return p.open ? { close: { kind: 'close', run: click } } : { open: { kind: 'open', run: click } }
  },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name }),
})

export function Popover(props: DefinedProps<PopoverProps, C>) {
  const { label, trigger, children, side = 'bottom', className, slots } = props
  const [open, setOpen] = useControllable<boolean>(props.open, props.defaultOpen ?? false)
  const set = (v: boolean) => { setOpen(v); props.onOpenChange?.(v) }
  const w = usePopover({ ...props, open })
  const ref = useRef<HTMLDivElement>(null)
  const s = { open }
  useEffect(() => {
    const d = ref.current
    if (!d || !open) return
    showPopover(d, true)
    const t = (e: Event) => { if ((e as Event & { newState?: string }).newState === 'closed') set(false) }
    d.addEventListener('toggle', t)
    return () => d.removeEventListener('toggle', t)
  }, [open])
  const st = { 'data-state': open ? 'open' : 'closed', 'data-side': side }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'popover', ...st }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>{part('button', { type: 'button', 'data-part': 'trigger', 'aria-haspopup': 'dialog', 'aria-expanded': open, ...st, onClick: () => set(!open) }, slots?.trigger, s, trigger ?? label)}</AutoOff>
    {open && part('div', { ref, popover: 'auto', role: 'dialog', 'aria-label': label, ...st }, slots?.content, s, children)}
  </>)
}
