'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { AutoOff, flag, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'
import { showPopover } from './_position.js'

// widgets/menu.md: APG menu button. Content is a `popover` (top layer, light dismiss); items are
// declared, so `choose` enumerates them while closed. choose = open → click the item → close.
// ponytail: props API (items[]), no checkbox/radio items, submenus, typeahead or arrow-key roving yet.
export type MenuItem = { id: string; label: ReactNode; onSelect?(): void; disabled?: boolean }
type C = Record<string, Control<any, any>>
type S = { open: boolean; items: string[] }
export type MenuProps = {
  name: string; label: string; trigger?: ReactNode; items: MenuItem[]
  open?: boolean; defaultOpen?: boolean; onOpenChange?(open: boolean): void
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'trigger' | 'content' | 'item', S>
  kind?: 'menu' | 'context-menu'
}

export const menuDef = (kind: 'menu' | 'context-menu', openSel: string) => defineWidget<MenuProps, S, C>({
  kind,
  state: (p) => ({ open: !!p.open, items: p.items.filter((i) => !i.disabled).map((i) => i.id) }),
  controls: ({ props: p, el }): C => {
    const items = p.items.filter((i) => !i.disabled).map((i) => i.id)
    const c: C = {
      choose: { kind: 'click', params: { item: { type: 'string', enum: items } }, run: async (a: { item: string }, ctx) => {
        if (!p.open) inner<HTMLElement>(ctx, el(), openSel).dispatchEvent(new MouseEvent(kind === 'menu' ? 'click' : 'contextmenu', { bubbles: true, cancelable: true }))
        inner<HTMLButtonElement>(ctx, el(), `[role=menuitem][data-item="${CSS.escape(a.item)}"]`).click()
      } },
    }
    if (p.open) c.close = { kind: 'close', run: () => p.onOpenChange?.(false) }
    else if (kind === 'menu') c.open = { kind: 'open', run: async (_a, ctx) => { inner<HTMLButtonElement>(ctx, el(), openSel).click() } }
    return c
  },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name }),
})
const useMenu = menuDef('menu', '[data-part=trigger]')

export function MenuView({ p, w, kind, trigger }: { p: MenuProps & { onOpenChange(o: boolean): void }; w: ReturnType<typeof useMenu>; kind: string; trigger: ReactNode }) {
  const open = !!p.open
  const ref = useRef<HTMLDivElement>(null)
  const s = w.state
  useEffect(() => { showPopover(ref.current, open) }, [open])
  const st = { 'data-state': open ? 'open' : 'closed' }
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': kind, ...st }, { className: p.className, ...p.slots?.root }, s, <>
    {w.embed}
    {kind === "context-menu" && trigger}{/* the area's own content stays agent-visible */}
    <AutoOff>
      {kind === "menu" && trigger}
      {part('div', { ref, role: 'menu', popover: 'auto', 'aria-label': p.label, hidden: !open, ...st,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') p.onOpenChange(false) } }, p.slots?.content, s,
        p.items.map((i) => part('button', {
          key: i.id, type: 'button', role: 'menuitem', 'data-item': i.id, disabled: i.disabled, 'data-disabled': flag(i.disabled), tabIndex: -1,
          onClick: () => { i.onSelect?.(); p.onOpenChange(false) },
        }, p.slots?.item, s, i.label)))}
    </AutoOff>
  </>)
}

export function useMenuOpen(props: MenuProps) {
  const [open, setOpen] = useControllable<boolean>(props.open, props.defaultOpen ?? false)
  return { ...props, open, onOpenChange: (v: boolean) => { setOpen(v); props.onOpenChange?.(v) } }
}

export function Menu(props: DefinedProps<MenuProps, C>) {
  const p = useMenuOpen(props)
  const w = useMenu(p)
  const trigger = part('button', { type: 'button', 'data-part': 'trigger', 'aria-haspopup': 'menu', 'aria-expanded': p.open, 'data-state': p.open ? 'open' : 'closed', onClick: () => p.onOpenChange(!p.open) }, p.slots?.trigger, w.state, p.trigger ?? p.label)
  return <MenuView p={p} w={w} kind="menu" trigger={trigger} />
}
