'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, setNative, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/select.md: native <select> (best a11y everywhere).
// ponytail: no `custom` listbox mode yet; native only. Add the APG select-only combobox when a design needs it.
export type SelectOption = { value: string; label: string; disabled?: boolean; group?: string }
export type SelectProps = {
  name: string; label: string; options: SelectOption[]
  value?: string | string[]; defaultValue?: string | string[]; multiple?: boolean
  onValueChange?(v: string | string[]): void
  placeholder?: string; required?: boolean
  action?: ActionHandle; url?: string
  className?: SlotProps<SelectState>['className']; slots?: Slots<'root' | 'label' | 'field' | 'option', SelectState>
}
export type SelectState = { value: string | null } | { values: string[] }
type C = Record<string, Control<any, any>>

const useSelect = defineWidget<SelectProps, SelectState, C>({
  kind: 'select',
  state: (p) => p.multiple ? { values: [p.value ?? []].flat() } : { value: (p.value as string) || null },
  controls: ({ props: p, el }) => {
    const values = p.options.filter((o) => !o.disabled).map((o) => o.value)
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLSelectElement>(ctx, el(), 'select')
    const c: C = p.multiple
      ? { select: { kind: 'select', params: { values: { type: 'string', enum: values, multiple: true } }, run: async (a: { values: string[] }, ctx) => {
          const f = field(ctx)
          for (const o of f.options) o.selected = a.values.includes(o.value)
          f.dispatchEvent(new Event('change', { bubbles: true }))
        } } }
      : { select: { kind: 'select', params: { value: { type: 'string', enum: values } }, run: async (a: { value: string }, ctx) => { setNative(field(ctx), a.value) } } }
    if (!p.required && (p.multiple || p.placeholder !== undefined)) {
      c.clear = { kind: 'clear', run: async (_a, ctx) => {
        const f = field(ctx)
        if (p.multiple) { for (const o of f.options) o.selected = false; f.dispatchEvent(new Event('change', { bubbles: true })) } else setNative(f, '')
      } }
    }
    return c
  },
  headless: (p) => { const h = headlessOf(p); return h ? { select: h, clear: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Select(props: DefinedProps<SelectProps, C>) {
  const { name, label, options, value, defaultValue, multiple, onValueChange, placeholder, required, disabled, className, slots } = props
  const [v, setV] = useControllable<string | string[]>(value, defaultValue ?? (multiple ? [] : ''))
  const w = useSelect({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const groups = [...new Set(options.map((o) => o.group))]
  const opt = (o: SelectOption) => part('option', { key: o.value, value: o.value, disabled: o.disabled, 'data-selected': flag([v].flat().includes(o.value)) }, slots?.option, s, o.label)
  const empty = multiple ? !(v as string[]).length : !v
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'select', 'data-disabled': flag(disabled), 'data-placeholder': flag(empty) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('select', {
        id: fid, name, multiple, required, disabled, value: v,
        onChange: (e: ChangeEvent<HTMLSelectElement>) => {
          const next = multiple ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value
          setV(next); onValueChange?.(next)
        },
      }, slots?.field, s, <>
        {!multiple && placeholder !== undefined && <option value="">{placeholder}</option>}
        {groups.map((g) => g === undefined ? options.filter((o) => !o.group).map(opt) : <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map(opt)}</optgroup>)}
      </>)}
    </AutoOff>
  </>)
}
