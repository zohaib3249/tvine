'use client'
import { useId, type ReactNode } from 'react'
import { useWidget } from '../widget/useWidget.js'
import type { WidgetHooks } from '../widget/types.js'
import { AutoOff, part, type Slots, type SlotProps } from './_parts.js'

// widgets/data.md: an entity card = Data + <article> + a heading. Its id IS the global entity
// (`product:12`), so the same product in the grid and in "recently viewed" is one node (registry dedupe).
// No controls of its own: child widgets (buttons, quantity, swatches) scope under the entity id.
// ponytail: Root/Title/Body slots only (no Media/Footer/Actions parts); put those in children.
type S = { entity: string }
export type CardProps = {
  entity: string; label: string; data: Record<string, unknown>; href?: string
  summary?: string[]; hidden?: string[]; hooks?: WidgetHooks
  children?: ReactNode
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'title' | 'body', S>
}

export function Card({ entity, label, data, href, summary, hidden, hooks, children, className, slots }: CardProps) {
  const w = useWidget({ kind: 'card', entity, label, data: href ? { ...data, href } : data, ...(summary && { summary }), ...(hidden && { hidden }), ...(hooks && { hooks }) })
  const s = { entity }
  const id = useId()
  return part('article', { ref: w.ref, ...w.props, 'data-tvine-widget': 'card', 'data-tvine-entity': entity, 'aria-labelledby': id }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>{part('h3', { id }, slots?.title, s, href ? <a href={href}>{label}</a> : label)}</AutoOff>
    <w.Scope>{part('div', {}, slots?.body, s, children)}</w.Scope>
  </>)
}
