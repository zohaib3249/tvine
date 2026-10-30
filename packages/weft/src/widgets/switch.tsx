'use client'
import { useId } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/switch.md: APG Switch (<button role=switch aria-checked>) + a hidden input so forms post it.
// ponytail: `action` is the headless params map only; instant-apply (dispatch on flip, revert on error) not built yet.
type C = Record<string, Control<any, any>>
type S = { on: boolean }
export type SwitchProps = {
  name: string; label: string; checked?: boolean; defaultChecked?: boolean
  onCheckedChange?(v: boolean): void
  action?: ActionHandle; url?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'thumb' | 'label', S>
}

const useSwitch = defineWidget<SwitchProps, S, C>({
  kind: 'switch',
  state: (p) => ({ on: !!p.checked }),
  controls: ({ props: p, el }) => ({
    toggle: { kind: 'toggle', params: { on: { type: 'boolean', optional: true } }, run: async (a: { on?: boolean }, ctx) => {
      if (a.on === undefined || a.on !== !!p.checked) inner<HTMLButtonElement>(ctx, el(), '[role=switch]').click()
    } },
  }),
  headless: (p) => { const h = headlessOf(p); return h ? { toggle: h } : {} },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Switch(props: DefinedProps<SwitchProps, C>) {
  const { name, label, checked, defaultChecked, onCheckedChange, disabled, className, slots } = props
  const [on, setOn] = useControllable<boolean>(checked, defaultChecked ?? false)
  const w = useSwitch({ ...props, checked: on })
  const s = { on }
  const fid = useId()
  const st = { 'data-state': on ? 'on' : 'off', 'data-disabled': flag(disabled) }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'switch', ...st }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('button', {
        type: 'button', role: 'switch', id: fid, 'aria-checked': on, disabled, ...st,
        onClick: () => { setOn(!on); onCheckedChange?.(!on) },
      }, { ...slots?.thumb }, s)}
      <input type="hidden" name={name} value={on ? 'true' : 'false'} disabled={disabled} />
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
    </AutoOff>
  </>)
}
