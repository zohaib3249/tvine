'use client'
import { useEffect, useId, useRef, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/checkbox.md: APG Checkbox on native <input type=checkbox>; group = <fieldset> + <legend>.
type C = Record<string, Control<any, any>>
export type Checked = boolean | 'indeterminate'
const dataState = (c: Checked) => (c === 'indeterminate' ? 'indeterminate' : c ? 'checked' : 'unchecked')

export type CheckboxProps = {
  name: string; label: string; checked?: Checked; defaultChecked?: boolean
  onCheckedChange?(v: boolean): void; value?: string; required?: boolean
  action?: ActionHandle; url?: string
  className?: SlotProps<{ checked: Checked }>['className']; slots?: Slots<'root' | 'input' | 'label', { checked: Checked }>
}

const useCheckbox = defineWidget<CheckboxProps, { checked: Checked }, C>({
  kind: 'checkbox',
  state: (p) => ({ checked: p.checked ?? false }),
  controls: ({ props: p, el }) => ({
    toggle: { kind: 'toggle', params: { on: { type: 'boolean', optional: true } }, run: async (a: { on?: boolean }, ctx) => {
      const f = inner<HTMLInputElement>(ctx, el(), 'input')
      // on:true on checked = no-op ok; indeterminate → checked.
      if (a.on === undefined || a.on !== (p.checked === true)) f.click()
    } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { toggle: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Checkbox(props: DefinedProps<CheckboxProps, C>) {
  const { name, label, checked, defaultChecked, onCheckedChange, value, required, disabled, className, slots } = props
  const [c, setC] = useControllable<Checked>(checked, defaultChecked ?? false)
  const w = useCheckbox({ ...props, checked: c })
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = c === 'indeterminate' }, [c])
  const fid = useId()
  const s = { checked: c }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'checkbox', 'data-state': dataState(c), 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('input', {
        ref, id: fid, type: 'checkbox', name, value, required, disabled, checked: c === true,
        'aria-checked': c === 'indeterminate' ? 'mixed' : undefined, 'data-state': dataState(c),
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setC(e.target.checked); onCheckedChange?.(e.target.checked) },
      }, slots?.input, s)}
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
    </AutoOff>
  </>)
}

export type CheckboxGroupProps = {
  name: string; label: string; options: { value: string; label: string; disabled?: boolean }[]
  value?: string[]; defaultValue?: string[]; onValueChange?(v: string[]): void
  action?: ActionHandle; url?: string
  className?: SlotProps<{ values: string[] }>['className']; slots?: Slots<'root' | 'legend' | 'item' | 'input' | 'label', { values: string[] }>
}

const useGroup = defineWidget<CheckboxGroupProps, { values: string[] }, C>({
  kind: 'checkbox',
  state: (p) => ({ values: p.value ?? [] }),
  controls: ({ props: p, el }) => ({
    select: { kind: 'select', params: { values: { type: 'string', enum: p.options.filter((o) => !o.disabled).map((o) => o.value), multiple: true } },
      run: async (a: { values: string[] }, ctx) => {
        for (const o of p.options) {
          const f = inner<HTMLInputElement>(ctx, el(), `input[value="${CSS.escape(o.value)}"]`)
          if (f.checked !== a.values.includes(o.value)) f.click()
        }
      } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { select: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function CheckboxGroup(props: DefinedProps<CheckboxGroupProps, C>) {
  const { name, label, options, value, defaultValue, onValueChange, disabled, className, slots } = props
  const [v, setV] = useControllable<string[]>(value, defaultValue ?? [])
  const w = useGroup({ ...props, value: v })
  const s = { values: v }
  const fid = useId()
  // The DOM is the truth for the group: several agent clicks in one tick each see the previous one.
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = [...(e.target.form?.elements ?? e.target.closest('fieldset')!.elements)]
      .filter((x): x is HTMLInputElement => x instanceof HTMLInputElement && x.name === name && x.checked).map((x) => x.value)
    setV(next); onValueChange?.(next)
  }
  return part('fieldset', { ref: w.ref, ...w.props, 'data-tvine-widget': 'checkbox', disabled, 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('legend', {}, slots?.legend, s, label)}
      {options.map((o) => {
        const on = v.includes(o.value)
        return part('div', { key: o.value, 'data-state': on ? 'checked' : 'unchecked' }, slots?.item, s, <>
          {part('input', { id: `${fid}-${o.value}`, type: 'checkbox', name, value: o.value, checked: on, disabled: o.disabled, onChange, 'data-state': on ? 'checked' : 'unchecked' }, slots?.input, s)}
          {part('label', { htmlFor: `${fid}-${o.value}` }, slots?.label, s, o.label)}
        </>)
      })}
    </AutoOff>
  </>)
}
