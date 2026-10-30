import type { WidgetSpec } from './types.js'

// control-tree.md: ids are paths; never useId, never render order / index.
export const SEP = ' > '
export const MAX_ID = 256

// Segments come from user data (slugs, keys, tags), so they must not be able to forge a path: no `>`,
// no spaces, no control chars. Unsafe chars become `_` and length is capped, in every env; dev also
// logs (never throws: a user tag with a space must not crash the page).
const UNSAFE = /[^\p{L}\p{N}_.:@/+-]/gu

function safe(seg: string, what: string): string {
  const bad = UNSAFE.test(seg)
  UNSAFE.lastIndex = 0
  if (!bad && seg.length <= MAX_ID) return seg
  if (process.env.NODE_ENV !== 'production') {
    console.error(`tvine: unsafe widget ${what} "${seg.slice(0, 80)}" — only letters, digits, _ . : @ / + - and ≤ ${MAX_ID} chars; cleaned`)
  }
  return seg.replace(UNSAFE, '_').slice(0, MAX_ID)
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
