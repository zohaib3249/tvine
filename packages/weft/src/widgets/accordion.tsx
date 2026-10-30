'use client'
import { useId, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/accordion.md: APG Accordion. Closed panels are SSR'd `hidden` so headless agents read them.
// ponytail: flat `items` instead of Accordion.Root/Item/Trigger/Panel compound parts.
type C = Record<string, Control<any, any>>
type S = { open: string[] }
export type AccordionItem = { value: string; label: string; content: ReactNode; disabled?: boolean }
export type AccordionProps = {
  name: string; label: string; items: AccordionItem[]; type?: 'single' | 'multiple'; collapsible?: boolean
  value?: string[]; defaultValue?: string[]; onValueChange?(v: string[]): void
  url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'item' | 'trigger' | 'panel', S>
}

const useAccordion = defineWidget<AccordionProps, S, C>({
  kind: 'accordion',
  state: (p) => ({ open: p.value ?? [] }),
  controls: ({ props: p, el }) => ({
    toggle: { kind: 'toggle', params: { value: { type: 'string', enum: p.items.filter((i) => !i.disabled).map((i) => i.value) }, open: { type: 'boolean', optional: true } },
      run: async (a: { value: string; open?: boolean }, ctx) => {
        if (a.open === undefined || a.open !== (p.value ?? []).includes(a.value))
          inner<HTMLButtonElement>(ctx, el(), `button[data-value="${CSS.escape(a.value)}"]`).click()
      } },
  }),
  headless: (p) => ({ toggle: headlessOf(p, 'any') ?? { rendered: true } }),
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Accordion(props: DefinedProps<AccordionProps, C>) {
  const { items, type = 'single', collapsible = true, value, defaultValue, onValueChange, disabled, className, slots } = props
  const [open, setOpen] = useControllable<string[]>(value, defaultValue ?? [])
  const w = useAccordion({ ...props, value: open })
  const s = { open }
  const id = useId()
  const flip = (x: string) => {
    const was = open.includes(x)
    if (was && type === 'single' && !collapsible) return
    const next = was ? open.filter((o) => o !== x) : type === 'single' ? [x] : [...open, x]
    setOpen(next); onValueChange?.(next)
  }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'accordion', 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    {items.map((t) => {
        const on = open.includes(t.value), st = { 'data-state': on ? 'open' : 'closed', 'data-disabled': flag(disabled || t.disabled) }
        return part('div', { key: t.value, ...st }, slots?.item, s, <>
          <h3><AutoOff>{part('button', {
            type: 'button', id: `${id}-t-${t.value}`, 'aria-expanded': on, 'aria-controls': `${id}-p-${t.value}`, 'data-value': t.value,
            disabled: disabled || t.disabled, onClick: () => flip(t.value), ...st,
          }, slots?.trigger, s, t.label)}</AutoOff></h3>
          {part('div', { role: 'region', id: `${id}-p-${t.value}`, 'aria-labelledby': `${id}-t-${t.value}`, hidden: !on, inert: !on || undefined, ...st }, slots?.panel, s, t.content)}
        </>)
      })}
  </>)
}
