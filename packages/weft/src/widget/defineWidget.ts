'use client'
import { useCallback, useRef, useState } from 'react'
import { applyOverrides } from './hooks.js'
import type { Control, ControlOverrides, HeadlessMap, Json, PresenceOptions, Widget, WidgetHooks, WidgetKind, WidgetSpec } from './types.js'
import { useWidget } from './useWidget.js'

export interface WidgetDef<P, S extends Json, C extends Record<string, Control<any, any>>> {
  kind: WidgetKind | `x-${string}`
  state(props: P): S
  controls(api: { props: P; state: S; set(next: Partial<S>): void; el(): HTMLElement | null }): C
  headless?(props: P): Partial<Record<keyof C, HeadlessMap>>
  describe?(props: P): { label: string; summary?: string[] }
  // Extra spec fields: sensitive (password Input), personal, data, entity, hidden, …
  spec?(props: P): Partial<Omit<WidgetSpec, 'kind' | 'state' | 'controls' | 'hooks'>>
}
export type DefinedProps<P, C> = P & {
  id?: string; name?: string; label?: string; disabled?: boolean; presence?: false | PresenceOptions
  controls?: ControlOverrides<C>; hooks?: WidgetHooks
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

// Every built-in is a defineWidget kind on useWidget (dogfooding: agents can't tell built-in from custom).
export function defineWidget<P, S extends Json, C extends Record<string, Control<any, any>>>(def: WidgetDef<P, S, C>) {
  return function useDefinedWidget(props: DefinedProps<P, C>): Widget & { state: S } {
    // Internal state seeded from props; re-seeded during render when props change it (derived-state pattern).
    const derived = def.state(props)
    const [own, setOwn] = useState(derived)
    const [seen, setSeen] = useState(derived)
    let state = own
    // By value: state is JSON, and props often build fresh arrays/objects every render.
    if (JSON.stringify(seen) !== JSON.stringify(derived)) { setSeen(derived); setOwn(derived); state = derived }

    const el = useRef<HTMLElement | null>(null)
    let controls: Record<string, Control<any, any>> = def.controls({
      props, state,
      set: (next) => setOwn((s) => ({ ...(s as object), ...next }) as S),
      el: () => el.current,
    })
    const maps = def.headless?.(props)
    if (maps) controls = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, maps[k] ? { ...c, headless: maps[k] } : c]))
    const desc = def.describe?.(props)

    const w = useWidget({
      label: desc?.label ?? '', ...(desc?.summary && { summary: desc.summary }),
      ...def.spec?.(props),
      ...defined({ id: props.id, name: props.name, label: props.label, disabled: props.disabled, presence: props.presence }),
      kind: def.kind,
      state, controls: applyOverrides(controls, props.controls), hooks: props.hooks,
    })
    const wref = w.ref
    const ref = useCallback((node: HTMLElement | null) => { el.current = node; wref(node) }, [wref])
    return { ...w, ref, state }
  }
}
