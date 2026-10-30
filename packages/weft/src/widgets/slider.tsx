'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, setNative, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/slider.md: native <input type=range> (implicit role=slider, arrows/PageUp/Home/End).
// ponytail: single thumb only; a two-thumb range is two Sliders in a group until a real need for [a,b].
type C = Record<string, Control<any, any>>
type S = { value: number; text?: string }
export type SliderProps = {
  name: string; label: string; min: number; max: number; step?: number
  value?: number; defaultValue?: number; onValueChange?(v: number): void
  format?(v: number): string; orientation?: 'horizontal' | 'vertical'
  action?: ActionHandle; url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'input' | 'output', S>
}

const snap = (p: SliderProps, v: number) => {
  const step = p.step ?? 1
  return Math.min(p.max, Math.max(p.min, +(p.min + Math.round((v - p.min) / step) * step).toFixed(10)))
}

const useSlider = defineWidget<SliderProps, S, C>({
  kind: 'slider',
  state: (p) => { const value = p.value ?? p.min; return p.format ? { value, text: p.format(value) } : { value } },
  controls: ({ props: p, el }) => ({
    set: { kind: 'set', params: { value: { type: 'number', min: p.min, max: p.max, ...(p.step && { step: p.step }) } },
      run: async (a: { value: number }, ctx) => { setNative(inner<HTMLInputElement>(ctx, el(), 'input'), String(snap(p, a.value))) } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { set: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Slider(props: DefinedProps<SliderProps, C>) {
  const { name, label, min, max, step = 1, value, defaultValue, onValueChange, format, orientation = 'horizontal', disabled, className, slots } = props
  const [v, setV] = useControllable<number>(value, defaultValue ?? min)
  const w = useSlider({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'slider', 'data-orientation': orientation, 'data-disabled': flag(disabled),
    style: { '--slider-percent': `${pct}%` },
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('input', {
        id: fid, type: 'range', name, min, max, step, value: v, disabled, 'aria-orientation': orientation,
        'aria-valuetext': format?.(v),
        onChange: (e: ChangeEvent<HTMLInputElement>) => { const n = e.target.valueAsNumber; setV(n); onValueChange?.(n) },
      }, slots?.input, s)}
      {part('output', { htmlFor: fid }, slots?.output, s, format ? format(v) : String(v))}
    </AutoOff>
  </>)
}
