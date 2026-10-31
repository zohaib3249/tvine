import { isValidElement } from 'react'

// jsx-runtime.md §What qualifies / §Stable auto-ids. Pure and server-safe: the JSX runtime calls
// `wraps` on every intrinsic element, so the common case (a plain div) is a few property reads.
export type Props = Record<string, unknown>

export interface AgentProps {
  agent?: false | 'group'           // false: opt this subtree out ('group' reserved, not applied yet)
  agentId?: string                  // explicit name → `<parent> > <role>:<agentId>`
  agentLabel?: string
  agentConfirm?: boolean | string   // opt-in in-tab prompt before an agent action
  agentSensitive?: boolean          // value never exposed
}

export const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider',
  'spinbutton', 'combobox', 'textbox', 'treeitem'])
const INPUT: Record<string, string | null> = {
  hidden: null, checkbox: 'checkbox', radio: 'radio', range: 'slider', date: 'date', time: 'date', 'datetime-local': 'date',
  month: 'date', week: 'date', color: 'color', file: 'file', submit: 'button', button: 'button', reset: 'button', image: 'button',
}

export const inputType = (p: Props): string => String(p.type ?? 'text').toLowerCase()
// Browsers ignore control chars/whitespace inside a scheme ("java\tscript:").
export const safeHref = (h: unknown): h is string => typeof h === 'string' && !/^(javascript|data|vbscript):/i.test(h.replace(/[\u0000- \u007F]/g, ''))
const handler = (p: Props) => p.onClick !== undefined || p.onChange !== undefined || p.onInput !== undefined || p.onSubmit !== undefined

export function roleOf(tag: string, p: Props): string | null {
  const r = p.role
  if (typeof r === 'string' && ROLES.has(r)) return r
  switch (tag) {
    case 'button': return 'button'
    case 'a': if (safeHref(p.href)) return 'link'; break
    case 'input': { const t = inputType(p); return t in INPUT ? INPUT[t]! : 'input' }
    case 'select': return 'select'
    case 'textarea': return 'textarea'
    case 'form': return 'form'
    case 'details': return 'disclosure'
  }
  return handler(p) ? 'x-clickable' : null
}

export const wraps = (tag: string, p: Props): boolean =>
  roleOf(tag, p) !== null || p.agent !== undefined || p.agentId !== undefined || p.agentLabel !== undefined ||
  p.agentConfirm !== undefined || p.agentSensitive !== undefined

const on = (v: unknown) => v === true || v === 'true'
export const offByProps = (p: Props): boolean =>
  !!p.disabled || (p.hidden !== undefined && p.hidden !== false) || on(p['aria-hidden']) || on(p['aria-disabled']) || !!p.inert

export const sensitive = (tag: string, p: Props): boolean =>
  p.agentSensitive === true || (tag === 'input' && inputType(p) === 'password') || /password|(^|\s)cc-/i.test(String(p.autoComplete ?? ''))

// Visible text of plain children: strings, numbers, and intrinsic (or auto-wrapped) elements' text.
export function textOf(c: unknown): string {
  if (typeof c === 'string' || typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(textOf).join('')
  if (isValidElement<Props>(c) && (typeof c.type === 'string' || c.props.$tag)) return ` ${textOf(c.props.children)} `
  return ''
}

const UNSAFE = /[^\p{L}\p{N}_.:@/+-]/gu
const slug = (s: unknown) => typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, '-').replace(UNSAFE, '').replace(/^-+|-+$/g, '').slice(0, 32) : ''
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && v !== '' ? String(v) : undefined

// Dev-chosen sources stay raw (W1's segmentOf cleans them); human text is slugged.
export function nameOf(tag: string, p: Props, key: string | null | undefined): string | undefined {
  return str(p.agentId) ?? str(p.name) ?? str(key ?? undefined)
    ?? (slug(p['aria-label']) || slug(textOf(p.children)) || slug(p.placeholder) || slug(p.title) || undefined)
    ?? (tag === 'a' && safeHref(p.href) ? p.href.replace(UNSAFE, '_') : undefined)
}

const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
export const labelOf = (tag: string, p: Props): string =>
  clean(p.agentLabel) || clean(p['aria-label']) || clean(textOf(p.children)) || clean(p.placeholder) || clean(p.title) ||
  clean(p.name) || (tag === 'a' ? clean(p.href) : '')
