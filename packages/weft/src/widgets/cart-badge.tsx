'use client'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { agentNavigate } from '../runtime/nav.js'
import { flag, part, type Slots, type SlotProps, softNav } from './_parts.js'

// widgets/cart-badge.md: a read-only count on a native <a href="/cart">. Personal (snapshot uncacheable).
// The accessible name carries the count; changes are announced politely and set data-bumped for 300 ms.
// ponytail: no `drawer` mode (wrap a Drawer trigger around it instead).
type C = Record<string, Control<any, any>>
type S = { count: number; total?: string }
export type CartBadgeProps = {
  count: number; total?: string; href?: string; label?(n: number): string
  icon?: ReactNode; onClick?(e: MouseEvent<HTMLAnchorElement>): void
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'icon' | 'count', S>
}
const nameOf = (p: CartBadgeProps) => (p.label ?? ((n) => `Cart, ${n} item${n === 1 ? '' : 's'}`))(p.count)

const useCartBadge = defineWidget<CartBadgeProps, S, C>({
  kind: 'cart-badge',
  state: (p) => ({ count: p.count, ...(p.total && { total: p.total }) }),
  controls: ({ props: p, el }) => ({
    navigate: { kind: 'navigate', run: async (_: unknown, ctx) => { const a = el(); await agentNavigate(p.href ?? '/cart', ctx.signal, a ? () => a.click() : undefined) } },
  }),
  describe: () => ({ label: 'Cart' }),
  spec: (p) => ({ id: 'cart:badge', personal: true, data: { href: p.href ?? '/cart' } }),   // headless: GET href
})

export function CartBadge(props: DefinedProps<CartBadgeProps, C>) {
  const { count, total, href = '/cart', icon, onClick, disabled, className, slots } = props
  const w = useCartBadge(props)
  const s = { count, ...(total && { total }) }
  const [bumped, setBumped] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setBumped(true)
    const t = setTimeout(() => setBumped(false), 300)
    return () => clearTimeout(t)
  }, [count])
  return <>{w.embed}{part('a', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'cart-badge', href: disabled ? undefined : href, 'aria-label': nameOf(props),
    'aria-disabled': disabled || undefined, 'data-empty': flag(count === 0), 'data-bumped': flag(bumped), onClick: (e: MouseEvent<HTMLAnchorElement>) => { onClick?.(e); softNav(e) },
  }, { className, ...slots?.root }, s, <>
    {icon && part('span', { 'aria-hidden': true }, slots?.icon, s, icon)}
    {part('span', { 'aria-live': 'polite' }, slots?.count, s, count)}
  </>)}</>
}
