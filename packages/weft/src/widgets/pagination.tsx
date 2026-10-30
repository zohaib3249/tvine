'use client'
import type { MouseEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control, ControlCtx } from '../widget/types.js'
import { agentNavigate } from '../runtime/nav.js'
import { AutoOff, flag, headlessOf, part, type Slots, type SlotProps } from './_parts.js'

// widgets/pagination.md: <nav aria-label="Pagination"> of real links. Every agent move goes through
// W8's agentNavigate (same-origin check, real click, settle).
// ponytail: numbered only (no cursor mode); window = first, last, current±1 with ellipses.
type C = Record<string, Control<any, any>>
type S = { page: number; pageCount: number }
export type PaginationProps = {
  name?: string; page: number; pageCount: number
  param?: string                          // default 'page'
  query?: string                          // current search string to keep (e.g. "sort=price"); default none
  hrefFor?(page: number): string
  onPageChange?(page: number): void
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'item' | 'prev' | 'next' | 'ellipsis', S>
}

const hrefOf = (p: PaginationProps, n: number) => {
  if (p.hrefFor) return p.hrefFor(n)
  const q = new URLSearchParams(p.query); q.set(p.param ?? 'page', String(n))
  return `?${q}`
}
async function go(p: PaginationProps, n: number, el: HTMLElement | null, ctx: ControlCtx) {
  const a = el?.querySelector<HTMLAnchorElement>(`a[data-page="${n}"]`)
  await agentNavigate(hrefOf(p, n), ctx.signal, a ? () => a.click() : undefined)
}
const nav = (p: PaginationProps, el: () => HTMLElement | null, to: (a: any) => number): Control<any, any> =>
  ({ kind: 'navigate', run: async (a: any, ctx) => { await go(p, to(a), el(), ctx) } })

const usePagination = defineWidget<PaginationProps, S, C>({
  kind: 'pagination',
  state: (p) => ({ page: p.page, pageCount: p.pageCount }),
  controls: ({ props: p, el }) => ({
    page: { ...nav(p, el, (a) => a.to), params: { to: { type: 'number', min: 1, max: p.pageCount } } },
    ...(p.page < p.pageCount && { next: nav(p, el, () => p.page + 1) }),
    ...(p.page > 1 && { prev: nav(p, el, () => p.page - 1) }),
  }) as C,
  headless: (p) => { const h = p.hrefFor ? undefined : headlessOf({ url: p.param ?? 'page' }, 'any'); return h ? { page: h, next: h, prev: h } : {} },
  describe: () => ({ label: 'Pagination' }),
  spec: (p) => ({ name: p.name ?? 'pages', changesContent: true }),
})

export function Pagination(props: DefinedProps<PaginationProps, C>) {
  const { page, pageCount, onPageChange, className, slots } = props
  const w = usePagination(props)
  const s = { page, pageCount }
  const shown = [...new Set([1, page - 1, page, page + 1, pageCount])].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  const link = (n: number, slot: SlotProps<S> | undefined, label: string, extra: Record<string, unknown> = {}) => part('a', {
    href: hrefOf(props, n), 'data-page': n, onClick: onPageChange && ((e: MouseEvent) => { void e; onPageChange(n) }), ...extra,
  }, slot, s, label)
  return part('nav', { ref: w.ref, ...w.props, 'data-tvine-widget': 'pagination', 'aria-label': 'Pagination' }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {page > 1 ? link(page - 1, slots?.prev, 'Previous', { rel: 'prev' }) : part('span', { 'data-disabled': '' }, slots?.prev, s, 'Previous')}
      {shown.map((n, i) => <span key={n}>
        {i > 0 && n - shown[i - 1]! > 1 && part('span', { 'aria-hidden': true }, slots?.ellipsis, s, '…')}
        {link(n, slots?.item, String(n), { 'aria-current': n === page ? 'page' : undefined, 'data-current': flag(n === page) })}
      </span>)}
      {page < pageCount ? link(page + 1, slots?.next, 'Next', { rel: 'next' }) : part('span', { 'data-disabled': '' }, slots?.next, s, 'Next')}
    </AutoOff>
  </>)
}
