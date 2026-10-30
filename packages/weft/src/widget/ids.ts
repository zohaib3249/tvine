import type { WidgetSpec } from './types.js'

// control-tree.md: ids are paths; never useId, never render order / index.
export const SEP = ' > '
export const MAX_ID = 256

// Segments come from user data (slugs, keys), so they must not be able to forge a path: no `>`,
// no spaces, no control chars. Dev throws; production replaces unsafe chars with `_` and caps length.
const UNSAFE = /[^\p{L}\p{N}_.:@/+-]/gu

function safe(seg: string, what: string): string {
  const bad = seg.match(UNSAFE)
  if (process.env.NODE_ENV !== 'production') {
    if (bad) throw new Error(`tvine: unsafe character ${JSON.stringify(bad[0])} in widget ${what} "${seg}" (allowed: letters, digits, _ . : @ / + -)`)
    if (seg.length > MAX_ID) throw new Error(`tvine: widget ${what} longer than ${MAX_ID} chars`)
    return seg
  }
  return (bad ? seg.replace(UNSAFE, '_') : seg).slice(0, MAX_ID)
}

export function segmentOf(spec: Pick<WidgetSpec, 'id' | 'name' | 'kind' | 'data'>): string {
  if (spec.id) return safe(spec.id, 'id')
  const k = spec.name ?? spec.data?.id ?? spec.data?.key
  if (typeof k === 'string' || typeof k === 'number') return safe(`${spec.kind}:${k}`, 'name')
  throw new Error(`tvine: ${spec.kind} widget needs a name (or id, or data.id / data.key as string|number)`)
}

export const joinId = (parent: string, segment: string): string => (parent ? `${parent}${SEP}${segment}` : segment)

// Entities are global (placement goes in `p`); everything else is scoped by its parent.
export const widgetId = (parent: string, spec: WidgetSpec): string =>
  spec.entity ? safe(spec.entity, 'entity') : joinId(parent, segmentOf(spec))
