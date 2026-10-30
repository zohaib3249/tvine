'use client'
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/tabs.md: APG Tabs. Every panel is SSR'd (inactive `hidden inert`) so headless agents read them all;
// only the triggers sit under AutoOff, so plain fields inside panels register on their own.
// ponytail: flat `items` instead of Tabs.Root/List/Trigger/Panel compound parts; add those when a layout needs them.
type C = Record<string, Control<any, any>>
type S = { value: string }
export type TabItem = { value: string; label: string; content: ReactNode; disabled?: boolean }
export type TabsProps = {
  name: string; label: string; items: TabItem[]
  value?: string; defaultValue?: string; onValueChange?(v: string): void
  url?: string; activation?: 'automatic' | 'manual'; orientation?: 'horizontal' | 'vertical'
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'list' | 'trigger' | 'panel', S>
}

const useTabs = defineWidget<TabsProps, S, C>({
  kind: 'tabs',
  state: (p) => ({ value: p.value ?? '' }),
  controls: ({ props: p, el }) => ({
    select: { kind: 'select', params: { value: { type: 'string', enum: p.items.filter((i) => !i.disabled).map((i) => i.value) } },
      run: async (a: { value: string }, ctx) => { inner<HTMLButtonElement>(ctx, el(), `[role=tab][data-value="${CSS.escape(a.value)}"]`).click() } },
  }),
  headless: (p) => ({ select: headlessOf(p) ?? { rendered: true } }),
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Tabs(props: DefinedProps<TabsProps, C>) {
  const { items, value, defaultValue, onValueChange, orientation = 'horizontal', activation = 'automatic', disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? items.find((i) => !i.disabled)?.value ?? '')
  const w = useTabs({ ...props, value: v })
  const s = { value: v }
  const id = useId()
  const pick = (x: string) => { if (x !== v) { setV(x); onValueChange?.(x) } }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]:not([disabled])')]
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement), n = tabs.length
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key]
    if (next === undefined || !n) return
    e.preventDefault()
    const t = tabs[(next + n) % n]!
    t.focus(); if (activation === 'automatic') t.click()
  }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'tabs', 'data-orientation': orientation, 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('div', { role: 'tablist', 'aria-label': props.label, 'aria-orientation': orientation, onKeyDown: onKey }, slots?.list, s,
        items.map((t) => {
          const on = t.value === v
          return part('button', {
            key: t.value, type: 'button', role: 'tab', id: `${id}-t-${t.value}`, 'aria-selected': on, 'aria-controls': `${id}-p-${t.value}`,
            tabIndex: on ? 0 : -1, disabled: disabled || t.disabled, 'data-value': t.value, 'data-state': on ? 'active' : 'inactive',
            'data-disabled': flag(disabled || t.disabled), onClick: () => pick(t.value),
          }, slots?.trigger, s, t.label)
        }))}
    </AutoOff>
    {items.map((t) => part('div', {
        key: t.value, role: 'tabpanel', id: `${id}-p-${t.value}`, 'aria-labelledby': `${id}-t-${t.value}`, tabIndex: 0,
        hidden: t.value !== v, inert: t.value !== v || undefined, 'data-state': t.value === v ? 'active' : 'inactive',
      }, slots?.panel, s, t.content))}
  </>)
}
