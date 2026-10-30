import type { WidgetSpec } from './types.js'

// control-tree.md: ids are paths; never useId, never render order / index.
export const SEP = ' > '

export function segmentOf(spec: Pick<WidgetSpec, 'id' | 'name' | 'kind' | 'data'>): string {
  if (spec.id) return spec.id
  const k = spec.name ?? spec.data?.id ?? spec.data?.key
  if (typeof k === 'string' || typeof k === 'number') return `${spec.kind}:${k}`
  throw new Error(`tvine: ${spec.kind} widget needs a name (or id, or data.id / data.key as string|number)`)
}

export const joinId = (parent: string, segment: string): string => (parent ? `${parent}${SEP}${segment}` : segment)

// Entities are global (placement goes in `p`); everything else is scoped by its parent.
export const widgetId = (parent: string, spec: WidgetSpec): string => spec.entity ?? joinId(parent, segmentOf(spec))
