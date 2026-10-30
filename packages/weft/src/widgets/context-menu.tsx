'use client'
import type { ReactNode } from 'react'
import type { DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { part } from './_parts.js'
import { MenuView, menuDef, useMenuOpen, type MenuProps } from './menu.js'

// widgets/context-menu.md: right-click (contextmenu) on the area opens the same menu. Agents use choose.
// ponytail: menu opens in place (no pointer positioning); long-press comes from the browser's contextmenu.
type C = Record<string, Control<any, any>>
export type ContextMenuProps = Omit<MenuProps, 'trigger'> & { children?: ReactNode }
const useCtx = menuDef('context-menu', '[data-part=area]')

export function ContextMenu(props: DefinedProps<ContextMenuProps, C>) {
  const p = useMenuOpen(props)
  const w = useCtx(p)
  const area = part('div', { 'data-part': 'area', onContextMenu: (e: MouseEvent) => { e.preventDefault(); p.onOpenChange(true) } }, undefined, w.state, props.children)
  return <MenuView p={p} w={w} kind="context-menu" trigger={area} />
}
