'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, setNative, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/quantity.md: native number input (implicit role=spinbutton) + labelled − / + buttons.
// ponytail: `action` is the headless params map only; instant-apply (debounced cart.setQty) not built yet.
type C = Record<string, Control<any, any>>
type S = { value: number; min: number; max?: number }
export type QuantityProps = {
  name: string; label?: string; min?: number; max?: number; step?: number
  value?: number; defaultValue?: number; onValueChange?(v: number): void
  action?: ActionHandle
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'decrement' | 'input' | 'increment', S>
}

const useQuantity = defineWidget<QuantityProps, S, C>({
  kind: 'quantity',
  state: (p) => ({ value: p.value ?? p.min ?? 1, min: p.min ?? 1, ...(p.max !== undefined && { max: p.max }) }),
  controls: ({ props: p, el }) => {
    const min = p.min ?? 1, v = p.value ?? min, step = p.step ?? 1
    return {
      set: { kind: 'set', params: { value: { type: 'number', min, ...(p.max !== undefined && { max: p.max }) } },
        run: async (a: { value: number }, ctx) => { setNative(inner<HTMLInputElement>(ctx, el(), 'input'), String(a.value)) } },
      // At the bound the control is unlisted (honesty rule), like the disabled button.
      inc: { kind: 'set', enabled: p.max === undefined || v + step <= p.max, run: async (_a, ctx) => { inner<HTMLButtonElement>(ctx, el(), '[data-part=increment]').click() } },
      dec: { kind: 'set', enabled: v - step >= min, run: async (_a, ctx) => { inner<HTMLButtonElement>(ctx, el(), '[data-part=decrement]').click() } },
    }
  },
  headless: (p) => { const h = headlessOf(p); return h ? { set: h, inc: h, dec: h } : {} },
  describe: (p) => ({ label: p.label ?? 'Quantity' }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Quantity(props: DefinedProps<QuantityProps, C>) {
  const { name, label = 'Quantity', min = 1, max, step = 1, value, defaultValue, onValueChange, disabled, className, slots } = props
  const [v, setV] = useControllable<number>(value, defaultValue ?? min)
  const w = useQuantity({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const go = (n: number) => { if (Number.isNaN(n)) return; setV(n); onValueChange?.(n) }
  const atMin = v - step < min, atMax = max !== undefined && v + step > max
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'quantity', role: 'group', 'aria-labelledby': `${fid}-l`,
    'data-at-min': flag(atMin), 'data-at-max': flag(atMax), 'data-disabled': flag(disabled),
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { id: `${fid}-l`, htmlFor: fid }, slots?.label, s, label)}
      {part('button', { type: 'button', 'data-part': 'decrement', 'aria-label': `Decrease ${label}`, 'aria-controls': fid, disabled: disabled || atMin, onClick: () => go(v - step) }, slots?.decrement, s, '−')}
      {part('input', {
        id: fid, type: 'number', inputMode: 'numeric', name, min, max, step, value: v, disabled,
        onChange: (e: ChangeEvent<HTMLInputElement>) => go(e.target.valueAsNumber),
      }, slots?.input, s)}
      {part('button', { type: 'button', 'data-part': 'increment', 'aria-label': `Increase ${label}`, 'aria-controls': fid, disabled: disabled || atMax, onClick: () => go(v + step) }, slots?.increment, s, '+')}
    </AutoOff>
  </>)
}
