// The rich text document model. String-only (no DOM), so the server (SSR, agent state) and the tab share it.
// A Doc is a flat list of items: text lines (p / h1-h3 / quote / pre / ul / ol — one list ITEM per line, consecutive
// items render as one list) plus atoms (hr, img, table). Text lines and table cells are the editable "leaves",
// numbered in document order; the editor maps the DOM caret to (leaf, offset) and edits the model, never the DOM.
// Parse always runs on sanitizeHtml output, so only the allowlisted tags can appear.
import { safeHref, sanitizeHtml } from './rich.js'

export type Mark = 'b' | 'i' | 'u' | 's' | 'code'
export type Run = { t: string; b?: true; i?: true; u?: true; s?: true; code?: true; href?: string }
export type LineKind = 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'pre' | 'ul' | 'ol'
export type Item = { k: LineKind; runs: Run[] } | { k: 'hr' } | { k: 'img'; src: string; alt: string } | { k: 'table'; rows: Run[][][] }
export type Doc = Item[]
export const MARKS: Mark[] = ['b', 'i', 'u', 's', 'code']
export const isLine = (it: Item): it is Extract<Item, { runs: Run[] }> => 'runs' in it

// ---- runs ----
const same = (a: Run, b: Run) => MARKS.every((m) => !!a[m] === !!b[m]) && a.href === b.href
export function norm(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (!r.t) continue
    const last = out.at(-1)
    if (last && same(last, r)) last.t += r.t; else out.push({ ...r })
  }
  return out
}
export const textOf = (runs: Run[]) => runs.map((r) => r.t).join('')
// runs split so that `from` and `to` fall on run edges; returns [before, inside, after]
export function cut(runs: Run[], from: number, to: number): [Run[], Run[], Run[]] {
  const a: Run[] = [], m: Run[] = [], z: Run[] = []
  let pos = 0
  for (const r of runs) {
    const s = pos, e = pos + r.t.length; pos = e
    const piece = (x: number, y: number) => ({ ...r, t: r.t.slice(x - s, y - s) })
    if (s < from) a.push(piece(s, Math.min(e, from)))
    if (e > from && s < to) m.push(piece(Math.max(s, from), Math.min(e, to)))
    if (e > to) z.push(piece(Math.max(s, to), e))
  }
  return [a.filter((r) => r.t), m.filter((r) => r.t), z.filter((r) => r.t)]
}

// ---- leaves ----
export type Pos = { leaf: number; off: number }
export type LeafRef = { item: number; row?: number; col?: number }
export function leaves(doc: Doc): LeafRef[] {
  const out: LeafRef[] = []
  doc.forEach((it, i) => {
    if (isLine(it)) out.push({ item: i })
    else if (it.k === 'table') it.rows.forEach((r, ri) => r.forEach((_, ci) => out.push({ item: i, row: ri, col: ci })))
  })
  return out
}
export const leafRuns = (doc: Doc, l: LeafRef): Run[] => {
  const it = doc[l.item]!
  return isLine(it) ? it.runs : (it as Extract<Item, { k: 'table' }>).rows[l.row!]![l.col!]!
}
export function setLeafRuns(doc: Doc, l: LeafRef, runs: Run[]): void {
  const it = doc[l.item]!
  if (isLine(it)) it.runs = norm(runs); else (it as Extract<Item, { k: 'table' }>).rows[l.row!]![l.col!] = norm(runs)
}
export const clone = (d: Doc): Doc => JSON.parse(JSON.stringify(d))

// ---- HTML (sanitized) → Doc ----
const TOK = /<(\/?)([a-z0-9]+)([^<>]*)>|([^<]+)/gi
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m)
const attrOf = (attrs: string, name: string) => { const m = new RegExp(`${name}="([^"]*)"`).exec(attrs); return m ? decode(m[1]!) : undefined }
const BLOCK: Record<string, LineKind> = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', blockquote: 'quote', pre: 'pre' }
const MARK_TAG: Record<string, Mark> = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', del: 's', code: 'code' }

export function parseHtml(html: string): Doc {
  const doc: Doc = []
  const marks: Record<Mark, number> = { b: 0, i: 0, u: 0, s: 0, code: 0 }
  const hrefs: (string | undefined)[] = []
  let line: Run[] | null = null, lineKind: LineKind | null = null, list: 'ul' | 'ol' | null = null
  let table: Run[][][] | null = null, cell: Run[] | null = null
  const cur = () => cell ?? line
  const open = (k: LineKind) => { line = []; lineKind = k; doc.push({ k, runs: line }) }
  const close = () => { line = null; lineKind = null }
  const add = (t: string) => {
    let target = cur()
    if (!target) { if (!t.trim()) return; open(list ?? 'p'); target = line! }
    const h = [...hrefs].reverse().find((x) => x !== undefined)
    const r: Run = { t }
    for (const m of MARKS) if (marks[m] && !(m === 'code' && lineKind === 'pre')) r[m] = true
    if (h) r.href = h
    target.push(r)
  }
  for (const m of html.matchAll(TOK)) {
    const [, slash, rawTag, attrs = '', txt] = m
    if (txt !== undefined) { add(decode(txt).replace(lineKind === 'pre' ? /\r/g : /[\r\n\t ]+/g, lineKind === 'pre' ? '' : ' ')); continue }
    const tag = rawTag!.toLowerCase(), closing = slash === '/'
    if (MARK_TAG[tag]) { marks[MARK_TAG[tag]!] += closing ? (marks[MARK_TAG[tag]!] ? -1 : 0) : 1; continue }
    if (tag === 'a') { if (closing) hrefs.pop(); else hrefs.push(attrOf(attrs, 'href')); continue }
    if (tag === 'br') { if (cur()) add('\n'); continue }
    if (tag === 'ul' || tag === 'ol') { if (!table) { close(); list = closing ? null : tag } continue }   // ponytail: nested lists flatten to one level
    if (tag === 'li') { if (!table) { if (closing) close(); else open(list ?? 'ul') } continue }
    if (tag === 'table') { close(); if (closing) table = null; else doc.push({ k: 'table', rows: table = [] }); continue }
    if (tag === 'tr') { if (table && !closing) table.push([]); continue }
    if (tag === 'td' || tag === 'th') { if (table) { const row = table.at(-1); cell = closing || !row ? null : (row.push([]), row.at(-1)!) } continue }
    if (tag === 'thead' || tag === 'tbody') continue
    if (tag === 'hr' || tag === 'img') {
      if (table) continue
      close()
      if (tag === 'hr') doc.push({ k: 'hr' })
      else { const src = attrOf(attrs, 'src'); if (src) doc.push({ k: 'img', src, alt: attrOf(attrs, 'alt') ?? '' }) }
      continue
    }
    const bk = BLOCK[tag]
    if (bk) {
      if (cell) continue                                        // a paragraph inside a cell: same cell
      if (tag === 'p' && (lineKind === 'quote' || (list && lineKind === list))) {   // <p> inside a quote / list item: a line break
        if (!closing && line && textOf(line)) add('\n')
        continue
      }
      if (closing) close(); else { list = null; open(bk) }
    }
  }
  for (const it of doc) if (isLine(it)) { it.runs = norm(it.runs); if (it.k !== 'pre') trimEnds(it.runs) }
    else if (it.k === 'table') it.rows = it.rows.filter((r) => r.length).map((r) => r.map((c) => norm(c)))
  return doc
}
function trimEnds(runs: Run[]) {   // trailing line break the browser leaves behind
  const last = runs.at(-1)
  if (last && last.t.endsWith('\n')) { last.t = last.t.slice(0, -1); if (!last.t) runs.pop() }
}

// ---- Doc → HTML ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;')
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;')
function runsHtml(runs: Run[], pre = false): string {
  let h = ''
  for (const r of runs) {
    let x = pre ? esc(r.t) : esc(r.t).replace(/\n/g, '<br>')
    if (!pre) {
      if (r.code) x = `<code>${x}</code>`
      if (r.s) x = `<s>${x}</s>`
      if (r.u) x = `<u>${x}</u>`
      if (r.i) x = `<em>${x}</em>`
      if (r.b) x = `<strong>${x}</strong>`
      if (r.href) x = `<a href="${escAttr(r.href)}" rel="noopener noreferrer nofollow">${x}</a>`
    }
    h += x
  }
  const t = textOf(runs)
  return !t || t.endsWith('\n') ? `${h}<br>` : h   // an empty line / trailing break needs a <br> to show
}
const TAG_OF: Record<string, string> = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', pre: 'pre' }
export function renderHtml(doc: Doc): string {
  let h = '', i = 0
  while (i < doc.length) {
    const it = doc[i]!
    if (it.k === 'ul' || it.k === 'ol') {
      const k = it.k; h += `<${k}>`
      while (doc[i]?.k === k) { h += `<li>${runsHtml((doc[i] as { runs: Run[] }).runs)}</li>`; i++ }
      h += `</${k}>`; continue
    }
    if (isLine(it)) h += `<${TAG_OF[it.k]}>${runsHtml(it.runs, it.k === 'pre')}</${TAG_OF[it.k]}>`
    else if (it.k === 'hr') h += '<hr>'
    else if (it.k === 'img') h += `<img src="${escAttr(it.src)}" alt="${escAttr(it.alt)}">`
    else h += `<table><tbody>${it.rows.map((r, ri) => `<tr>${r.map((c) => ri === 0 ? `<th>${runsHtml(c)}</th>` : `<td>${runsHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    i++
  }
  return h
}
export const emptyDoc = (): Doc => [{ k: 'p', runs: [] }]
export const docText = (doc: Doc) => leaves(doc).map((l) => textOf(leafRuns(doc, l))).join('\n')
// What the field stores: '' for an empty document (so required checks work).
export const docHtml = (doc: Doc) => (docText(doc).trim() || doc.some((it) => it.k === 'img' || it.k === 'hr') ? renderHtml(doc) : '')

// ---- markdown → Doc ----
// link target: <…> (anything but <>), or one level of balanced parens: [t](https://x.io/a_(b))
const URL_MD = String.raw`<([^<>\n]+)>|((?:[^()\s]|\([^()\s]*\))+)`
const INLINE = new RegExp('`([^`]+)`|' + String.raw`\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\((?:${URL_MD})\)`)
export function mdInline(s: string, base: Omit<Run, 't'> = {}): Run[] {
  const out: Run[] = []
  let rest = s
  for (let m = INLINE.exec(rest); m; m = INLINE.exec(rest)) {
    if (m.index) out.push({ ...base, t: rest.slice(0, m.index) })
    const [, code, b1, b2, st, i1, i2, lt, la, lb] = m, lh = la ?? lb
    if (code !== undefined) out.push({ ...base, t: code, code: true })
    else if (b1 ?? b2) out.push(...mdInline(b1 ?? b2!, { ...base, b: true }))
    else if (st !== undefined) out.push(...mdInline(st, { ...base, s: true }))
    else if (i1 ?? i2) out.push(...mdInline(i1 ?? i2!, { ...base, i: true }))
    else { const href = safeHref(lh); out.push(...mdInline(lt!, href ? { ...base, href } : base)) }
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) out.push({ ...base, t: rest })
  return norm(out)
}
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInline(c.trim()))
export function parseMarkdown(md: string, allowRemoteImages = false): Doc {
  const doc: Doc = [], lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  const flush = () => { if (para.length) doc.push({ k: 'p', runs: mdInline(para.join(' ')) }); para = [] }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!, t = l.trim()
    let m: RegExpExecArray | null
    if (t.startsWith('```')) {
      flush(); const body: string[] = []
      while (++i < lines.length && !lines[i]!.trim().startsWith('```')) body.push(lines[i]!)
      doc.push({ k: 'pre', runs: norm([{ t: body.join('\n') }]) }); continue
    }
    if (!t) { flush(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); doc.push({ k: 'hr' }); continue }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) { flush(); doc.push({ k: (['h1', 'h2', 'h3'] as const)[Math.min(m[1]!.length, 3) - 1]!, runs: mdInline(m[2]!) }); continue }
    if ((m = /^>\s?(.*)$/.exec(t))) { flush(); doc.push({ k: 'quote', runs: mdInline(m[1]!) }); continue }
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) { flush(); doc.push({ k: 'ul', runs: mdInline(m[1]!) }); continue }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { flush(); doc.push({ k: 'ol', runs: mdInline(m[1]!) }); continue }
    if ((m = new RegExp(String.raw`^!\[([^\]]*)\]\((?:${URL_MD})\)$`).exec(t))) {
      flush(); const raw = m[2] ?? m[3]!
      const src = sanitizeHtml(`<img src="${raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`, { allowRemoteImages })
      if (src) doc.push({ k: 'img', src: decode(/src="([^"]*)"/.exec(src)![1]!), alt: m[1]! }); continue
    }
    if (t.startsWith('|') && /^\|?\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? '')) {
      flush(); const rows = [cells(t)]; i++
      while (lines[i + 1]?.trim().startsWith('|')) rows.push(cells(lines[++i]!))
      doc.push({ k: 'table', rows }); continue
    }
    para.push(t)
  }
  flush()
  return doc
}
export const markdownToHtml = (md: string, allowRemoteImages = false) => sanitizeHtml(renderHtml(parseMarkdown(md, allowRemoteImages)), { allowRemoteImages })
// a link / image target written back to markdown: <…> when it has spaces or parens
const mdUrl = (u: string) => (/[\s()<>]/.test(u) ? `<${u.replace(/[<>\n]/g, encodeURIComponent)}>` : u)

// ---- Doc → markdown (the compact form agents read) ----
function runsMd(runs: Run[]): string {
  return runs.map((r) => {
    if (r.code) return `\`${r.t}\``
    let x = r.t
    if (r.s) x = `~~${x}~~`
    if (r.i) x = `*${x}*`
    if (r.b) x = `**${x}**`
    if (r.href) x = `[${x}](${mdUrl(r.href)})`
    return x
  }).join('')
}
export function toMarkdown(doc: Doc): string {
  const out: string[] = []
  let n = 0
  doc.forEach((it, i) => {
    const glue = (it.k === 'ul' || it.k === 'ol' || it.k === 'quote') && doc[i - 1]?.k === it.k
    n = it.k === 'ol' ? (doc[i - 1]?.k === 'ol' ? n + 1 : 1) : 0
    const s = it.k === 'hr' ? '---' : it.k === 'img' ? `![${it.alt}](${mdUrl(it.src)})`
      : it.k === 'table' ? it.rows.map((r, ri) => `| ${r.map(runsMd).join(' | ')} |${ri === 0 ? `\n|${r.map(() => '---').join('|')}|` : ''}`).join('\n')
      : it.k === 'pre' ? `\`\`\`\n${textOf(it.runs)}\n\`\`\``
      : `${{ p: '', h1: '# ', h2: '## ', h3: '### ', quote: '> ', ul: '- ', ol: `${n}. ` }[it.k]}${runsMd(it.runs)}`
    if (glue) out[out.length - 1] += `\n${s}`; else out.push(s)
  })
  return out.join('\n\n')
}
export const htmlToMarkdown = (html: string, allowRemoteImages = false) => toMarkdown(parseHtml(sanitizeHtml(html, { allowRemoteImages })))
export const htmlText = (html: string) => docText(parseHtml(sanitizeHtml(html)))
