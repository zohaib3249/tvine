'use client'
import type { DefinedProps } from '../widget/defineWidget.js'
import type { Control } from '../widget/types.js'
import { Overlay, useOpen, useOverlay, type DialogProps } from './dialog.js'

// widgets/drawer.md: a modal <dialog> pinned to an edge (side → data-side; style it with CSS).
// ponytail: no swipe-to-close / snap points.
type C = Record<string, Control<any, any>>
export type DrawerProps = DialogProps & { side?: 'left' | 'right' | 'top' | 'bottom' }
const useDrawer = useOverlay('drawer')

export function Drawer(props: DefinedProps<DrawerProps, C>) {
  const p = useOpen(props)
  const w = useDrawer(p)
  return <Overlay props={p} w={w} kind="drawer" extra={{ 'data-side': props.side ?? 'right' }} />
}
