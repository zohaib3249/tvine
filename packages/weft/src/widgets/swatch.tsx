'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control, WidgetSpec } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, setNative, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/swatch.md: variant picker = radio group of native radios, each with a text aria-label (never
// color-only). Unavailable variants stay visible but are not callable by agents and not selectable.
// `url` (e.g. "color") is the headless map: the agent's select becomes ?color=blue, so the server renders
// that variant's price/stock/image.
type C = Record<string, Control<any, any>>
export type SwatchOption = { value: string; label: string; color?: string; image?: string; available?: boolean; price?: string }
type S = { value: string | null; options: { value: string; available: boolean; price?: string }[] }
export type SwatchProps = {
  name: string; label: string; options: SwatchOption[]
  value?: string; defaultValue?: string; onValueChange?(v: string): void
  url?: string; action?: ActionHandle
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'item' | 'swatch' | 'itemLabel', S>
}

const open = (o: SwatchOption) => o.available !== false
const name = (o: SwatchOption) => [o.label, o.price, !open(o) && 'unavailable'].filter(Boolean).join(', ')

const useSwatch = defineWidget<SwatchProps, S, C>({
  kind: 'radio',
  state: (p) => ({ value: p.value || null, options: p.options.map((o) => ({ value: o.value, available: open(o), ...(o.price && { price: o.price }) })) }),
  controls: ({ props: p, el }) => ({
    select: { kind: 'select', params: { value: { type: 'string', enum: p.options.filter(open).map((o) => o.value) } },
      run: async (a: { value: string }, ctx) => { inner<HTMLInputElement>(ctx, el(), `input[value="${CSS.escape(a.value)}"]`).click() } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { select: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Swatch(props: DefinedProps<SwatchProps, C>) {
  const { name: n, label, options, value, defaultValue, onValueChange, disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? '')
  const w = useSwatch({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const onChange = (e: ChangeEvent<HTMLInputElement>) => { setV(e.target.value); onValueChange?.(e.target.value) }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'swatch', role: 'radiogroup', 'aria-labelledby': `${fid}-l`, 'data-disabled': flag(disabled) },
    { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('span', { id: `${fid}-l` }, slots?.label, s, label)}
      {options.map((o) => {
        const st = { 'data-state': v === o.value ? 'checked' : 'unchecked', 'data-unavailable': flag(!open(o)), 'data-disabled': flag(disabled || !open(o)) }
        return part('label', { key: o.value, ...st, style: o.color ? { '--swatch-color': o.color } : undefined }, slots?.item, s, <>
          {part('input', { type: 'radio', name: n, value: o.value, checked: v === o.value, disabled: disabled || !open(o), 'aria-label': name(o), onChange, ...st }, slots?.swatch, s)}
          {o.image && <img src={o.image} alt="" />}
          {part('span', {}, slots?.itemLabel, s, o.label)}
        </>)
      })}
    </AutoOff>
  </>)
}

// Free color: native <input type=color>; agents set any #rrggbb (presets are datalist suggestions only). Kind 'color' matches what the JSX runtime
// gives a bare <input type=color>, so agents see one shape either way.
type CS = { value: string }
export type ColorPickerProps = {
  name: string; label: string; value?: string; defaultValue?: string; onValueChange?(v: string): void
  presets?: string[]; action?: ActionHandle; url?: string
  className?: SlotProps<CS>['className']; slots?: Slots<'root' | 'label' | 'field', CS>
}
const HEX = '#[0-9a-fA-F]{6}'

const useColor = defineWidget<ColorPickerProps, CS, C>({
  kind: 'color' as WidgetSpec['kind'],
  state: (p) => ({ value: p.value ?? '#000000' }),
  controls: ({ el }) => ({
    set: { kind: 'set', params: { value: { type: 'string', pattern: HEX } },
      run: async (a: { value: string }, ctx) => {
        if (!new RegExp(`^${HEX}$`).test(a.value)) throw invalid('value', 'use #rrggbb')
        setNative(inner<HTMLInputElement>(ctx, el(), 'input'), a.value.toLowerCase())
      } },
  }),
  headless: (p) => { const h = headlessOf(p, 'any'); return h ? { set: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function ColorPicker(props: DefinedProps<ColorPickerProps, C>) {
  const { name: n, label, value, defaultValue, onValueChange, presets, disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? '#000000')
  const w = useColor({ ...props, value: v })
  const fid = useId()
  const s = { value: v }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'color', 'data-disabled': flag(disabled), style: { '--swatch-color': v } }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('input', { id: fid, type: 'color', name: n, value: v, disabled, list: presets?.length ? `${fid}-p` : undefined,
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setV(e.target.value); onValueChange?.(e.target.value) } }, slots?.field, s)}
      {presets?.length ? <datalist id={`${fid}-p`}>{presets.map((c) => <option key={c} value={c} />)}</datalist> : null}
    </AutoOff>
  </>)
}
