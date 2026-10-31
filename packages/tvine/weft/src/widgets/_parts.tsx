'use client'
import { cloneElement, createElement, isValidElement, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react'
import { WeftError } from '../widget/hooks.js'
import type { ActionHandle, ControlCtx, HeadlessMap } from '../widget/types.js'

// styling.md: shared slot helpers for the built-in widgets (W9a owns this file; W9b–e reuse it).
// Built-ins own their parts: inner natives sit under AutoOff so the JSX runtime never registers them twice.
import { AutoOff } from '../jsx/AutoEl.js'
export { AutoOff }

export type SlotProps<S> = {
  className?: string | ((s: S) => string)
  style?: CSSProperties | ((s: S) => CSSProperties)
  // Merge onto this element, keeping its type (Radix asChild; given here since built-ins own their children).
  // Our children go inside it unless it has its own.
  asChild?: ReactElement
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
  if (slot?.asChild && isValidElement<Record<string, any>>(slot.asChild)) {
    const child = slot.asChild, cp = child.props
    const merged: Record<string, any> = { ...props, ...cp, className: join(className, cp.className), style: { ...props.style, ...cp.style } }
    for (const k of Object.keys(props)) {
      if (/^on[A-Z]/.test(k) && typeof cp[k] === 'function' && typeof props[k] === 'function') {
        merged[k] = (e: { defaultPrevented?: boolean }) => { cp[k](e); if (!e?.defaultPrevented) props[k](e) }
      }
    }
    if (props.ref || (cp as { ref?: Ref<unknown> }).ref) merged.ref = mergeRefs(props.ref, (cp as { ref?: Ref<unknown> }).ref)
    if (cp.children === undefined && children !== undefined) merged.children = children
    else delete merged.children
    return <AutoOff>{cloneElement(child, merged)}</AutoOff>
  }
  return createElement(Tag, props, children)
}

// Controlled when `value` is given, else own state seeded from `defaultValue`.
export function useControllable<T>(value: T | undefined, def: T): [T, (v: T) => void] {
  const [own, setOwn] = useState(def)
  return [value !== undefined ? value : own, setOwn]
}

// `''` attribute when on, absent when off.
export const flag = (on: unknown): '' | undefined => (on ? '' : undefined)

// headless-parity.md: `url` (filters) wins over the form action's params. `url` is a query PARAM NAME
// (warp core/ui.ts sets ?<url>=<value> on the current page), so only a plain name is published;
// anything else (https://evil, javascript:, a path) is dropped with a dev warning.
const PARAM = /^[A-Za-z_][\w.\-\[\]]{0,63}$/
export function headlessOf(p: { url?: string; action?: ActionHandle; name?: string }, values: 'enum' | 'any' = 'enum'): HeadlessMap | undefined {
  if (p.url && PARAM.test(p.url)) return { url: p.url, values }
  if (p.url && process.env.NODE_ENV !== 'production') console.warn(`tvine: widget ${p.name ?? ''} url="${p.url}" is not a query param name; headless url map dropped`)
  return p.action ? { params: p.action, ...(p.name && { field: p.name }) } : undefined
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

// Client navigation for built-in links (#7): a plain same-site left click goes through the App Router
// (window.next.router, as nav.ts) instead of a document load, so the page, the registry and a WebMCP
// session survive. Delegated: works on the <a> itself or any ancestor. No router / modifier keys /
// target / download / off-site / already handled (e.g. Next <Link> asChild) → the browser's default.
export function softNav(e: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: EventTarget | null; preventDefault(): void }): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const router = (globalThis as { next?: { router?: { push?: (h: string) => void } } }).next?.router
  if (!a || typeof router?.push !== 'function' || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
  const u = new URL(a.href, location.href)
  if (u.origin !== location.origin) return
  e.preventDefault()
  router.push(u.pathname + u.search + u.hash)
}
