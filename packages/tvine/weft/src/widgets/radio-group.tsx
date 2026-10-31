'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/radio-group.md: role=radiogroup over native radios (the browser gives arrows + roving focus).
type C = Record<string, Control<any, any>>
type S = { value: string | null }
export type RadioGroupProps = {
  name: string; label: string; options: { value: string; label: string; disabled?: boolean }[]
  value?: string; defaultValue?: string; onValueChange?(v: string): void
  orientation?: 'horizontal' | 'vertical'; required?: boolean
  action?: ActionHandle; url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'item' | 'input' | 'itemLabel', S>
}

const useRadio = defineWidget<RadioGroupProps, S, C>({
  kind: 'radio',
  state: (p) => ({ value: p.value || null }),
  controls: ({ props: p, el }) => ({
    select: { kind: 'select', params: { value: { type: 'string', enum: p.options.filter((o) => !o.disabled).map((o) => o.value) } },
      run: async (a: { value: string }, ctx) => { inner<HTMLInputElement>(ctx, el(), `input[value="${CSS.escape(a.value)}"]`).click() } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { select: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function RadioGroup(props: DefinedProps<RadioGroupProps, C>) {
  const { name, label, options, value, defaultValue, onValueChange, orientation = 'vertical', required, disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? '')
  const w = useRadio({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const onChange = (e: ChangeEvent<HTMLInputElement>) => { setV(e.target.value); onValueChange?.(e.target.value) }
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'radio', role: 'radiogroup', 'aria-labelledby': `${fid}-l`, 'aria-orientation': orientation,
    'aria-required': required || undefined, 'data-orientation': orientation, 'data-disabled': flag(disabled),
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('span', { id: `${fid}-l` }, slots?.label, s, label)}
      {options.map((o) => {
        const st = { 'data-state': v === o.value ? 'checked' : 'unchecked', 'data-disabled': flag(disabled || o.disabled) }
        return part('div', { key: o.value, ...st }, slots?.item, s, <>
          {part('input', { id: `${fid}-${o.value}`, type: 'radio', name, value: o.value, checked: v === o.value, required, disabled: disabled || o.disabled, onChange, ...st }, slots?.input, s)}
          {part('label', { htmlFor: `${fid}-${o.value}` }, slots?.itemLabel, s, o.label)}
        </>)
      })}
    </AutoOff>
  </>)
}
