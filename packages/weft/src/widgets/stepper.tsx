'use client'
import { useId, useState, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/stepper.md: <nav aria-label="Progress"><ol> + one panel per step. `validate` is the veto
// hook: return {field: message} (or a string) and next() stays put, shows the errors, and the agent gets
// invalid_param with the field. Agent next/prev/go run the same handlers the buttons do.
// ponytail: flat `steps` + `validate` instead of Stepper.Root/Panel wrapping a <Form>; no session headless map.
type C = Record<string, Control<any, any>>
type Errors = Record<string, string>
type S = { value: string; done: string[]; errors?: Errors }
export type Step = { value: string; label: string; content: ReactNode; validate?(): Errors | string | void | Promise<Errors | string | void> }
export type StepperProps = {
  name: string; label: string; steps: Step[]
  value?: string; defaultValue?: string; onValueChange?(v: string): void
  linear?: boolean; url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'list' | 'item' | 'panel' | 'prev' | 'next' | 'error', S>
}
type Internal = StepperProps & { done?: string[]; move?(to: string, check: boolean): Promise<Errors | undefined> }

const useStepper = defineWidget<Internal, S, C>({
  kind: 'stepper',
  state: (p) => ({ value: p.value ?? '', done: p.done ?? [] }),
  controls: ({ props: p, el }) => {
    const i = p.steps.findIndex((s) => s.value === p.value)
    const move = async (to: string, check: boolean, sel: string, ctx: Parameters<Control['run']>[1]) => {
      inner(ctx, el(), sel)   // mounted check (unknown_action otherwise)
      const errs = await p.move!(to, check)
      if (errs) { const [f, m] = Object.entries(errs)[0]!; throw invalid(f, m) }
    }
    const reach = p.steps.filter((s, k) => !p.linear || k <= i || (p.done ?? []).includes(s.value)).map((s) => s.value)
    return {
      ...(i < p.steps.length - 1 && { next: { kind: 'navigate', run: (_: unknown, ctx) => move(p.steps[i + 1]!.value, true, '[data-step-next]', ctx) } }),
      ...(i > 0 && { prev: { kind: 'navigate', run: (_: unknown, ctx) => move(p.steps[i - 1]!.value, false, '[data-step-prev]', ctx) } }),
      go: { kind: 'navigate', params: { step: { type: 'string', enum: reach } }, run: (a: { step: string }, ctx) => move(a.step, false, 'ol', ctx) },
    } as C
  },
  headless: (p) => { const h = headlessOf(p); return h ? { go: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Stepper(props: DefinedProps<StepperProps, C>) {
  const { steps, value, defaultValue, onValueChange, linear, disabled, className, slots } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? steps[0]?.value ?? '')
  const [done, setDone] = useState<string[]>([])
  const [errors, setErrors] = useState<Errors | undefined>()
  const i = steps.findIndex((s) => s.value === v)
  const move = async (to: string, check: boolean): Promise<Errors | undefined> => {
    if (check) {
      const r = await steps[i]?.validate?.()
      const errs = typeof r === 'string' ? { step: r } : r && Object.keys(r).length ? r : undefined
      setErrors(errs)
      if (errs) return errs
      if (!done.includes(v)) setDone([...done, v])
    } else setErrors(undefined)
    if (to !== v) { setV(to); onValueChange?.(to) }
    return undefined
  }
  const w = useStepper({ ...props, value: v, done, move })
  const s = { value: v, done, errors }
  const id = useId()
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'stepper', 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      <nav aria-label="Progress">{part('ol', {}, slots?.list, s, steps.map((st, k) => {
        const state = st.value === v ? 'current' : done.includes(st.value) ? 'complete' : 'upcoming'
        const locked = disabled || (linear && k > i && !done.includes(st.value))
        return part('li', { key: st.value, 'data-state': state, 'data-disabled': flag(locked), 'aria-current': st.value === v ? 'step' : undefined }, slots?.item, s,
          <button type="button" disabled={locked} onClick={() => void move(st.value, false)}>{st.label}</button>)
      }))}</nav>
    </AutoOff>
    {steps.map((st) => part('section', { key: st.value, id: `${id}-${st.value}`, 'aria-label': st.label, hidden: st.value !== v, inert: st.value !== v || undefined }, slots?.panel, s, st.content))}
    <AutoOff>
      {errors && part('div', { role: 'alert' }, slots?.error, s, Object.values(errors).join(' '))}
      {i > 0 && part('button', { type: 'button', 'data-step-prev': '', disabled, onClick: () => void move(steps[i - 1]!.value, false) }, slots?.prev, s, 'Back')}
      {i < steps.length - 1 && part('button', { type: 'button', 'data-step-next': '', disabled, onClick: () => void move(steps[i + 1]!.value, true) }, slots?.next, s, 'Next')}
    </AutoOff>
  </>)
}
