'use client'
import { useId, type ChangeEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, setNative, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/date-picker.md: native <input type="date">. Agents speak ISO yyyy-mm-dd only and set the value
// directly (no calendar clicking); min/max/isDisabled are refused before the field changes. ISO strings are
// compared as strings, so no Date/timezone math can shift the day.
// ponytail: no `range` or `calendar` (APG dialog grid) mode; native only. Add when a booking flow needs them.
type C = Record<string, Control<any, any>>
type S = { value: string | null }
export type DatePickerProps = {
  name: string; label: string
  value?: string; defaultValue?: string; onValueChange?(v: string | null): void
  min?: string; max?: string; isDisabled?(d: string): boolean; required?: boolean
  action?: ActionHandle; url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'field', S>
}

const ISO = '\\d{4}-\\d{2}-\\d{2}'
// A real calendar day: 2026-02-30 parses in JS, but does not round-trip.
const realDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d }

const useDate = defineWidget<DatePickerProps, S, C>({
  kind: 'date',
  state: (p) => ({ value: p.value || null }),
  controls: ({ props: p, el }) => {
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLInputElement>(ctx, el(), 'input')
    const c: C = {
      set: { kind: 'set', params: { value: { type: 'date', pattern: ISO } },
        run: async (a: { value: string }, ctx) => {
          const d = a.value
          if (!realDay(d)) throw invalid('value', `${d} is not a calendar date (use YYYY-MM-DD)`)
          if (p.min && d < p.min) throw invalid('value', `${d} is before ${p.min}`)
          if (p.max && d > p.max) throw invalid('value', `${d} is after ${p.max}`)
          if (p.isDisabled?.(d)) throw invalid('value', `${d} is unavailable`)
          setNative(field(ctx), d)
        } },
    }
    if (!p.required) c.clear = { kind: 'clear', run: async (_a, ctx) => { setNative(field(ctx), '') } }
    return c
  },
  headless: (p) => { const h = headlessOf(p, 'any'); return h ? { set: h, clear: h } : {} },
  describe: (p) => ({ label: p.label, ...((p.min || p.max) && { summary: [`dates ${p.min ?? ''}..${p.max ?? ''}`] }) }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function DatePicker(props: DefinedProps<DatePickerProps, C>) {
  const { name, label, value, defaultValue, onValueChange, min, max, isDisabled, required, disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? '')
  const w = useDate({ ...props, value: v })
  const s = w.state
  const fid = useId()
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value
    // Humans get the same rule as agents: an unavailable day marks the field invalid and is not a value.
    const off = !!d && !!isDisabled?.(d)
    e.target.setCustomValidity(off ? `${d} is unavailable` : '')
    setV(d); onValueChange?.(d && !off ? d : null)
  }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'date', 'data-disabled': flag(disabled), 'data-filled': flag(v) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('input', { id: fid, type: 'date', name, value: v, min, max, required, disabled, onChange }, slots?.field, s)}
    </AutoOff>
  </>)
}
