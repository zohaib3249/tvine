'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'
import { inertOutside, showPopover } from './_position.js'
import { raisePresence } from '../presence/overlay.js'

// widgets/dialog.md: native <dialog> opened with show() + popover=manual (top layer) — NOT showModal(), whose
// inert document would cover the agent Stop pill. Modal = `inert` on the background (inertOutside stops at <body>,
// so the presence host on <html> stays live) + Esc; the presence host is re-raised above the dialog. Closed content is not mounted (never leaks).
// ponytail: props API (trigger/title/children), not the compound Dialog.Root/Trigger/Content yet; no forceMount.
type C = Record<string, Control<any, any>>
type S = { open: boolean }
export type DialogProps = {
  name: string; label: string; trigger?: ReactNode; children?: ReactNode
  open?: boolean; defaultOpen?: boolean; onOpenChange?(open: boolean): void; modal?: boolean
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'trigger' | 'content' | 'title' | 'close', S>
}

export const useOverlay = (kind: 'dialog' | 'drawer') => defineWidget<DialogProps, S, C>({
  kind,
  state: (p) => ({ open: !!p.open }),
  controls: ({ props: p, el }): C => p.open
    ? { close: { kind: 'close', run: async (_a, ctx) => { inner<HTMLButtonElement>(ctx, el(), '[data-part=close]').click() } } }
    : { open: { kind: 'open', run: async (_a, ctx) => { inner<HTMLButtonElement>(ctx, el(), '[data-part=trigger]').click() } } },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name }),
})
const useDialog = useOverlay('dialog')

export function Overlay({ props, w, kind, extra }: { props: DialogProps; w: ReturnType<typeof useDialog>; kind: string; extra?: Record<string, unknown> }) {
  const { label, trigger, children, modal = true, className, slots } = props
  const open = !!props.open
  const set = props.onOpenChange!
  const ref = useRef<HTMLDialogElement>(null)
  const s = { open }
  useEffect(() => {
    const d = ref.current
    if (!d || !open) return
    if (modal) { d.setAttribute('popover', 'manual'); showPopover(d, true) }
    if (typeof d.show === 'function') { try { d.show() } catch { d.setAttribute('open', '') } } else d.setAttribute('open', '')
    raisePresence()
    const undo = modal ? inertOutside(d) : () => {}
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); set(false) } }
    if (modal) d.ownerDocument.addEventListener('keydown', esc)
    if (modal) d.querySelector<HTMLElement>('[autofocus],button,input,select,textarea,a[href]')?.focus()
    return () => {
      undo(); d.ownerDocument.removeEventListener('keydown', esc); showPopover(d, false)
      if (typeof d.close === 'function') d.close(); else d.removeAttribute('open')
    }
  }, [open, modal])
  const st = { 'data-state': open ? 'open' : 'closed' }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': kind, ...st }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>{part('button', { type: 'button', 'data-part': 'trigger', 'aria-haspopup': 'dialog', 'aria-expanded': open, ...st, onClick: () => set(true) }, slots?.trigger, s, trigger ?? label)}</AutoOff>
    {open && part('dialog', { ref, 'aria-label': label, ...st, ...extra, onCancel: (e: Event) => { e.preventDefault(); set(false) }, onClose: () => { if (open) set(false) } }, slots?.content, s, <>
      {children}
      <AutoOff>{part('button', { type: 'button', 'data-part': 'close', 'aria-label': 'Close', onClick: () => set(false) }, slots?.close, s, '×')}</AutoOff>
    </>)}
  </>)
}

export function useOpen(props: DialogProps) {
  const [open, setOpen] = useControllable<boolean>(props.open, props.defaultOpen ?? false)
  return { ...props, open, onOpenChange: (v: boolean) => { setOpen(v); props.onOpenChange?.(v) } }
}

export function Dialog(props: DefinedProps<DialogProps, C>) {
  const p = useOpen(props)
  const w = useDialog(p)
  return <Overlay props={p} w={w} kind="dialog" />
}
