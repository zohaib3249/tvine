// Progressive disclosure (docs/design/frontend/v2/core/progressive-disclosure.md): the extracted
// page → a tree → L0 map / L1 / full, chosen by a token budget; expand(id) = L2 of one node.
// Browser-safe (Weft runs the same code on the in-tab registry): no imports outside src/shape.
import { isMoney } from './notation.js'

type Json = unknown
type Data = Record<string, unknown>
export interface ActionRef { id: string; params: { name: string; type: string; required: boolean }[]; bind: string }
export interface V1Node { id: string; type: string; data: Data; actions: ActionRef[] }
export interface V1Link { id: string; href: string; label: string; params?: string[] }
export interface ParamSpec {
  type: string; enum?: readonly unknown[]; min?: number; max?: number
  multiple?: boolean; optional?: boolean; secret?: boolean
}
export interface CtlFrag { kind: string; in?: Record<string, ParamSpec>; h?: unknown; enabled?: boolean }
// The `w` of a v2 fragment `{"v":2,"k":"w","w":{…}}` (snapshot-format.md §fragment).
export interface WidgetFrag {
  id: string; p?: string; kind: string; label?: string; desc?: string; state?: Json
  ctl?: Record<string, CtlFrag>; e?: string; data?: Data; actions?: ActionRef[]
  sum?: string; summary?: string[]; detail?: string[]; hidden?: string[]; collapsed?: boolean; sensitive?: boolean
  at?: string[]                     // set by the extractor: every parent of a merged entity
}
// folds: link id → the entity node it directly followed in the page (extractor), for `href` folding
export interface ShapeSource { page: string; title: string; nodes: V1Node[]; links: V1Link[]; widgets?: WidgetFrag[]; folds?: Record<string, string> }

export type View = 'full' | 'L1' | 'L0' | 'L2'
export interface NavLink { href: string; label: string; params?: string[] }
export interface SnapNode {
  id: string; kind: string; label?: string; desc?: string; state?: Json; data?: Data
  ctl?: string[]; actions?: ActionRef[]; href?: string; links?: NavLink[]
  of?: string; count?: number; next?: string; shown?: number; cols?: string[]; rows?: Json[][]
  at?: string[]; n?: number; sum?: string; more?: string
  does?: string                     // L0: what the subtree offers — frontend controls first, backend actions after
}
export interface Shaped { view: View; page: string; title: string; nodes: SnapNode[]; links?: V1Link[]; hint?: string }

interface T {
  id: string; kind: string; label?: string; desc?: string; state?: Json; data?: Data
  ctl?: string[]; actions?: ActionRef[]; href?: string; links: NavLink[]
  count?: number; next?: string; at?: string[]; sum?: string; collapsed?: boolean
  summary?: string[]; detail?: string[]
  kids: T[]; rows: T[]; of?: string
  tpl?: boolean                     // list whose rows have their own widgets (×N template lines at L1)
}
export interface SnapTree { page: string; title: string; roots: T[]; links: V1Link[] }

const SEP = ' > '
const STRUCT = new Set(['section', 'list', 'form', 'input'])
const HINT = 'expand(id) shows a node in full'
const L0_NODES = 30, L0_LINKS = 10
const parentOf = (id: string) => { const i = id.lastIndexOf(SEP); return i < 0 ? undefined : id.slice(0, i) }
const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v) || (!!v && typeof v === 'object' && isMoney(v))
const fmt = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && isMoney(v) ? `${v.value.toFixed(2)} ${v.currency}` : v)
const fmtData = (d: Data) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, fmt(v)]))
const omit = <O extends object>(o: O): O => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as O

// `e` = the full global entity id ('product:12'); its type is what agents see and which serializer runs,
// whatever the widget kind (data, card, …). No `<type>:` prefix → not an entity (fail closed: kind stays).
export const entityType = (e: string | undefined): string | undefined => {
  const i = e?.indexOf(':') ?? -1
  return i > 0 ? e!.slice(0, i) : undefined
}
export const kindOfWidget = (w: { kind: string; e?: string }) => entityType(w.e) ?? w.kind

// action-vocabulary.md §Signature: `name(param: type, opt?: type)`, kind printed only when it differs.
// Exported: Weft's in-tab signature() must print the same strings (one implementation).
export function signature(name: string, c: CtlFrag): string {
  const ty = (s: ParamSpec) => {
    if (s.secret) return 'text (secret)'
    const t = s.enum ? s.enum.join('|')
      : s.type === 'number' && s.min !== undefined && s.max !== undefined ? `${s.min}..${s.max}`
      : ({ string: 'text', boolean: 'bool' } as Record<string, string>)[s.type] ?? s.type
    return s.multiple ? `${t}[]` : t
  }
  const ps = Object.entries(c.in ?? {}).map(([k, s]) => `${k}${s.optional ? '?' : ''}: ${ty(s)}`).join(', ')
  return `${name}(${ps})${c.kind !== name ? ` [${c.kind}]` : ''}`
}

// Sensitive widgets report {filled} only (security.md §5), whatever the fragment carried.
const filled = (s: Json) => ({ filled: !!(s && typeof s === 'object' && 'value' in s ? (s as { value: unknown }).value : s) })

function fromWidget(w: WidgetFrag, headless: boolean): T {
  const hide = new Set(w.hidden ?? [])
  const data = w.data && fmtData(Object.fromEntries(Object.entries(w.data).filter(([k]) => !hide.has(k))))
  // h.params.agent === false: the control's server action is not agent-callable → not listed
  const callable = (c: CtlFrag) => (c.h as { params?: { agent?: unknown } } | undefined)?.params?.agent !== false
  const ctl = Object.entries(w.ctl ?? {}).filter(([, c]) => c.enabled !== false && callable(c) && (!headless || c.h !== undefined)).map(([k, c]) => signature(k, c))
  return {
    id: w.id, kind: kindOfWidget(w), label: w.label, desc: w.desc,
    state: w.sensitive ? filled(w.state) : w.state, data,
    ctl: ctl.length ? ctl : undefined, actions: w.actions?.length ? w.actions : undefined,
    at: w.at && w.at.length > 1 ? w.at : undefined, sum: w.sum, collapsed: w.collapsed || undefined,
    summary: w.summary?.filter(k => !hide.has(k)), detail: w.detail, links: [], kids: [], rows: [],
  }
}

function fromV1(n: V1Node): T {
  const t: T = { id: n.id, kind: n.type, links: [], kids: [], rows: [], actions: n.actions.length ? n.actions : undefined }
  if (n.type === 'list') t.count = typeof n.data.count === 'number' ? n.data.count : undefined
  else if (n.type === 'form') t.label = String(n.data.intent ?? n.data.action ?? '') || undefined
  else if (n.type !== 'section' && Object.keys(n.data).length) t.data = fmtData(n.data)
  return t
}

// The page → a tree. v1 nodes hang by id prefix (`a > b`); a v1 List's rows are the entity nodes
// that follow it (up to its pageSize); v2 widgets hang by `p`. Links: `<list>:next` → list.next,
// prefixed → that node's links, a link right after an entity (src.folds) labelled with its name/title → its href.
export function toTree(src: ShapeSource, opts: { headless: boolean }): SnapTree {
  const byId = new Map<string, T>(), up = new Map<T, string | undefined>(), order: T[] = []
  const add = (t: T, p: string | undefined) => { if (byId.has(t.id)) return; byId.set(t.id, t); up.set(t, p); order.push(t) }
  let list: T | undefined, want = 0
  for (const n of src.nodes) {
    const t = fromV1(n), p = parentOf(n.id)
    if (n.type === 'section' || n.type === 'list') list = undefined
    if (list && want > 0 && !STRUCT.has(n.type) && !n.actions.length && p === parentOf(list.id)) { add(t, list.id); want--; continue }
    add(t, p)
    if (n.type === 'list') { list = t; want = Number(n.data.pageSize ?? n.data.count ?? 0) || 0 }
  }
  for (const w of src.widgets ?? []) add(fromWidget(w, opts.headless), w.p)

  const roots: T[] = [], links: V1Link[] = []
  for (const t of order) {
    const p = up.get(t), parent = p === undefined ? undefined : byId.get(p)
    if (parent && !cyclic(t, byId, up)) parent.kids.push(t)
    else roots.push(t)
  }
  for (const l of src.links) {
    const nav = omit({ href: l.href, label: l.label, params: l.params })
    const owner = l.id.endsWith(':next') ? byId.get(l.id.slice(0, -5)) : undefined
    const host = parentOf(l.id) === undefined ? undefined : byId.get(parentOf(l.id)!)
    const ent = src.folds?.[l.id] === undefined ? undefined : byId.get(src.folds[l.id])
    if (owner?.kind === 'list' && owner.next === undefined) owner.next = l.href
    else if (host) host.links.push(nav)
    else if (ent && ent.href === undefined && (ent.data?.name ?? ent.data?.title) === l.label) ent.href = l.href
    else links.push(l)
  }
  for (const t of order) tabulate(t)
  return { page: src.page, title: src.title, roots, links }
}

function cyclic(t: T, byId: Map<string, T>, up: Map<T, string | undefined>): boolean {
  const seen = new Set<T>()
  for (let c: T | undefined = t; c; c = byId.get(up.get(c) ?? '')) { if (seen.has(c)) return true; seen.add(c) }
  return false
}

// A list's children of ONE entity kind (plain data, single parent) become table rows.
function tabulate(t: T) {
  if (t.kind !== 'list' || !t.kids.length) return
  const ok = (k: T) => k.data && !k.actions && !k.ctl && k.state === undefined && !k.links.length && !k.at && !k.collapsed
  if (!t.kids.every(ok) || new Set(t.kids.map(k => k.kind)).size !== 1) return
  t.of = t.kids[0].kind
  t.rows = t.kids
  t.kids = []
  t.tpl = t.rows.some(r => r.kids.length)   // a row's own widgets: after the table (full), ×N lines (L1)
}

// L1: one line per distinct row control, `product:* > form:add  submit(qty: 1..10)  ×24` → n = 24
function templates(t: T): SnapNode[] {
  const m = new Map<string, SnapNode>()
  for (const r of t.rows) for (const k of r.kids) {
    const id = `${t.of}:*${k.id.startsWith(r.id) ? k.id.slice(r.id.length) : SEP + k.id}`
    const key = JSON.stringify([id, k.kind, k.ctl])
    const hit = m.get(key)
    if (hit) hit.n!++
    else m.set(key, omit({ id, kind: kindOf(k), ctl: k.ctl, n: 1 }))
  }
  return [...m.values()]
}

// ---- levels ----
const summaryOf = (t: T, sample: T[]): string[] => {
  const s = t.summary ?? sample[0]?.summary
  if (s) return s
  const keys = [...new Set(sample.flatMap(r => Object.keys(r.data ?? {})))]
  return keys.filter(k => sample.some(r => scalar(r.data?.[k]))).slice(0, 4)
}
const pick = (d: Data | undefined, ks: string[]) => d && Object.fromEntries(ks.filter(k => k in d).map(k => [k, d[k]]))
const pickDetail = (d: Data | undefined, t: T) => (d && t.detail ? Object.fromEntries(Object.entries(d).filter(([k]) => !t.detail!.includes(k))) : d)

// "category shirts", "category pants" → "category shirts|pants"
function joinLabels(ls: string[]): string {
  const out: string[] = []
  let pre: string | undefined
  for (const l of ls) {
    const i = l.lastIndexOf(' '), p = i > 0 ? l.slice(0, i) : undefined
    if (p !== undefined && p === pre) out[out.length - 1] += '|' + l.slice(i + 1)
    else out.push(l)
    pre = p
  }
  const s = out.join(', ')
  return s.length > 120 ? s.slice(0, 119) + '…' : s
}

function line(t: T): SnapNode {
  const listy = t.kind === 'list'
  const n = t.kids.length + t.rows.length + t.links.length
  const name = t.data?.name ?? t.data?.title
  const sum = t.sum ?? (listy && t.rows.length ? summaryOf(t, t.rows).join(' ')
    : n ? joinLabels([...t.links.map(l => l.label), ...t.kids.map(k => k.label ?? k.id)])
    : typeof name === 'string' ? name : undefined)
  return omit({ id: t.id, kind: kindOf(t), label: t.label, of: t.of, count: t.count, n: n || undefined, sum, does: does(t) })
}

// Owner directive: agents act through the frontend (widget controls) first; direct backend actions stay
// available but are the advanced path. Counted over the whole subtree.
function does(t: T): string | undefined {
  let c = 0, a = 0
  const go = (x: T) => { c += x.ctl?.length ?? 0; a += x.actions?.length ?? 0; x.rows.forEach(go); x.kids.forEach(go) }
  go(t)
  const p = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
  const parts = [c && p(c, 'control'), a && `${c ? 'then ' : ''}${p(a, 'backend action')} (advanced)`].filter(Boolean)
  return parts.length ? parts.join(', ') : undefined
}
const kindOf = (t: T) => (t.kind === 'section' && t.links.length && !t.kids.length ? 'nav' : t.kind)

interface Rows { from: number; limit: number; cols: 'all' | 'summary' }
function more(t: T, from: number, to: number): string | undefined {
  const parts: string[] = []
  if (to < t.rows.length) parts.push(`expand(${JSON.stringify(t.id)}, {offset:${to}}) for rows ${to + 1}-${t.rows.length}`)
  if (t.next) parts.push(`next page: ${t.next}`)
  return parts.length ? parts.join('; ') : undefined
}

function full(t: T, rows: Rows | undefined, summary: boolean): SnapNode {
  const n: SnapNode = omit({
    id: t.id, kind: kindOf(t), label: t.label, desc: t.desc, state: t.state,
    data: summary ? pick(t.data, summaryOf(t, [t])) : pickDetail(t.data, t), ctl: t.ctl, actions: t.actions, href: t.href,
    links: t.links.length ? t.links : undefined, of: t.of, count: t.count,
  })
  if (t.rows.length) {
    const r = rows ?? { from: 0, limit: Infinity, cols: 'all' }
    const slice = t.rows.slice(r.from, r.from + r.limit), to = r.from + slice.length
    const cols = r.cols === 'summary' ? summaryOf(t, t.rows)
      : [...new Set(t.rows.flatMap(x => Object.keys(pickDetail(x.data, x) ?? {})))]
    if (r.cols === 'all' && t.rows.some(x => x.href)) cols.push('href')
    const paged = r.from > 0 || to < t.rows.length
    if (r.cols === 'all' && !paged) n.next = t.next
    if (r.cols === 'summary') n.shown = slice.length
    n.cols = cols
    n.rows = slice.map(x => cols.map(c => (c === 'href' && !(x.data && 'href' in x.data) ? x.href : x.data?.[c]) ?? null))
    if (paged || r.cols === 'summary') n.more = more(t, r.from, to)
  } else if (t.next) n.next = t.next
  if (t.at) n.at = t.at
  return n
}

// DFS, document order. depth limit: L1 = 2. Collapsed nodes stay one line until expanded.
function walk(t: T, view: 'full' | 'L1', depth: number, rowsL1: number, out: SnapNode[], root = false) {
  if (t.collapsed && !root) { out.push(line(t)); return }
  const n = full(t, view === 'L1' ? { from: 0, limit: rowsL1, cols: 'summary' } : undefined, view === 'L1' && !!t.data)
  if (view === 'L1' && depth === 2 && t.kids.length) { n.n = t.kids.length; n.more ??= `expand(${JSON.stringify(t.id)}) for ${t.kids.length} more` }
  out.push(n)
  if (view === 'L1' && depth >= 2) return
  if (t.tpl) {
    if (view === 'L1') out.push(...templates(t))
    else for (const r of t.rows) for (const k of r.kids) walk(k, view, depth + 2, rowsL1, out)
  }
  for (const k of t.kids) walk(k, view, depth + 1, rowsL1, out)
}

const body = (s: Shaped) => { const { view: _, ...b } = s; return b }
const enc = new TextEncoder()
// tokens ≈ UTF-8 bytes / 2.7 (o200k measured 2.76–3.17 bytes/token on the demo shapes: never under-counts them)
export const est = (s: Shaped): number => Math.ceil(enc.encode(JSON.stringify(body(s))).length / 2.7)

export function level(t: SnapTree, view: 'full' | 'L1' | 'L0', rowsL1: number): Shaped {
  const head = { view, page: t.page, title: t.title }
  if (view === 'L0') {
    // capped: the map must stay small; what's cut is counted in the hint
    const more = [t.roots.length > L0_NODES && `${t.roots.length - L0_NODES} more nodes`, t.links.length > L0_LINKS && `${t.links.length - L0_LINKS} more links`].filter(Boolean)
    return omit({ ...head, nodes: t.roots.slice(0, L0_NODES).map(line), links: t.links.length ? t.links.slice(0, L0_LINKS) : undefined,
      hint: HINT + (more.length ? `; ${more.join(', ')} at view=L1` : '') })
  }
  const nodes: SnapNode[] = []
  for (const r of t.roots) walk(r, view, 1, rowsL1, nodes)
  return omit({ ...head, nodes, links: t.links.length ? t.links : undefined })
}

// auto: full if it fits the budget, else L1 if it fits, else the L0 map + hint — L0 only with allowL0
// (ruling: off until W5 ships expand/view, so an agent can always get past the map).
export function disclose(t: SnapTree, opts: { budget: number; rowsL1: number; view?: 'auto' | 'full' | 'L1' | 'L0'; allowL0?: boolean }): Shaped {
  const v = opts.view ?? 'auto'
  if (v !== 'auto') return level(t, v, opts.rowsL1)
  const f = level(t, 'full', opts.rowsL1)
  if (est(f) <= opts.budget) return f
  const l1 = level(t, 'L1', opts.rowsL1)
  return est(l1) <= opts.budget || !opts.allowL0 ? l1 : level(t, 'L0', opts.rowsL1)
}

// L2: one node in full + its subtree; list rows paged (default 25). Unknown id → undefined.
export function expand(t: SnapTree, id: string, opts: { offset?: number; limit?: number } = {}): Shaped | undefined {
  const find = (ts: T[]): T | undefined => {
    for (const x of ts) { if (x.id === id) return x; const y = find(x.rows) ?? find(x.kids); if (y) return y }
  }
  const hit = find(t.roots)
  if (!hit) return undefined
  const out: SnapNode[] = []
  const go = (x: T, root: boolean) => {
    if (x.collapsed && !root) { out.push(line(x)); return }
    out.push(full(x, root ? { from: opts.offset ?? 0, limit: opts.limit ?? 25, cols: 'all' } : undefined, false))
    for (const r of x.rows) for (const k of r.kids) go(k, false)
    for (const k of x.kids) go(k, false)
  }
  go(hit, true)
  return { view: 'L2', page: t.page, title: t.title, nodes: out }
}
