'use client'
import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type TextareaHTMLAttributes } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, typeText, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/textarea.md: native <textarea> + label; counter/errors via aria-describedby.
type C = Record<string, Control<any, any>>
export type TextareaState = { value: string; length: number; max?: number; invalid?: string }
type Base = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'className' | 'style' | 'children'>
export type TextareaProps = Base & {
  name: string; label?: string; value?: string; defaultValue?: string; onValueChange?(v: string): void
  autoGrow?: boolean; showCount?: boolean; error?: string
  action?: ActionHandle
  className?: SlotProps<TextareaState>['className']; slots?: Slots<'root' | 'label' | 'field' | 'count' | 'error', TextareaState>
}

const useTextarea = defineWidget<TextareaProps, TextareaState, C>({
  kind: 'textarea',
  // ponytail: value is sent whole; the L1 200-char cut belongs to the snapshot shaper.
  state: (p) => {
    const value = p.value ?? ''
    return { value, length: value.length, ...(p.maxLength !== undefined && { max: p.maxLength }), ...(p.error && { invalid: p.error }) }
  },
  controls: ({ props: p, el }) => {
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLTextAreaElement>(ctx, el(), 'textarea')
    return {
      input: { kind: 'input',
        params: { text: { type: 'string', ...(p.maxLength !== undefined && { maxLength: p.maxLength }) }, mode: { type: 'string', enum: ['replace', 'append'], optional: true } },
        run: async (a: { text: string; mode?: string }, ctx) => {
          const f = field(ctx)
          const next = a.mode === 'append' ? f.value + a.text : a.text
          if (p.maxLength !== undefined && next.length > p.maxLength) throw invalid('text', `text is longer than ${p.maxLength}`)
          await typeText(ctx, f, next)
        } },
      clear: { kind: 'clear', run: async (_a, ctx) => { await typeText(ctx, field(ctx), '') } },
    }
  },
  headless: (p) => (p.action ? { input: headlessOf(p)!, clear: headlessOf(p)! } : {}),
  describe: (p) => ({ label: p.label ?? p.name }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function Textarea(props: DefinedProps<TextareaProps, C>) {
  const { name, label, value, defaultValue, onValueChange, onChange, autoGrow, showCount, error, action, className, slots,
    controls, hooks, presence, id, disabled, readOnly, ...rest } = props
  const [v, setV] = useControllable<string>(value, defaultValue ?? '')
  const w = useTextarea({ ...props, value: v, disabled: disabled || readOnly })
  const s = w.state
  const fid = useId()
  const ta = useRef<HTMLTextAreaElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!autoGrow || !ta.current) return
    ta.current.style.height = 'auto'
    setHeight(ta.current.scrollHeight)
    ta.current.style.height = ''
  }, [autoGrow, v])
  const describedBy = [showCount && `${fid}-c`, error && `${fid}-e`].filter(Boolean).join(' ') || undefined
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'textarea', 'data-invalid': flag(error), 'data-filled': flag(v),
    'data-disabled': flag(disabled), 'data-readonly': flag(readOnly),
    style: height !== undefined ? { '--textarea-height': `${height}px` } : undefined,
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {label && part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('textarea', {
        ...rest, ref: ta, id: fid, name, value: v, disabled, readOnly, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => { setV(e.target.value); onChange?.(e); onValueChange?.(e.target.value) },
      }, slots?.field, s)}
      {showCount && part('span', { id: `${fid}-c`, 'aria-live': 'polite' }, slots?.count, s, rest.maxLength !== undefined ? `${v.length}/${rest.maxLength}` : String(v.length))}
      {error && part('p', { id: `${fid}-e`, role: 'alert' }, slots?.error, s, error)}
    </AutoOff>
  </>)
}
