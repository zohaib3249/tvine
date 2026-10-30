'use client'
import { useState } from 'react'
import { getRegistry, shallowChanged } from '../runtime/registry.client.js'
import { applyOverrides } from './hooks.js'
import type { Control, ControlOverrides, HeadlessMap, Json, PresenceOptions, Widget, WidgetHooks, WidgetKind } from './types.js'
import { useWidget } from './useWidget.js'

export interface WidgetDef<P, S extends Json, C extends Record<string, Control<any, any>>> {
  kind: WidgetKind | `x-${string}`
  state(props: P): S
  controls(api: { props: P; state: S; set(next: Partial<S>): void; el(): HTMLElement | null }): C
  headless?(props: P): Partial<Record<keyof C, HeadlessMap>>
  describe?(props: P): { label: string; summary?: string[] }
}
export type DefinedProps<P, C> = P & {
  id?: string; name?: string; label?: string; disabled?: boolean; presence?: false | PresenceOptions
  controls?: ControlOverrides<C>; hooks?: WidgetHooks
}

// Every built-in is a defineWidget kind on useWidget (dogfooding: agents can't tell built-in from custom).
export function defineWidget<P, S extends Json, C extends Record<string, Control<any, any>>>(def: WidgetDef<P, S, C>) {
  return function useDefinedWidget(props: DefinedProps<P, C>): Widget & { state: S } {
    // Internal state seeded from props; re-seeded during render when props change it (derived-state pattern).
    const derived = def.state(props)
    const [own, setOwn] = useState(derived)
    const [seen, setSeen] = useState(derived)
    let state = own
    if (shallowChanged(seen, derived)) { setSeen(derived); setOwn(derived); state = derived }

    let id = ''
    let controls: Record<string, Control<any, any>> = def.controls({
      props, state,
      set: (next) => setOwn((s) => ({ ...(s as object), ...next }) as S),
      el: () => getRegistry().get(id)?.el ?? null,
    })
    const maps = def.headless?.(props)
    if (maps) controls = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, maps[k] ? { ...c, headless: maps[k] } : c]))
    const desc = def.describe?.(props)

    const w = useWidget({
      kind: def.kind, id: props.id, name: props.name, disabled: props.disabled, presence: props.presence,
      label: props.label ?? desc?.label ?? '', ...(desc?.summary && { summary: desc.summary }),
      state, controls: applyOverrides(controls, props.controls), hooks: props.hooks,
    })
    id = w.id
    return { ...w, state }
  }
}
