'use client'
import { useId, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control, ParamSpec } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, typeText, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/input.md: native <input> + <label>; errors via aria-invalid + aria-describedby.
type Base = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'className' | 'style' | 'children'>
export type InputProps = Base & {
  name: string
  type?: 'text' | 'number' | 'email' | 'password' | 'search' | 'url' | 'tel'
  label?: string
  value?: string | number; defaultValue?: string | number
  onValueChange?(v: string): void
  sensitive?: boolean                      // auto for password / autocomplete=*password / cc-*
  error?: string; description?: string
  action?: ActionHandle; url?: string      // headless: form params, or ?url=value (search)
  className?: SlotProps<InputState>['className']; slots?: Slots<'root' | 'label' | 'field' | 'description' | 'error', InputState>
}
export type InputState = { value: string | number | null; invalid?: string }

// Password is always sensitive: sensitive={false} never unmasks it.
const isSensitive = (p: InputProps) => !!p.sensitive || p.type === 'password' || /password|(^|\s)cc-/i.test(String(p.autoComplete ?? ''))

const useInput = defineWidget<InputProps, InputState, Record<string, Control<any, any>>>({
  kind: 'input',
  state: (p) => {
    const v = p.value ?? ''
    const value = p.type === 'number' ? (v === '' ? null : Number(v)) : String(v)
    return p.error ? { value, invalid: p.error } : { value }
  },
  controls: ({ props: p, el }) => {
    const text: ParamSpec = p.type === 'number'
      ? { type: 'number', ...(p.min !== undefined && { min: Number(p.min) }), ...(p.max !== undefined && { max: Number(p.max) }) }
      : { type: 'string', ...(p.maxLength !== undefined && { maxLength: p.maxLength }), ...(p.pattern && { pattern: p.pattern }), ...(isSensitive(p) && { secret: true }) }
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLInputElement>(ctx, el(), 'input')
    return {
      input: {
        kind: 'input',
        params: { text, mode: { type: 'string', enum: ['replace', 'append'], optional: true } },
        run: async (a: { text: string | number; mode?: string }, ctx) => {
          const f = field(ctx)
          const next = a.mode === 'append' ? f.value + String(a.text) : String(a.text)
          if (p.maxLength !== undefined && next.length > p.maxLength) throw invalid('text', `text is longer than ${p.maxLength}`)
          await typeText(ctx, f, next)
        },
      },
      clear: { kind: 'clear', run: async (_a, ctx) => { await typeText(ctx, field(ctx), '') } },
    }
  },
  headless: (p) => { const h = headlessOf(p, p.type === 'number' ? 'enum' : 'any'); return h ? { input: h, clear: h } : {} },
  describe: (p) => ({ label: p.label ?? p.name }),
  spec: (p) => ({ name: p.name, sensitive: isSensitive(p), changesContent: true }),
})

export function Input(props: DefinedProps<InputProps, Record<string, Control<any, any>>>) {
  const { name, type = 'text', label, value, defaultValue, onValueChange, onChange, sensitive, error, description, action, url,
    className, slots, controls, hooks, presence, id, disabled, readOnly, ...rest } = props
  const [v, setV] = useControllable<string | number>(value, defaultValue ?? '')
  const w = useInput({ ...props, value: v, disabled: disabled || readOnly })
  const s = w.state as InputState
  const fid = useId()
  const describedBy = [description && `${fid}-d`, error && `${fid}-e`].filter(Boolean).join(' ') || undefined
  const root = {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'input',
    'data-invalid': flag(error), 'data-disabled': flag(disabled), 'data-readonly': flag(readOnly), 'data-filled': flag(v !== '' && v != null),
  }
  return part('div', root, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {label && part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('input', {
        ...rest, id: fid, name, type, value: v, disabled, readOnly,
        inputMode: type === 'number' ? 'decimal' : rest.inputMode,
        'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setV(e.target.value); onChange?.(e); onValueChange?.(e.target.value) },
      }, slots?.field, s)}
      {description && part('p', { id: `${fid}-d` }, slots?.description, s, description)}
      {error && part('p', { id: `${fid}-e`, role: 'alert' }, slots?.error, s, error)}
    </AutoOff>
  </>)
}
