'use client'
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control, ControlCtx, Json } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/tree.md: APG Tree View on <ul role=tree>. The whole tree is SSR'd (collapsed groups `hidden inert`),
// so open/close are `rendered` for headless agents; single selection maps to `url` when given.
// Agents act through the real toggles and labels, so onExpandedChange / onSelectedChange run.
// ponytail: static nodes only (no lazy branches), no move, no typeahead.
type C = Record<string, Control<any, any>>
type S = { expanded: string[]; selected?: string[] }
export type TreeNode = { id: string; label: string; children?: TreeNode[] }
export type TreeProps = {
  name: string; label: string; nodes: TreeNode[]
  expanded?: string[]; defaultExpanded?: string[]; onExpandedChange?(ids: string[]): void
  selection?: 'none' | 'single' | 'multiple'; selected?: string[]; defaultSelected?: string[]; onSelectedChange?(ids: string[]): void
  url?: string                                        // query param for single selection (headless)
  render?(n: TreeNode): ReactNode
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'item' | 'toggle' | 'label' | 'group', S>
}

const flat = (ns: TreeNode[]): TreeNode[] => ns.flatMap((n) => [n, ...flat(n.children ?? [])])
const strip = (ns: TreeNode[]): Json[] => ns.map((n) => ({ id: n.id, label: n.label, ...(n.children?.length && { children: strip(n.children) }) }))

const useTree = defineWidget<TreeProps, S, C>({
  kind: 'tree',
  state: (p) => ({ expanded: p.expanded ?? [], ...(p.selection !== 'none' && { selected: p.selected ?? [] }) }),
  controls: ({ props: p, el }) => {
    const all = flat(p.nodes), open = p.expanded ?? []
    const branches = all.filter((n) => n.children?.length).map((n) => n.id)
    const press = (ctx: ControlCtx, id: string, part_: string) => inner<HTMLElement>(ctx, el(), `[data-id="${CSS.escape(id)}"] > [data-part=${part_}]`).click()
    const c: C = {}
    const closed = branches.filter((b) => !open.includes(b)), opened = branches.filter((b) => open.includes(b))
    if (closed.length) c.open = { kind: 'open', params: { item: { type: 'string', enum: closed } }, run: async (a: { item: string }, ctx) => press(ctx, a.item, 'toggle') }
    if (opened.length) c.close = { kind: 'close', params: { item: { type: 'string', enum: opened } }, run: async (a: { item: string }, ctx) => press(ctx, a.item, 'toggle') }
    const ids = all.map((n) => n.id)
    if (p.selection === 'multiple') c.select = { kind: 'select', params: { items: { type: 'string', enum: ids, multiple: true } },
      run: async (a: { items: string[] }, ctx) => {
        const cur = new Set(p.selected ?? [])
        for (const id of ids) if (cur.has(id) !== a.items.includes(id)) press(ctx, id, 'label')
      } }
    else if (p.selection !== 'none') c.select = { kind: 'select', params: { item: { type: 'string', enum: ids } },
      run: async (a: { item: string }, ctx) => { if (!(p.selected ?? []).includes(a.item)) press(ctx, a.item, 'label') } }
    return c
  },
  headless: (p) => ({ open: { rendered: true }, close: { rendered: true }, ...(p.selection === 'single' && p.url && { select: headlessOf(p) }) }),
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true, data: { nodes: strip(p.nodes) } }),
})

export function Tree(props: DefinedProps<TreeProps, C>) {
  const { label, nodes, expanded, defaultExpanded, onExpandedChange, selection = 'single', selected, defaultSelected, onSelectedChange, render, disabled, className, slots } = props
  const [open, setOpen] = useControllable<string[]>(expanded, defaultExpanded ?? [])
  const [sel, setSel] = useControllable<string[]>(selected, defaultSelected ?? [])
  // Refs, not the render's values: several agent clicks in one tick each see the previous one.
  const o = useRef(open); o.current = open
  const sr = useRef(sel); sr.current = sel
  const w = useTree({ ...props, selection, expanded: open, selected: sel })
  const s = w.state
  const flip = (id: string) => {
    if (disabled) return
    const next = o.current.includes(id) ? o.current.filter((x) => x !== id) : [...o.current, id]
    o.current = next; setOpen(next); onExpandedChange?.(next)
  }
  const pick = (id: string) => {
    if (disabled || selection === 'none') return
    const cur = sr.current
    const next = selection === 'single' ? (cur.includes(id) ? cur : [id]) : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    if (next === cur) return
    sr.current = next; setSel(next); onSelectedChange?.(next)
  }
  const first = flat(nodes)[0]?.id
  const focusId = sel[0] ?? first
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]')].filter((x) => !x.parentElement?.closest('[hidden]'))
    const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role=treeitem]')
    const i = cur ? items.indexOf(cur) : -1, id = cur?.dataset.id
    if (i < 0 || !id) return
    const isOpen = cur!.getAttribute('aria-expanded') === 'true', branch = cur!.hasAttribute('aria-expanded')
    const move = (j: number) => items[Math.max(0, Math.min(items.length - 1, j))]?.focus()
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'ArrowRight' && branch) { if (isOpen) move(i + 1); else flip(id) }
    else if (e.key === 'ArrowLeft') { if (branch && isOpen) flip(id); else cur!.parentElement?.closest<HTMLElement>('[role=treeitem]')?.focus() }
    else if (e.key === 'Enter' || e.key === ' ') pick(id)
    else return
    e.preventDefault()
  }

  const item = (n: TreeNode, level: number): ReactNode => {
    const kids = n.children?.length ? n.children : undefined
    const on = open.includes(n.id), chosen = sel.includes(n.id)
    const st = { 'data-state': kids ? (on ? 'open' : 'closed') : undefined, 'data-selected': flag(chosen), 'data-level': level }
    return part('li', {
      key: n.id, role: 'treeitem', 'data-id': n.id, 'aria-level': level, 'aria-expanded': kids ? on : undefined,
      'aria-selected': selection === 'none' ? undefined : chosen, tabIndex: n.id === focusId && !disabled ? 0 : -1,
      style: { '--tree-level': level }, ...st,
    }, slots?.item, s, <>
      {part('span', { 'data-part': 'toggle', 'aria-hidden': true, onClick: kids ? (e: { stopPropagation(): void }) => { e.stopPropagation(); flip(n.id) } : undefined, ...st }, slots?.toggle, s, kids ? (on ? '▾' : '▸') : null)}
      {part('span', { 'data-part': 'label', onClick: () => pick(n.id), ...st }, slots?.label, s, render ? render(n) : n.label)}
      {kids && part('ul', { role: 'group', hidden: !on, inert: !on || undefined }, slots?.group, s, kids.map((k) => item(k, level + 1)))}
    </>)
  }
  return <>{w.embed}{part('ul', {
    ref: w.ref, ...w.props, role: 'tree', 'aria-label': label, 'aria-multiselectable': selection === 'multiple' || undefined,
    'data-tvine-widget': 'tree', 'data-disabled': flag(disabled), onKeyDown: onKey,
  }, { className, ...slots?.root }, s, <AutoOff>{nodes.map((n) => item(n, 1))}</AutoOff>)}</>
}
