'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, headlessOf, inner, invalid, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/rating.md: input = radiogroup of native star radios ("4 stars"); read-only = role=img, no controls.
type C = Record<string, Control<any, any>>
type S = { value: number | null; max: number }
export type RatingProps = {
  name?: string; label: string; max?: number; value?: number; defaultValue?: number
  onValueChange?(v: number): void; readOnly?: boolean; allowHalf?: boolean
  action?: ActionHandle
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'item' | 'input' | 'icon', S>
}

const stepsOf = (p: RatingProps) => {
  const max = p.max ?? 5, d = p.allowHalf ? 0.5 : 1
  return Array.from({ length: max / d }, (_, i) => (i + 1) * d)
}

const useRating = defineWidget<RatingProps, S, C>({
  kind: 'rating',
  state: (p) => ({ value: p.value || null, max: p.max ?? 5 }),
  controls: ({ props: p, el }): C => p.readOnly ? {} : {
    set: { kind: 'set', params: { value: { type: 'number', min: p.allowHalf ? 0.5 : 1, max: p.max ?? 5, ...(p.allowHalf && { step: 0.5 }) } },
      run: async (a: { value: number }, ctx) => {
        if (!stepsOf(p).includes(a.value)) throw invalid('value', p.allowHalf ? 'value must be a multiple of 0.5' : 'value must be a whole number')
        inner<HTMLInputElement>(ctx, el(), `input[value="${a.value}"]`).click()
      } },
  },
  headless: (p) => { const h = headlessOf(p); return h ? { set: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ ...(p.name && { name: p.name }), changesContent: !p.readOnly }),
})

export function Rating(props: DefinedProps<RatingProps, C>) {
  const { name, label, max = 5, value, defaultValue, onValueChange, readOnly, disabled, className, slots } = props
  const [v, setV] = useControllable<number>(value, defaultValue ?? 0)
  const w = useRating({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const pct = `${(v / max) * 100}%`
  const icon = (n: number) => part('span', { 'aria-hidden': true, 'data-state': v >= n ? 'full' : v >= n - 0.5 ? 'half' : 'empty' }, slots?.icon, s)
  if (readOnly) {
    return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'rating', role: 'img', 'aria-label': `${v} out of ${max}`, 'data-readonly': '', style: { '--rating-percent': pct } },
      { className, ...slots?.root }, s, <>{w.embed}{Array.from({ length: max }, (_, i) => <span key={i}>{icon(i + 1)}</span>)}</>)
  }
  const onChange = (e: ChangeEvent<HTMLInputElement>) => { const n = Number(e.target.value); setV(n); onValueChange?.(n) }
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'rating', role: 'radiogroup', 'aria-label': label, 'data-disabled': disabled ? '' : undefined,
    style: { '--rating-percent': pct },
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {stepsOf(props).map((n) => part('label', { key: n, 'data-state': v >= n ? 'full' : 'empty' }, slots?.item, s, <>
        {part('input', { type: 'radio', name: name ?? fid, value: n, checked: v === n, disabled, 'aria-label': `${n} star${n === 1 ? '' : 's'}`, onChange }, slots?.input, s)}
        {icon(n)}
      </>))}
    </AutoOff>
  </>)
}
