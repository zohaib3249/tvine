'use client'
import type { MouseEvent, ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { agentNavigate } from '../runtime/nav.js'
import { flag, part, softNav, type SlotProps } from './_parts.js'

// widgets/link.md: native <a href>. The agent's navigate goes through W8's agentNavigate (same-origin
// check, then the real click so app onClick / Next transitions run, then settle). Off-site hrefs and
// unsafe schemes expose no control.
type C = Record<string, Control<any, any>>
type S = { current?: true }
export type LinkProps = SlotProps<S> & {
  href: string; label?: string; current?: boolean; name?: string
  onClick?(e: MouseEvent<HTMLAnchorElement>): void
  children: ReactNode
}

// Server (no location): only relative same-site paths ("/x", "?q", "#h"; not "//host") are safe.
const sameSite = (href: string) => {
  if (typeof location === 'undefined') return /^(\/(?![\/\\])|[?#])/.test(href)
  try { const u = new URL(href, location.href); return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin } catch { return false }
}
const text = (p: LinkProps) => p.label ?? (typeof p.children === 'string' ? p.children : p.href)

const useLink = defineWidget<LinkProps, S, C>({
  kind: 'link',
  state: (p) => (p.current ? { current: true } : {}) as S,
  controls: ({ props: p, el }) => (!sameSite(p.href) ? {} as C : {
    navigate: { kind: 'navigate', run: async (_: unknown, ctx) => {
      await agentNavigate(p.href, ctx.signal, () => { const a = el(); if (!a) throw new Error('link is not mounted'); a.click() })
    } },
  }),
  describe: (p) => ({ label: text(p), summary: [p.href] }),
  spec: (p) => ({ name: p.name ?? p.href, data: { href: p.href } }),   // headless: a plain GET of href
})

export function Link(props: DefinedProps<LinkProps, C>) {
  const { href, current, onClick, disabled, children } = props
  const w = useLink(props)
  const s = (current ? { current: true } : {}) as S
  return <>{w.embed}{part('a', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'link', href: disabled ? undefined : href, 'aria-current': current ? 'page' : undefined,
    'aria-disabled': disabled || undefined, 'data-current': flag(current), 'data-disabled': flag(disabled), onClick: (e: MouseEvent<HTMLAnchorElement>) => { onClick?.(e); softNav(e) },
  }, props, s, children)}</>
}
