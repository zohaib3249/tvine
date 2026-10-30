'use client'
import { cloneElement, isValidElement, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react'
import { WeftError } from '../widget/hooks.js'
import type { ActionHandle, ControlCtx, HeadlessMap } from '../widget/types.js'

// styling.md: shared slot helpers for the built-in widgets (W9a owns this file; W9b–e reuse it).
// Built-ins own their parts: inner natives sit under AutoOff so the JSX runtime never registers them twice.
export { AutoOff } from '../jsx/AutoEl.js'

export type SlotProps<S> = {
  className?: string | ((s: S) => string)
  style?: CSSProperties | ((s: S) => CSSProperties)
  asChild?: boolean                                                  // merge onto the single child, keep its element
  render?: (props: Record<string, unknown>, s: S) => ReactElement   // full control: spread the given props
}
export type Slots<K extends string, S> = Partial<Record<K, SlotProps<S>>>

const call = <S, T>(v: T | ((s: S) => T) | undefined, s: S): T | undefined => (typeof v === 'function' ? (v as (s: S) => T)(s) : v)
const join = (...c: (string | undefined)[]) => c.filter(Boolean).join(' ') || undefined

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => { for (const r of refs) if (typeof r === 'function') r(node); else if (r) (r as { current: T | null }).current = node }
}

// One slot: own props (ARIA/data/handlers) + the dev's className/style (state-aware), asChild or render.
// asChild: child's handlers run first, ours unless it called preventDefault.
export function part<S>(Tag: string, own: Record<string, any>, slot: SlotProps<S> | undefined, s: S, children?: ReactNode): ReactElement {
  const className = join(own.className, call(slot?.className, s))
  const style = { ...own.style, ...call(slot?.style, s) }
  const props: Record<string, any> = { ...own, className, style: Object.keys(style).length ? style : undefined }
  if (slot?.render) return slot.render({ ...props, children }, s)
  if (slot?.asChild && isValidElement<Record<string, any>>(children)) {
    const cp = children.props
    const merged: Record<string, any> = { ...props, ...cp, className: join(className, cp.className), style: { ...props.style, ...cp.style } }
    for (const k of Object.keys(props)) {
      if (/^on[A-Z]/.test(k) && typeof cp[k] === 'function' && typeof props[k] === 'function') {
        merged[k] = (e: { defaultPrevented?: boolean }) => { cp[k](e); if (!e?.defaultPrevented) props[k](e) }
      }
    }
    if (props.ref || (cp as { ref?: Ref<unknown> }).ref) merged.ref = mergeRefs(props.ref, (cp as { ref?: Ref<unknown> }).ref)
    return cloneElement(children, merged)
  }
  return <Tag {...props}>{children}</Tag>
}

// Controlled when `value` is given, else own state seeded from `defaultValue`.
export function useControllable<T>(value: T | undefined, def: T): [T, (v: T) => void] {
  const [own, setOwn] = useState(def)
  return [value !== undefined ? value : own, setOwn]
}

// `''` attribute when on, absent when off.
export const flag = (on: unknown): '' | undefined => (on ? '' : undefined)

// headless-parity.md: `url` (filters) wins over the form action's params.
export function headlessOf(p: { url?: string; action?: ActionHandle; name?: string }): HeadlessMap | undefined {
  return p.url ? { url: p.url, values: 'enum' } : p.action ? { params: p.action, ...(p.name && { field: p.name }) } : undefined
}

export const invalid = (field: string, message: string) => new WeftError('invalid_param', message, undefined, field)

// Agents act through the real element: native setter + events, so the app's onChange runs.
export function setNative(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// The widget root's inner element for a control (throws unknown_action when unmounted).
export function inner<T extends Element>(ctx: ControlCtx, root: HTMLElement | null, sel: string): T {
  const el = (root ?? ctx.el)?.querySelector<T>(sel)
  if (!el) throw new WeftError('unknown_action', 'element is not mounted')
  return el
}

// Type text through presence (animated, per-char input events); falls back to one native set.
export async function typeText(ctx: ControlCtx, f: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  await ctx.presence.type(f, text)
  if (f.value !== text) setNative(f, text)
}
