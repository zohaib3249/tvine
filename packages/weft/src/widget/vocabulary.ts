import type { ActionKind, Control, ParamSpec, WidgetSpec } from './types.js'

// action-vocabulary.md: the closed list of verbs.
export const ACTION_KINDS = [
  'click', 'input', 'clear', 'select', 'toggle', 'set', 'open', 'close',
  'submit', 'navigate', 'scroll', 'focus', 'move', 'upload',
] as const satisfies readonly ActionKind[]

// Honesty rule: disabled controls are not listed and not callable (same answer as missing).
export function listed(spec: WidgetSpec): [string, Control<any, any>][] {
  if (spec.disabled || !spec.controls) return []
  return Object.entries(spec.controls).filter(([, c]) => c && c.enabled !== false)
}

const TYPE: Record<ParamSpec['type'], string> = { string: 'text', number: 'number', boolean: 'bool', date: 'date', file: 'file', json: 'json' }

function typeOf(p: ParamSpec): string {
  const t = p.enum?.length ? p.enum.join('|')
    : p.type === 'number' && p.min !== undefined && p.max !== undefined ? `${p.min}..${p.max}`
    : TYPE[p.type]
  return `${t}${p.multiple ? '[]' : ''}${p.secret ? ' (secret)' : ''}`
}

// `name(param: type, param?: type)`, kind appended only when it differs from the name.
// ponytail: W2's shaper (@tvine/warp/shape) prints the same strings from fragments; keep the two golden tables equal.
export function signature(name: string, c: Pick<Control, 'kind' | 'params'>): string {
  const ps = Object.entries((c.params ?? {}) as Record<string, ParamSpec>).map(([k, p]) => `${k}${p.optional ? '?' : ''}: ${typeOf(p)}`)
  return `${name}(${ps.join(', ')})${c.kind === name ? '' : ` [${c.kind}]`}`
}
