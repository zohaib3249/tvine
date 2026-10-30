'use client'
import { useSyncExternalStore } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, inner, part, type Slots, type SlotProps } from './_parts.js'

// widgets/toast.md: read + dismiss. `toast()` pushes to a module store; <Toaster> renders a live region.
// Agents read items from state and `close(id)` clicks the real dismiss button. Dismissed/expired
// toasts stay in the read buffer (last `max`, flagged) so a fast one isn't missed.
// ponytail: no `act` control / toast actions, no swipe, no pause-on-hover.
export type ToastKind = 'success' | 'error' | 'info'
export type ToastItem = { id: string; title: string; description?: string; kind?: ToastKind; dismissed?: true }
type S = { items: ToastItem[] }
type C = Record<string, Control<any, any>>

let items: ToastItem[] = []
let seq = 0
const subs = new Set<() => void>()
const emit = (next: ToastItem[]) => { items = next.slice(-20); for (const f of subs) f() }
const dismiss = (id: string) => emit(items.map((t) => t.id === id ? { ...t, dismissed: true as const } : t))

export function toast(t: Omit<ToastItem, 'id' | 'dismissed'> & { duration?: number }): string {
  const { duration = 5000, ...rest } = t
  const id = `t${++seq}`
  emit([...items, { id, kind: 'info', ...rest }])
  if (duration > 0 && duration !== Infinity) setTimeout(() => dismiss(id), duration)
  return id
}

export type ToasterProps = {
  name?: string; label?: string; max?: number
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'toast' | 'close', S>
}

const useToaster = defineWidget<ToasterProps & { items: ToastItem[] }, S, C>({
  kind: 'toast',
  state: (p) => ({ items: p.items.slice(-(p.max ?? 5)) }),
  controls: ({ props: p, el }): C => {
    const live = p.items.filter((t) => !t.dismissed).map((t) => t.id)
    return live.length ? { close: { kind: 'close', params: { id: { type: 'string', enum: live } }, run: async (a: { id: string }, ctx) => {
      inner<HTMLButtonElement>(ctx, el(), `[data-toast="${CSS.escape(a.id)}"] [data-part=close]`).click()
    } } } : {}
  },
  describe: (p) => ({ label: p.label ?? 'Notifications' }),
  spec: (p) => ({ name: p.name ?? 'toaster', id: 'toaster' }),
})

export function Toaster(props: DefinedProps<ToasterProps, C>) {
  const all = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => items, () => items)
  const w = useToaster({ ...props, items: all })
  const s = w.state
  const open = all.filter((t) => !t.dismissed).slice(-(props.max ?? 5))
  return part('section', { ref: w.ref, ...w.props, 'data-tvine-widget': 'toast', 'aria-label': props.label ?? 'Notifications' }, { className: props.className, ...props.slots?.root }, s, <>
    {w.embed}
    <AutoOff>{open.map((t, i) => part('div', {
      key: t.id, 'data-toast': t.id, role: t.kind === 'error' ? 'alert' : 'status', 'data-state': 'open', 'data-kind': t.kind, style: { '--toast-index': i },
    }, props.slots?.toast, s, <>
      <strong>{t.title}</strong>{t.description && <p>{t.description}</p>}
      {part('button', { type: 'button', 'data-part': 'close', 'aria-label': 'Dismiss', onClick: () => dismiss(t.id) }, props.slots?.close, s, '×')}
    </>))}</AutoOff>
  </>)
}
