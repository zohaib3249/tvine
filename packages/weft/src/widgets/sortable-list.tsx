'use client'
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { inner, invalid, part, type Slots, type SlotProps } from './_parts.js'

// widgets/list.md (sortable): a native <ul> with keyboard move (Space grabs, arrows move, Space drops,
// Escape cancels) and native HTML drag-and-drop. The agent's `move` drives the same keyboard path on the
// real item, so onMove runs once with the final index. Headless: `move` = `do` of the `move` action ({id, to}).
// ponytail: no virtualization; items are controlled (onMove must reorder them).
type C = Record<string, Control<any, any>>
type S = { count: number }
export type SortableListProps<T = any> = {
  name: string; label: string; items: T[]; itemId(t: T): string
  onMove(id: string, to: number): void | Promise<void>; move?: ActionHandle
  children(item: T): ReactNode
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'item', S>
}

const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

const useSortable = defineWidget<SortableListProps, S, C>({
  kind: 'list',
  state: (p) => ({ count: p.items.length }),
  controls: ({ props: p, el }) => {
    const ids = p.items.map(p.itemId)
    return {
      move: { kind: 'move', params: { id: { type: 'string', enum: ids }, to: { type: 'number', min: 0, max: Math.max(0, ids.length - 1), step: 1 } },
        run: async (a: { id: string; to: number }, ctx) => {
          if (!Number.isInteger(a.to)) throw invalid('to', 'to must be a whole number')
          const from = ids.indexOf(a.id)
          if (from === a.to) return
          const li = inner<HTMLElement>(ctx, el(), `[data-id="${CSS.escape(a.id)}"]`)
          li.focus(); key(li, ' ')
          for (let i = 0; i < Math.abs(a.to - from); i++) key(li, a.to > from ? 'ArrowDown' : 'ArrowUp')
          key(li, ' ')
        } },
    }
  },
  headless: (p) => (p.move ? { move: { params: p.move } } : {}),
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function SortableList<T>(props: DefinedProps<SortableListProps<T>, C>) {
  const { label, items, itemId, onMove, children, disabled, className, slots } = props
  const w = useSortable(props as DefinedProps<SortableListProps, C>)
  const s = { count: items.length }
  const [grab, setGrab] = useState<{ id: string; to: number } | null>(null)
  const g = useRef(grab); g.current = grab
  const [drag, setDrag] = useState<{ id: string; over?: number } | null>(null)
  const [said, say] = useState('')
  const ids = items.map(itemId)
  const nameOf = (id: string) => { const t = items[ids.indexOf(id)] as Record<string, unknown> | undefined; return String(t?.name ?? t?.title ?? id) }
  const set = (v: { id: string; to: number } | null) => { g.current = v; setGrab(v) }
  const drop = (id: string, to: number) => { if (to !== ids.indexOf(id)) void onMove(id, to); say(`${nameOf(id)} moved to position ${to + 1}`) }

  const onKey = (id: string) => (e: KeyboardEvent<HTMLLIElement>) => {
    if (disabled) return
    const cur = g.current, last = ids.length - 1
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (!cur) { set({ id, to: ids.indexOf(id) }); say(`${nameOf(id)} grabbed`) }
      else { set(null); drop(cur.id, cur.to) }
    } else if (cur && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      set({ id: cur.id, to: Math.max(0, Math.min(last, cur.to + (e.key === 'ArrowDown' ? 1 : -1))) })
    } else if (cur && e.key === 'Escape') { set(null); say('move cancelled') }
  }
  // While grabbed, show the item at its new slot.
  const shown = grab ? (() => { const o = ids.filter((x) => x !== grab.id); o.splice(grab.to, 0, grab.id); return o })() : ids
  const byId = new Map(items.map((t) => [itemId(t), t]))

  return part('ul', { ref: w.ref, ...w.props, 'data-tvine-widget': 'sortable-list', 'aria-label': label, 'data-disabled': disabled ? '' : undefined }, { className, ...slots?.root }, s, <>
    {w.embed}
    <w.Scope>{shown.map((id, i) => part('li', {
      key: id, 'data-id': id, tabIndex: disabled ? undefined : 0, 'aria-roledescription': 'sortable', draggable: !disabled,
      'aria-pressed': grab?.id === id ? true : undefined,
      'data-dragging': grab?.id === id || drag?.id === id ? '' : undefined, 'data-drop-target': drag?.over === i ? '' : undefined,
      onKeyDown: onKey(id),
      onDragStart: (e: DragEvent) => { e.dataTransfer?.setData('text/plain', id); setDrag({ id }) },
      onDragOver: (e: DragEvent) => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } },
      onDrop: (e: DragEvent) => { e.preventDefault(); if (drag) drop(drag.id, i); setDrag(null) },
      onDragEnd: () => setDrag(null),
    }, slots?.item, s, children(byId.get(id)!)))}</w.Scope>
    <li role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{said}</li>
  </>)
}
