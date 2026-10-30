// Notation cells (shared with serialize/notation.ts) + the v2 snapshot body. Browser-safe: no imports
// outside src/shape.
import type { Shaped, SnapNode } from './disclose.js'

export const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i
export const MONEY = /^(-?\d+(\.\d+)?)([A-Z]{3})$/
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
export const quote = (s: string) => ascii(JSON.stringify(s))

// Quote only when the bare form would be ambiguous: space, quote, backslash, sigil, null/bool/number/money lookalike.
const needsQuote = (s: string) =>
  s === '' || s === '-' || s === 'true' || s === 'false' || NUM.test(s) || MONEY.test(s) || /[\s"\\#=@!>{[]|[^\x21-\x7e]/.test(s)
export const str = (s: string) => (needsQuote(s) ? quote(s) : s)
// Looser rule for head page / bind (opaque tails): `=` and sigils are fine there.
export const bare = (s: string) => (s === '' || /[\s"\\]|[^\x21-\x7e]/.test(s) ? quote(s) : s)

export const isMoney = (v: object): v is { value: number; currency: string } => {
  const o = v as { value?: unknown; currency?: unknown }
  return Object.keys(v).length === 2 && typeof o.value === 'number' && /^-?\d+(\.\d{1,2})?$/.test(String(o.value)) &&
    typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency)
}

// One value → one token.
export function cell(v: unknown): string {
  if (v === undefined || v === null) return '-'
  if (typeof v === 'string') return str(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '-'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object' && !Array.isArray(v) && isMoney(v)) return `${v.value.toFixed(2)}${v.currency}`   // major units, always 2 decimals (29.90USD)
  return ascii(JSON.stringify(v))   // JSON-cell escape hatch
}

// Action id / param name / param type: also quote the action-line delimiters.
const part = (s: string) => (s === '' || /[\s"\\(),:?]|[^\x21-\x7e]/.test(s) ? quote(s) : s)
export const actionLine = (a: { id: string; params: { name: string; type: string; required: boolean }[]; bind: string }) =>
  `! ${part(a.id)}(${a.params.map(p => `${part(p.name)}${p.required ? '' : '?'}:${part(p.type)}`).join(',')}) bind=${bare(a.bind)}`

export const HINT2 = '#hint ~ id kind "label" k=v | controls · @type cols then rows, "-"=null · > href label · ! act(p:type) bind=<b> -> POST {action,params,sid,bind} · + more'

const KV = ['of', 'count', 'next', 'shown', 'href', 'at', 'n', 'state', 'desc'] as const

// v2 body lines: `= title`, `~` node lines (+ rows / links / actions under them), `+` expand hints.
export function notationBody(s: Shaped): string[] {
  const out: string[] = []
  if (s.title) out.push('= ' + (/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(s.title) && s.title[0] !== '"' ? s.title : quote(s.title)))
  for (const n of s.nodes) node(n, out)
  for (const l of s.links ?? []) out.push(`> ${str(l.id)} ${str(l.href)} ${str(l.label)}${l.params ? ' ' + cell(l.params) : ''}`)
  if (s.hint) out.push('+ expand(id)')
  return out
}

function node(n: SnapNode, out: string[]) {
  let l = `~ ${str(n.id)} ${str(n.kind)}`
  if (n.label !== undefined) l += ' ' + quote(n.label)
  for (const k of KV) if (n[k] !== undefined) l += ` ${k}=${cell(n[k])}`
  for (const [k, v] of Object.entries(n.data ?? {})) l += ` ${str(k)}=${cell(v)}`
  if (n.sum !== undefined) l += ' ' + quote(n.sum)
  if (n.ctl?.length) l += ' | ' + n.ctl.join('; ')
  out.push(l)
  if (n.cols && n.rows) {
    const hdr = `@${str(n.of ?? '?')} ${n.cols.map(str).join(' ')}`
    n.rows.forEach((r, i) => {
      if (i % 25 === 0) out.push(hdr)   // header repeat: positional recall degrades with distance
      const line = r.map(cell).join(' ')
      out.push(/^[~+]/.test(line) ? quote(String(r[0])) + line.slice(cell(r[0]).length) : line)   // a row never reads as a v2 sigil line
    })
  }
  for (const k of n.links ?? []) out.push(`> ${str(k.href)} ${str(k.label)}${k.params ? ' ' + cell(k.params) : ''}`)
  for (const a of n.actions ?? []) out.push(actionLine(a))
  if (n.more) out.push(`+ ${str(n.id)} ${quote(n.more)}`)
}
