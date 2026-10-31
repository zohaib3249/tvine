'use client'
import { useId, type ReactNode } from 'react'
import { useWidget } from '../widget/useWidget.js'
import type { ControlCtx, WidgetHooks } from '../widget/types.js'
import { agentNavigate } from '../runtime/nav.js'
import { AutoOff, part, type Slots, type SlotProps } from './_parts.js'
import { sameSite } from './link.js'

// widgets/data.md: an entity card = Data + <article> + a heading. Its id IS the global entity
// (`product:12`), so the same product in the grid and in "recently viewed" is one node (registry dedupe).
// One control of its own: navigate when it has a same-site href (headless: GET href; in-tab: click its title
// link, so app onClick / Next transitions run). Child widgets (buttons, quantity, swatches) scope under the entity id.
// ponytail: Root/Title/Body slots only (no Media/Footer/Actions parts); put those in children.
type S = { entity: string }
export type CardProps = {
  entity: string; label: string; data: Record<string, unknown>; href?: string
  summary?: string[]; hidden?: string[]; hooks?: WidgetHooks
  children?: ReactNode
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'title' | 'body', S>
}

// The client half; `Card` (card.tsx) strips `hidden` fields first so they never reach the RSC payload.
export function CardClient({ entity, label, data, href, summary, hooks, children, className, slots }: Omit<CardProps, 'hidden'>) {
  const nav = href && sameSite(href) ? { navigate: { kind: 'navigate' as const, headless: { url: href },
    run: async (_: unknown, ctx: ControlCtx) => { const a = ctx.el?.querySelector<HTMLAnchorElement>('a[data-card-link]'); await agentNavigate(href, ctx.signal, a ? () => a.click() : undefined) } } } : undefined
  const w = useWidget({ kind: 'card', entity, label, data: href ? { ...data, href } : data, ...(nav && { controls: nav }), ...(summary && { summary }), ...(hooks && { hooks }) })
  const s = { entity }
  const id = useId()
  return part('article', { ref: w.ref, ...w.props, 'data-tvine-widget': 'card', 'data-tvine-entity': entity, 'aria-labelledby': id }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>{part('h3', { id }, slots?.title, s, href ? <a href={href} data-card-link="">{label}</a> : label)}</AutoOff>
    <w.Scope>{part('div', {}, slots?.body, s, children)}</w.Scope>
  </>)
}
