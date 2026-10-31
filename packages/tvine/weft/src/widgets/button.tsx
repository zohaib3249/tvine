'use client'
import type { MouseEvent, ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { flag, inner, part, useControllable, type SlotProps } from './_parts.js'

// widgets/button.md: APG Button over native <button>; `pressed` makes it a toggle (aria-pressed).
// ponytail: no `action`/`bind` form sugar (the v1 server <Button> has it) and no `confirm`; add when a page needs it here.
type C = Record<string, Control<any, any>>
type S = { pressed?: boolean; disabled: boolean }
export type ButtonProps = SlotProps<S> & {
  name: string; label?: string; intent?: string; type?: 'button' | 'submit' | 'reset'
  pressed?: boolean; defaultPressed?: boolean; onPressedChange?(v: boolean): void
  onClick?(e: MouseEvent<HTMLButtonElement>): void
  children: ReactNode
}

const useButton = defineWidget<ButtonProps, S, C>({
  kind: 'button',
  state: (p) => (p.pressed === undefined ? {} : { pressed: p.pressed }) as S,
  controls: ({ el }) => ({
    click: { kind: 'click', run: async (_: unknown, ctx) => { (el() ?? inner<HTMLButtonElement>(ctx, null, 'button')).click() } },
  }),
  describe: (p) => ({ label: p.label ?? (typeof p.children === 'string' ? p.children : p.name), ...(p.intent && { summary: [`intent: ${p.intent}`] }) }),
  spec: (p) => ({ name: p.name }),
})

export function Button(props: DefinedProps<ButtonProps, C>) {
  const { type = 'button', pressed, defaultPressed, onPressedChange, onClick, disabled, children } = props
  const toggle = pressed !== undefined || defaultPressed !== undefined
  const [on, setOn] = useControllable<boolean>(pressed, defaultPressed ?? false)
  const w = useButton({ ...props, pressed: toggle ? on : undefined })
  const s = { pressed: toggle ? on : undefined, disabled: !!disabled }
  return <>{w.embed}{part('button', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'button', type, disabled, 'aria-pressed': toggle ? on : undefined,
    'data-state': toggle ? (on ? 'on' : 'off') : undefined, 'data-disabled': flag(disabled),
    onClick: (e: MouseEvent<HTMLButtonElement>) => { onClick?.(e); if (toggle && !e.defaultPrevented) { setOn(!on); onPressedChange?.(!on) } },
  }, props, s, children)}</>
}
