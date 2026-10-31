// view=md: the rendered page as compact Markdown for agents — content AND control ids in one read.
// Browser-safe (Weft runs it on the live tab's HTML). Two steps:
//   htmlToMd(html, widgets) — at render: content + a marker after every element that is a widget
//     (data-tvine-id, or the element right after its `text/tvine` fragment). Hidden things are dropped,
//     password / one-time-code / sensitive values masked.
//   mdView(md, widgets, …) — per reader: markers → `{id controls}` for the widgets THIS reader may see
//     (unknown/filtered ids vanish), humanOnly → `{id locked: reason}`, then the token budget.
import { controlsOf, type ShapeSource, type WidgetFrag } from './disclose.js'
import { actionLine } from './notation.js'

type El = { t: string; a: Record<string, string>; c: N[] }
type N = El | string

const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '))
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript'])
const SKIP = new Set(['script', 'style', 'svg', 'math', 'template', 'noscript', 'head', 'iframe', 'canvas', 'object', 'audio', 'video', 'select-content'])
const INLINE = new Set('a abbr b bdi bdo button cite code data del dfn em i img ins kbd mark q s samp small span strong sub sup time u var wbr br output'.split(' '))
const FIELD = new Set(['input', 'select', 'textarea'])
const SIBLINGS: Record<string, string[]> = { li: ['li'], option: ['option'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], p: ['p'] }
const OPEN = '\u0001', CLOSE = '\u0002'
export const MAX_ROWS = 25
const MAX_MD = 400_000   // chars kept in the snapshot (the budget cuts the reply much earlier)

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', times: '×' }
const cp = (n: number) => { try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '' } catch { return '' } }
// control chars (incl. our marker bytes) never survive from page text: a page can't forge a control id
const decode = (s: string) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) =>
  e[0] === '#' ? cp(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
const lowerAscii = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/y
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

// Tolerant HTML → tree (SSR output is well-formed; this only needs to survive the odd stray tag).
function parse(html: string): El {
  const root: El = { t: '#root', a: {}, c: [] }
  const stack: El[] = [root]
  const low = lowerAscii(html)
  let i = 0
  while (i < html.length) {
    const top = stack[stack.length - 1]!
    const lt = html.indexOf('<', i)
    if (lt < 0) { top.c.push(html.slice(i)); break }
    if (lt > i) top.c.push(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue }
    if (html[lt + 1] === '/') {
      const e = html.indexOf('>', lt)
      const name = low.slice(lt + 2, e < 0 ? html.length : e).trim()
      const k = stack.map(s => s.t).lastIndexOf(name)
      if (k > 0) stack.length = k
      i = e < 0 ? html.length : e + 1
      continue
    }
    TAG.lastIndex = lt
    const m = TAG.exec(html)
    if (!m) { top.c.push('<'); i = lt + 1; continue }
    i = TAG.lastIndex
    const t = lowerAscii(m[1]!), a: Record<string, string> = {}
    for (const x of m[2]!.matchAll(ATTR)) a[lowerAscii(x[1]!)] = decode(x[2] ?? x[3] ?? x[4] ?? '')
    const sib = SIBLINGS[t]
    if (sib && sib.includes(stack[stack.length - 1]!.t)) stack.pop()
    const el: El = { t, a, c: [] }
    stack[stack.length - 1]!.c.push(el)
    if (RAW.has(t)) {
      const end = low.indexOf(`</${t}`, i)
      el.c.push(html.slice(i, end < 0 ? html.length : end))
      i = end < 0 ? html.length : (html.indexOf('>', end) + 1 || html.length)
    } else if (!VOID.has(t) && !m[3]) stack.push(el)
  }
  return root
}

const isTvine = (e: El) => e.t === 'script' && /^text\/tvine$/i.test(e.a.type ?? '')
const hidden = (e: El) => SKIP.has(e.t) || 'hidden' in e.a || 'inert' in e.a || e.a['aria-hidden'] === 'true' ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(e.a.style ?? '') ||
  (e.t === 'input' && lowerAscii(e.a.type ?? '') === 'hidden') || (e.t === 'dialog' && !('open' in e.a))

// A widget fragment names the element right after it (auto links, any element without data-tvine-id).
function pair(e: El, labels: Map<string, string>, ctlIds: Set<string>) {
  let pend: string | undefined
  for (const c of e.c) {
    if (typeof c === 'string') { if (c.trim()) pend = undefined; continue }
    if (isTvine(c)) {
      try { const f = JSON.parse(c.c[0] as string ?? ''); pend = f?.k === 'w' && typeof f.w?.id === 'string' ? f.w.id : undefined } catch { pend = undefined }
      continue
    }
    if (pend !== undefined && c.a['data-tvine-id'] === undefined) c.a['data-tvine-id'] = pend
    pend = undefined
    if (FIELD.has(c.t) && c.a.id) ctlIds.add(c.a.id)
    if (c.t === 'label' && c.a.for) labels.set(c.a.for, '')
    pair(c, labels, ctlIds)
  }
}

interface Cx { w: Map<string, WidgetFrag>; labels: Map<string, string>; owner?: string; secret?: boolean }
const sq = (s: string) => s.replace(/\s+/g, ' ')
const mark = (id: string) => OPEN + id + CLOSE
const esc = (s: string) => s.replace(/([[\]])/g, '\\$1')
const has = (e: El, f: (x: El) => boolean): boolean => e.c.some(c => typeof c !== 'string' && !hidden(c) && (f(c) || has(c, f)))

// Inline run: element boundaries carry no whitespace in SSR HTML (CSS lays them out), so a space goes between
// an element's text and a neighbour that would otherwise glue word to word or link to link.
function run(cs: N[], f: (c: El) => string): string {
  let acc = '', prevEl = false
  for (const c of cs) {
    const isEl = typeof c !== 'string'
    const s = isEl ? f(c) : decode(c)
    if (!s) continue
    if ((isEl || prevEl) && /[^\s(]$/.test(acc) && /^[\w[!`*]/.test(s)) acc += ' '
    acc += s
    prevEl = isEl
  }
  return acc
}

function rawText(e: El): string { return e.c.map(c => (typeof c === 'string' ? decode(c) : hidden(c) ? '' : rawText(c))).join('') }

function enter(e: El, cx: Cx): Cx {
  const id = e.a['data-tvine-id'], w = id === undefined ? undefined : cx.w.get(id)
  return id === undefined ? cx : { ...cx, owner: id, secret: cx.secret || !!w?.sensitive }
}

function inline(e: El, cx: Cx): string {
  if (hidden(e) || isTvine(e)) return ''
  const id = e.a['data-tvine-id']
  const kx = enter(e, cx)
  const kids = () => sq(run(e.c, c => inline(c, kx)))
  let s: string
  switch (e.t) {
    case 'br': return ' '
    case 'img': { const alt = sq(e.a.alt ?? '').trim(); s = alt ? `![${esc(alt)}]` : ''; break }
    case 'a': {
      const t = sq(kids()).trim() || e.a['aria-label'] || e.a.title || ''
      const href = e.a.href
      s = href && !/^\s*(javascript|data|vbscript):/i.test(href) ? `[${t}](${href.replace(/[\s()]/g, encodeURIComponent)})` : t
      break
    }
    case 'button': s = `[${sq(kids()).trim() || e.a['aria-label'] || e.a.title || e.a.value || 'button'}]`; break
    case 'code': case 'kbd': case 'samp': { const t = sq(kids()).trim(); s = t ? '`' + t.replace(/`/g, "'") + '`' : ''; break }
    case 'strong': case 'b': { const t = kids(); s = t.trim() ? `**${t.trim()}**` : t; break }
    case 'em': { const t = kids(); s = t.trim() ? `*${t.trim()}*` : t; break }
    case 'input': case 'select': case 'textarea': return ' ' + field(e, kx) + ' '
    default: s = INLINE.has(e.t) ? kids() : ` ${kids()} `
  }
  return id !== undefined ? s + mark(id) : s
}

function field(e: El, cx: Cx, label?: string): string {
  const type = lowerAscii(e.t === 'input' ? e.a.type ?? 'text' : e.t)
  const id = e.a['data-tvine-id']
  const m = id === undefined ? '' : ' ' + mark(id)
  if (['submit', 'button', 'reset', 'image'].includes(type)) return `[${e.a.value || e.a.alt || e.a['aria-label'] || type}]` + (id === undefined ? '' : mark(id))
  const name = sq(label || (e.a.id && cx.labels.get(e.a.id)) || e.a['aria-label'] || e.a.placeholder || e.a.name || type).trim()
  if (type === 'checkbox' || type === 'radio') return `- [${'checked' in e.a ? 'x' : ' '}] ${name}${m}`
  let value: string, opts = ''
  if (e.t === 'select') {
    const os: El[] = []
    const walk = (x: El) => { for (const c of x.c) if (typeof c !== 'string') { if (c.t === 'option') os.push(c); else walk(c) } }
    walk(e)
    const sel = os.filter(o => 'selected' in o.a)
    const txt = (o: El) => sq(rawText(o)).trim() || o.a.value || ''
    value = (sel.length ? sel : os.slice(0, 1)).map(txt).join(', ')
    if (os.length) opts = ` (${os.slice(0, 10).map(txt).join('|')}${os.length > 10 ? `|… ${os.length - 10} more` : ''})`
  } else value = e.t === 'textarea' ? rawText(e).trim() : e.a.value ?? ''
  const secret = cx.secret || type === 'password' || /one-time-code|password/i.test(e.a.autocomplete ?? '')
  const v = secret ? (value ? '"•••"' : '""') : JSON.stringify(value.length > 300 ? value.slice(0, 299) + '…' : value)
  return `- ${name}: ${v}${'required' in e.a ? ' (required)' : ''}${secret ? '' : opts}${m}`
}

const gap = (out: string[]) => { if (out.length && out[out.length - 1] !== '') out.push('') }

function block(e: El, cx: Cx, out: string[]) {
  let line: N[] = []
  const flush = () => { const s = sq(run(line, c => inline(c, cx))).trim(); if (s) { gap(out); out.push(s) } line = [] }
  for (const c of e.c) {
    if (typeof c === 'string' || INLINE.has(c.t)) { line.push(c); continue }
    if (hidden(c) || isTvine(c)) continue
    flush()
    blockEl(c, cx, out)
  }
  flush()
}

function blockEl(e: El, cx0: Cx, out: string[]) {
  const id = e.a['data-tvine-id'], cx = enter(e, cx0), start = out.length
  const t = e.t
  if (/^h[1-6]$/.test(t)) { const s = sq(run(e.c, c => inline(c, cx))).trim(); if (s) { gap(out); out.push('#'.repeat(Math.min(Number(t[1]), 3)) + ' ' + s) } }
  else if (t === 'ul' || t === 'ol') { gap(out); list(e, cx, out, 0) }
  else if (t === 'table') { gap(out); table(e, cx, out) }
  else if (t === 'pre') { const s = rawText(e).replace(/\s+$/, '').replace(/^\n/, ''); if (s) { gap(out); out.push('```', s.replace(/`{3,}/g, "'''"), '```') } }
  else if (t === 'blockquote') { const sub: string[] = []; block(e, cx, sub); gap(out); out.push(...sub.map(l => (l ? '> ' + l : '>'))) }
  else if (t === 'hr') { gap(out); out.push('---') }
  else if (FIELD.has(t)) { gap(out); out.push(field(e, cx)) }
  else if (t === 'label' && e.a.for !== undefined && cx.labels.has(e.a.for)) { /* printed by its control */ }
  else if (t === 'label' && has(e, x => FIELD.has(x.t))) {
    const ctl: El[] = []
    const text = (x: El): string => x.c.map(c => (typeof c === 'string' ? decode(c) : hidden(c) ? '' : FIELD.has(c.t) ? (ctl.push(c), '') : text(c))).join('')
    const label = sq(text(e)).trim()
    gap(out)
    for (const c of ctl) out.push(field(c, enter(c, cx), label))
  } else block(e, cx, out)
  if (id === undefined) return
  const k = out.findIndex((l, j) => j >= start && l !== '' && l !== '```')
  if (k >= 0) { if (!out[k]!.includes(mark(id))) out[k] += ' ' + mark(id) }
  else { gap(out); out.push(mark(id)) }
}

function list(e: El, cx: Cx, out: string[], depth: number) {
  const items = e.c.filter((c): c is El => typeof c !== 'string' && c.t === 'li' && !hidden(c))
  const cap = cx.owner !== undefined && items.length > MAX_ROWS ? MAX_ROWS : items.length
  items.slice(0, cap).forEach((li, i) => {
    const kx = enter(li, cx)
    const nested: El[] = []
    const s = sq(run(li.c, c => ((c.t === 'ul' || c.t === 'ol') && !hidden(c) ? (nested.push(c), '') : inline(c, kx)))).trim()
    const idm = li.a['data-tvine-id'] === undefined ? '' : ' ' + mark(li.a['data-tvine-id'])
    if (s || idm) out.push('  '.repeat(depth) + (e.t === 'ol' ? `${i + 1}. ` : '- ') + s + idm)
    for (const n of nested) list(n, enter(n, kx), out, depth + 1)
  })
  if (cap < items.length) out.push(`${'  '.repeat(depth)}… ${items.length - cap} more items (expand "${cx.owner}")`)
}

function table(e: El, cx: Cx, out: string[]) {
  const rows: El[] = []
  const walk = (x: El) => { for (const c of x.c) if (typeof c !== 'string' && !hidden(c)) { if (c.t === 'tr') rows.push(c); else if (c.t !== 'table') walk(c) } }
  walk(e)
  const cells = rows.map(r => r.c.filter((c): c is El => typeof c !== 'string' && (c.t === 'td' || c.t === 'th') && !hidden(c))
    .map(c => { const kx = enter(c, cx); return sq(run(c.c, x => inline(x, kx))).trim().replace(/\|/g, '\\|') }))
    .filter(r => r.length)
  if (!cells.length) return
  const n = Math.max(...cells.map(r => r.length))
  const row = (r: string[]) => '| ' + Array.from({ length: n }, (_, i) => r[i] ?? '').join(' | ') + ' |'
  const cap = cx.owner !== undefined && cells.length - 1 > MAX_ROWS ? MAX_ROWS : cells.length - 1
  out.push(row(cells[0]!), '|' + ' --- |'.repeat(n), ...cells.slice(1, cap + 1).map(row))
  if (cap < cells.length - 1) out.push(`… ${cells.length - 1 - cap} more rows (expand "${cx.owner}")`)
}

// Page HTML → Markdown with control markers. widgets: what the page's fragments declared (sensitive / humanOnly).
export function htmlToMd(html: string, widgets: Iterable<WidgetFrag> = []): string {
  const root = parse(html)
  const findBody = (x: El): El | undefined => { for (const c of x.c) if (typeof c !== 'string') { if (c.t === 'body') return c; const y = c.t === 'html' ? findBody(c) : undefined; if (y) return y } }
  const body = findBody(root) ?? root
  const labels = new Map<string, string>(), ctlIds = new Set<string>()
  pair(root, labels, ctlIds)
  // label[for] texts, only for controls that exist (else the label prints where it stands)
  const fill = (x: El) => { for (const c of x.c) if (typeof c !== 'string') { if (c.t === 'label' && c.a.for && ctlIds.has(c.a.for)) labels.set(c.a.for, sq(rawText(c)).trim()); else fill(c) } }
  fill(root)
  for (const k of [...labels.keys()]) if (!ctlIds.has(k)) labels.delete(k)
  const w = new Map<string, WidgetFrag>()
  for (const x of widgets) w.set(x.id, x)
  const out: string[] = []
  block(body, { w, labels }, out)
  // one list / form: consecutive `- ` lines stay together
  const lines = out.filter((l, i) => !(l === '' && /^\s*(- |\d+\. )/.test(out[i - 1] ?? '') && /^\s*(- |\d+\. )/.test(out[i + 1] ?? '')))
  const s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return s.length > MAX_MD ? s.slice(0, MAX_MD) + '\n… (page truncated)' : s
}

export interface MdPage { offset?: number; limit?: number /* tokens */ }
export const MD_BUDGET = 6000
// ≈ 3 bytes per token for page prose (o200k: 3.5–4.5 for English, so the cap errs short)
const BYTES_PER_TOKEN = 3
const enc = new TextEncoder()

// Markers → `{id controls}` for the widgets in `widgets` (the caller's, already filtered), then the budget.
// more(offset) words the continuation for the transport (header / tool arg).
export function mdView(md: string, widgets: WidgetFrag[] | undefined, o: MdPage & { headless: boolean; more: (offset: number) => string }): string {
  const by = new Map((widgets ?? []).map(w => [w.id, w]))
  const text = md.replace(/\u0001([^\u0001\u0002]*)\u0002/g, (_, id: string) => {
    const w = by.get(id)
    if (!w) return ''
    if (w.ho) return `{${id} locked: ${w.ho}}`
    const ctl = controlsOf(w, o.headless)
    if (!ctl.length) return w.state !== undefined || /^(field|input|select|checkbox|switch|radio|slider|textarea|date|combobox)/.test(w.kind) ? `{${id}}` : ''
    return ctl.length === 1 && /^\w+\(\)$/.test(ctl[0]!) ? `{${id}}` : `{${id} ${ctl.join('; ')}}`
  }).replace(/ +$/gm, '')
  const lines = text.split('\n')
  const from = Math.min(o.offset ?? 0, lines.length)
  const cap = (o.limit ?? MD_BUDGET) * BYTES_PER_TOKEN
  let n = 0, to = from
  for (; to < lines.length; to++) {
    n += enc.encode(lines[to]!).length + 1
    if (n > cap && to > from) break
  }
  const out = lines.slice(from, to)
  if (from > 0) out.unshift(`… (from line ${from + 1} of ${lines.length})`)
  if (to < lines.length) out.push('', `… ${lines.length - to} more lines: ${o.more(to)}`)
  return out.join('\n')
}

// A page with no HTML behind it (the admin's agent view is built from admin.* reads): its v1 nodes as Markdown.
// Runs of same-type nodes with flat data → one table (actions listed once, binds in view=full); others: a heading,
// `key: value` lines and their action lines (`! id(params) bind=…`: POST {action,params,sid,bind}).
export function nodesMd(s: Pick<ShapeSource, 'nodes' | 'links'>): string {
  const out: string[] = []
  const val = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const flat = (d: Record<string, unknown>) => Object.values(d).every(v => v === null || typeof v !== 'object')
  const cellOf = (v: unknown) => sq(val(v)).replace(/\|/g, '\\|').slice(0, 200)
  for (let i = 0; i < s.nodes.length;) {
    const n = s.nodes[i]!
    let j = i + 1
    while (j < s.nodes.length && s.nodes[j]!.type === n.type && flat(s.nodes[j]!.data)) j++
    if (j - i > 1 && flat(n.data)) {
      const run = s.nodes.slice(i, j), cols = [...new Set(run.flatMap(x => Object.keys(x.data)))]
      gap(out)
      out.push(`${n.type} ×${run.length}${run[0]!.actions.length ? ` (actions: ${run[0]!.actions.map(a => a.id).join(', ')})` : ''}`)
      out.push('| ' + cols.join(' | ') + ' |', '|' + ' --- |'.repeat(cols.length), ...run.map(x => '| ' + cols.map(c => cellOf(x.data[c])).join(' | ') + ' |'))
      i = j
      continue
    }
    gap(out)
    out.push(`### ${n.id} (${n.type})`)
    for (const [k, v] of Object.entries(n.data)) out.push(`- ${sq(k)}: ${sq(val(v)).slice(0, 500)}`)
    for (const a of n.actions) out.push(actionLine(a))
    i++
  }
  if (s.links.length) { gap(out); out.push(...s.links.map(l => `- [${esc(sq(l.label))}](${l.href.replace(/\s/g, encodeURIComponent)})`)) }
  return out.join('\n')
}
