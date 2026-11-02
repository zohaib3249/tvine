// The one condition engine (contract `evaluate`): rules run it on Signals, the /shield panel access check on the
// user row. Pure and sync: no I/O, no throwing on odd input (a malformed condition matches nothing).
import type { BlockList } from 'node:net'
import { blockList, ipIn } from '../../middleware/index.js'
import type { Cond, Condition, Op } from './types.js'

export const OPS: readonly Op[] = ['eq', 'neq', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'regex', 'gt', 'lt', 'cidr']
const MAX_DEPTH = 16
export const MAX_REGEX = 200      // pattern length cap
const MAX_SUBJECT = 2048          // a regex never scans more than this many chars

// field lookup: the flat key first ('asn.kind', 'header.x-foo' as the rules context spells them), then a dotted path
export function fieldOf(ctx: Record<string, unknown>, field: string): unknown {
  if (Object.hasOwn(ctx, field)) return ctx[field]
  let v: unknown = ctx
  for (const k of field.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

// safe regex: length-capped, no nested quantifiers / backrefs (the classic catastrophic shapes), cached
const reCache = new Map<string, RegExp | null>()
export function safeRegex(src: unknown): RegExp | null {
  if (typeof src !== 'string') return null
  if (reCache.has(src)) return reCache.get(src)!
  let re: RegExp | null = null
  // ponytail: heuristic ReDoS guard (nested quantifier, backreference); a real linear engine (re2) if rules come from untrusted users
  if (src.length <= MAX_REGEX && !/\([^)]*[+*}][^)]*\)\s*[+*{?]/.test(src) && !/\\\d/.test(src)) {
    try { re = new RegExp(src, 'i') } catch { re = null }
  }
  if (reCache.size > 500) reCache.clear()
  reCache.set(src, re)
  return re
}
export const regexProblem = (src: unknown): string | undefined => (safeRegex(src) ? undefined : `unsafe or invalid regex (max ${MAX_REGEX} chars, no nested quantifiers or backreferences)`)

const cidrCache = new Map<string, BlockList | null>()
function cidrList(v: unknown): BlockList | null {
  const list = (Array.isArray(v) ? v : [v]).map(String)
  const key = list.join(',')
  if (!cidrCache.has(key)) {
    let b: BlockList | null = null
    try { b = blockList(list, 'shield cidr') } catch { b = null }
    if (cidrCache.size > 500) cidrCache.clear()
    cidrCache.set(key, b)
  }
  return cidrCache.get(key)!
}

const str = (x: unknown) => (x === undefined || x === null ? '' : String(x)).toLowerCase()
const looseEq = (a: unknown, b: unknown) => a === b || (a !== undefined && a !== null && b !== undefined && b !== null && typeof a !== 'object' && typeof b !== 'object' && str(a) === str(b))

function test(c: Cond, ctx: Record<string, unknown>): boolean {
  const v = fieldOf(ctx, c.field)
  const want = c.value
  switch (c.op) {
    case 'eq': return looseEq(v, want)
    case 'neq': return !looseEq(v, want)
    case 'in': return Array.isArray(want) && (Array.isArray(v) ? v.some((x) => want.some((w) => looseEq(x, w))) : want.some((w) => looseEq(v, w)))
    case 'notIn': return Array.isArray(want) && !(Array.isArray(v) ? v.some((x) => want.some((w) => looseEq(x, w))) : want.some((w) => looseEq(v, w)))
    // contains: an array has the element (groups contains 'security'), a string has the substring
    case 'contains': return Array.isArray(v) ? v.some((x) => looseEq(x, want)) : v !== undefined && v !== null && str(v).includes(str(want))
    case 'startsWith': return v !== undefined && v !== null && str(v).startsWith(str(want))
    case 'endsWith': return v !== undefined && v !== null && str(v).endsWith(str(want))
    case 'regex': { const re = safeRegex(want); return !!re && v !== undefined && v !== null && re.test(String(v).slice(0, MAX_SUBJECT)) }
    case 'gt': return typeof v === 'number' && Number.isFinite(Number(want)) && v > Number(want)
    case 'lt': return typeof v === 'number' && Number.isFinite(Number(want)) && v < Number(want)
    case 'cidr': { const b = cidrList(want); return !!b && typeof v === 'string' && ipIn(b, v) }
    default: return false
  }
}

export function evaluate(cond: Condition, ctx: Record<string, unknown>, depth = 0): boolean {
  if (!cond || typeof cond !== 'object' || depth > MAX_DEPTH) return false
  if ('all' in cond) return Array.isArray(cond.all) && cond.all.every((c) => evaluate(c, ctx, depth + 1))
  if ('any' in cond) return Array.isArray(cond.any) && cond.any.some((c) => evaluate(c, ctx, depth + 1))
  if ('not' in cond) return !!cond.not && typeof cond.not === 'object' && !evaluate(cond.not, ctx, depth + 1)
  if ('field' in cond && typeof cond.field === 'string' && OPS.includes(cond.op)) return test(cond, ctx)
  return false
}

// server-side validation for saved conditions (rules + panel access): the first problem, or undefined
export function conditionProblem(cond: unknown, depth = 0): string | undefined {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return 'a condition is an object'
  if (depth > MAX_DEPTH) return `conditions nest at most ${MAX_DEPTH} deep`
  const c = cond as Record<string, unknown>
  for (const k of ['all', 'any'] as const) if (k in c) return Array.isArray(c[k]) ? (c[k] as unknown[]).map((x) => conditionProblem(x, depth + 1)).find(Boolean) : `${k} takes a list`
  if ('not' in c) return conditionProblem(c.not, depth + 1)
  if (typeof c.field !== 'string' || !c.field) return 'a condition needs a field'
  if (!OPS.includes(c.op as Op)) return `unknown op "${String(c.op)}" (${OPS.join(', ')})`
  if ((c.op === 'in' || c.op === 'notIn') && !Array.isArray(c.value)) return `${c.op} takes a list`
  if (c.op === 'regex') return regexProblem(c.value)
  if (c.op === 'cidr' && !cidrList(c.value)) return `"${String(c.value)}" is not an IP or CIDR`
  return undefined
}
