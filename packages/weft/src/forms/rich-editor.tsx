'use client'
// Rich text editor on contenteditable + the richdoc model. No document.execCommand: typing is native (the
// browser edits the DOM), then every input is parsed back into the model (sanitized), normalized, and
// re-rendered only when the DOM differs; toolbar commands, shortcuts and paste edit the model and re-render,
// restoring the caret by (leaf, offset). Output is always sanitized HTML ('' when empty).
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { FieldWidgetProps } from './types.js'
import { richTextLength, safeHref, sanitizeHtml as sanitize } from './rich.js'
import {
  clone, cut, docHtml, docText, emptyDoc, isLine, leafRuns, leaves, MARKS, norm, parseHtml, parseMarkdown, renderHtml, setLeafRuns, textOf,
  type Doc, type Item, type LineKind, type Mark, type Pos, type Run,
} from './richdoc.js'

// ---- model ops (pure; exported for tests) ----
type Sel = { a: Pos; b: Pos }
const order = (s: Sel): Sel => (s.a.leaf < s.b.leaf || (s.a.leaf === s.b.leaf && s.a.off <= s.b.off) ? s : { a: s.b, b: s.a })
function eachLeaf(doc: Doc, s: Sel, f: (runs: Run[], from: number, to: number, leaf: number) => Run[]) {
  const ls = leaves(doc), { a, b } = order(s)
  for (let i = a.leaf; i <= b.leaf && i < ls.length; i++) {
    const runs = leafRuns(doc, ls[i]!), len = textOf(runs).length
    setLeafRuns(doc, ls[i]!, f(runs, i === a.leaf ? a.off : 0, i === b.leaf ? b.off : len, i))
  }
}
export function toggleMark(doc: Doc, s: Sel, mark: Mark): Doc {
  const d = clone(doc)
  let all = true
  eachLeaf(d, s, (runs, f, t) => { if (cut(runs, f, t)[1].some((r) => !r[mark])) all = false; return runs })
  eachLeaf(d, s, (runs, f, t) => { const [x, m, z] = cut(runs, f, t); return [...x, ...m.map((r) => ({ ...r, [mark]: all ? undefined : true })), ...z] })
  return d
}
export function setLink(doc: Doc, s: Sel, href: string | undefined): Doc {
  const d = clone(doc)
  eachLeaf(d, s, (runs, f, t) => { const [x, m, z] = cut(runs, f, t); return [...x, ...m.map((r) => ({ ...r, href })), ...z] })
  return d
}
export function clearFormat(doc: Doc, s: Sel): Doc {
  const d = setBlock(doc, s, 'p', true)
  eachLeaf(d, s, (runs, f, t) => { const [x, m, z] = cut(runs, f, t); return [...x, ...m.map((r) => ({ t: r.t })), ...z] })
  return d
}
const lineItems = (doc: Doc, s: Sel) => { const ls = leaves(doc), { a, b } = order(s); return [...new Set(ls.slice(a.leaf, b.leaf + 1).filter((l) => l.row === undefined).map((l) => l.item))] }
export function setBlock(doc: Doc, s: Sel, k: LineKind, force = false): Doc {
  const d = clone(doc), items = lineItems(d, s)
  const off = !force && items.every((i) => d[i]!.k === k)
  for (const i of items) (d[i] as { k: LineKind }).k = off ? 'p' : k
  return d
}
// after the item holding the caret (or at the end)
function insertAfter(doc: Doc, s: Sel, items: Item[]): { doc: Doc; at: number } {
  const d = clone(doc), l = leaves(d)[order(s).b.leaf], at = l ? l.item + 1 : d.length
  d.splice(at, 0, ...items)
  if (!d[at + items.length]) d.push({ k: 'p', runs: [] })   // somewhere to keep typing
  return { doc: d, at }
}
export function tableEdit(doc: Doc, s: Sel, what: 'row' | 'col'): Doc {
  const d = clone(doc), l = leaves(d)[order(s).b.leaf]
  let ti = l?.row !== undefined ? l.item : -1
  if (ti < 0) d.forEach((x, i) => { if (x.k === 'table') ti = i })
  const t = d[ti] as Extract<Item, { k: 'table' }> | undefined
  if (!t || t.k !== 'table') return d
  if (what === 'row') t.rows.splice((l?.row ?? t.rows.length - 1) + 1, 0, t.rows[0]!.map(() => []))
  else { const c = (l?.col ?? t.rows[0]!.length - 1) + 1; for (const r of t.rows) r.splice(c, 0, []) }
  return d
}
function deleteSel(doc: Doc, s: Sel): Doc {
  const { a, b } = order(s), d = clone(doc), ls = leaves(d)
  if (a.leaf === b.leaf) { const r = leafRuns(d, ls[a.leaf]!); const [x, , z] = cut(r, a.off, b.off); setLeafRuns(d, ls[a.leaf]!, [...x, ...z]); return d }
  const la = ls[a.leaf]!, lb = ls[b.leaf]!
  if (la.row !== undefined || lb.row !== undefined) return d   // ponytail: a selection spanning a table cell is not deleted
  const head = cut(leafRuns(d, la), a.off, Infinity)[0], tail = cut(leafRuns(d, lb), 0, b.off)[2]
  setLeafRuns(d, la, [...head, ...tail])
  d.splice(la.item + 1, lb.item - la.item)
  return d
}
// Paste / insert a parsed doc at the caret: one line → inline; more → split the line around the inserted items.
export function insertDoc(doc: Doc, s: Sel, ins: Doc): { doc: Doc; caret: Pos } {
  let d = deleteSel(doc, s)
  const at = order(s).a, ls = leaves(d), l = ls[at.leaf]
  if (!l) return { doc: [...d, ...ins], caret: at }
  const runs = leafRuns(d, l), [x, , z] = cut(runs, at.off, at.off)
  if (ins.length === 1 && isLine(ins[0]!)) {
    const add = ins[0].runs
    setLeafRuns(d, l, [...x, ...add, ...z])
    return { doc: d, caret: { leaf: at.leaf, off: at.off + textOf(add).length } }
  }
  if (l.row !== undefined) { setLeafRuns(d, l, [...x, { t: docText(ins) }, ...z]); return { doc: d, caret: at } }
  d = clone(d)
  const line = d[l.item] as { k: LineKind; runs: Run[] }
  line.runs = norm(x)
  const rest: Item = { k: line.k, runs: norm(z) }
  d.splice(l.item + 1, 0, ...clone(ins), rest)
  const caretLeaf = leaves(d).findIndex((q) => q.item === l.item + 1 + ins.length)
  return { doc: d, caret: { leaf: Math.max(0, caretLeaf), off: 0 } }
}

// Markdown shortcuts on the line being typed: `# ` `## ` `### ` `- ` `* ` `1. ` `> ` ```` ``` ```` `---`, and
// **b** *i* _i_ ~~s~~ `code` closed right before the caret.
const BLOCK_MD: [RegExp, LineKind | 'hr'][] = [[/^###\s/, 'h3'], [/^##\s/, 'h2'], [/^#\s/, 'h1'], [/^[-*+]\s/, 'ul'], [/^1[.)]\s/, 'ol'], [/^>\s/, 'quote'], [/^```$/, 'pre'], [/^---$/, 'hr']]
const INLINE_MD: [RegExp, Mark, number][] = [[/\*\*([^*]+)\*\*$/, 'b', 2], [/~~([^~]+)~~$/, 's', 2], [/`([^`]+)`$/, 'code', 1], [/(?:^|[^*])\*([^*\s][^*]*)\*$/, 'i', 1], [/(?:^|\W)_([^_\s][^_]*)_$/, 'i', 1]]
export function mdShortcut(doc: Doc, caret: Pos): { doc: Doc; caret: Pos } | undefined {
  const ls = leaves(doc), l = ls[caret.leaf]
  if (!l) return
  const it = doc[l.item]!, runs = leafRuns(doc, l), text = textOf(runs), before = text.slice(0, caret.off)
  if (l.row === undefined && isLine(it) && it.k === 'p') {
    for (const [re, k] of BLOCK_MD) {
      const m = re.exec(before)
      if (!m || (k !== 'hr' && k !== 'pre' && caret.off !== m[0].length) || ((k === 'hr' || k === 'pre') && text !== m[0])) continue
      const d = clone(doc)
      if (k === 'hr') { d.splice(l.item, 1, { k: 'hr' }, { k: 'p', runs: [] }); return { doc: d, caret: { leaf: caret.leaf, off: 0 } } }
      const line = d[l.item] as { k: LineKind; runs: Run[] }
      line.k = k; line.runs = norm(cut(runs, 0, m[0].length)[2])
      return { doc: d, caret: { leaf: caret.leaf, off: caret.off - m[0].length } }
    }
  }
  if (isLine(it) && it.k === 'pre') return
  for (const [re, mark, dl] of INLINE_MD) {
    const m = re.exec(before)
    if (!m) continue
    const inner = m[1]!, end = caret.off, s0 = end - inner.length - 2 * dl
    if (s0 < 0) continue
    const [x, mid, z] = cut(runs, s0, end)
    const body = cut(mid, dl, dl + inner.length)[1].map((r) => ({ ...r, [mark]: true }))
    const d = clone(doc); setLeafRuns(d, leaves(d)[caret.leaf]!, [...x, ...body, ...z])
    return { doc: d, caret: { leaf: caret.leaf, off: end - 2 * dl } }
  }
}

// ---- DOM ↔ (leaf, offset) ----
const LEAF_SEL = 'p,h1,h2,h3,blockquote,pre,li,th,td'
const leafEls = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(LEAF_SEL)]
function fragLen(n: Node): number {
  if (n.nodeType === 3) return (n as Text).data.length
  if ((n as Element).nodeName === 'BR') return 1
  let x = 0; n.childNodes.forEach((c) => { x += fragLen(c) }); return x
}
function posOf(root: HTMLElement, node: Node, offset: number): Pos | undefined {
  const els = leafEls(root)
  const leaf = els.findIndex((e) => e === node || e.contains(node))
  if (leaf < 0) return
  const r = document.createRange(); r.setStart(els[leaf]!, 0); r.setEnd(node, offset)
  return { leaf, off: fragLen(r.cloneContents()) }
}
function readSel(root: HTMLElement): Sel | undefined {
  const s = root.ownerDocument.getSelection()
  if (!s || !s.rangeCount || !root.contains(s.anchorNode)) return
  const a = posOf(root, s.anchorNode!, s.anchorOffset), b = posOf(root, s.focusNode!, s.focusOffset)
  return a && b ? { a, b } : undefined
}
function place(root: HTMLElement, p: Pos): [Node, number] {
  const el = leafEls(root)[p.leaf] ?? leafEls(root).at(-1)
  if (!el) return [root, root.childNodes.length]
  let left = p.off
  const walk = (n: Node): [Node, number] | undefined => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) { const len = (c as Text).data.length; if (left <= len) return [c, left]; left -= len }
      else if (c.nodeName === 'BR') { if (left === 0) return [n, [...n.childNodes].indexOf(c as ChildNode)]; left -= 1 }
      else { const r = walk(c); if (r) return r }
    }
  }
  return walk(el) ?? [el, el.childNodes.length]
}
function writeSel(root: HTMLElement, s: Sel) {
  const sel = root.ownerDocument.getSelection()
  if (!sel) return
  try {
    const [an, ao] = place(root, s.a), [bn, bo] = place(root, s.b)
    sel.setBaseAndExtent(an, ao, bn, bo)
  } catch { /* the leaf vanished: leave the caret where the browser put it */ }
}

const urlOk = (u: string) => !!safeHref(u) && /^(https?:|mailto:|\/)/i.test(u)
export const looksHtml = (s: string) => /<\/?[a-z][a-z0-9]*[\s>/]/i.test(s)

type Tool = { label: string; title: string; run: () => void; pressed?: boolean }
export function RichEditor(p: FieldWidgetProps & { uploadImage?: (f: File) => Promise<string> }) {
  const ed = useRef<HTMLDivElement>(null), fileIn = useRef<HTMLInputElement>(null)
  const so = { allowRemoteImages: p.meta.allowRemoteImages }, sanitizeHtml = (h: string) => sanitize(h, so)
  const clean = sanitizeHtml(p.value ?? '')
  const [first] = useState(() => renderHtml(clean ? parseHtml(clean) : emptyDoc()))
  const hist = useRef<{ stack: { html: string; sel?: Sel }[]; i: number; t: number }>({ stack: [], i: -1, t: 0 })
  const lastOut = useRef(clean), composing = useRef(false), lastSel = useRef<Sel | undefined>(undefined)
  const [msg, setMsg] = useState<string>()
  const [count, setCount] = useState(() => docText(clean ? parseHtml(clean) : emptyDoc()))

  // the value changed from outside (agent set / reset): re-render the model
  useLayoutEffect(() => {
    if (!ed.current || clean === lastOut.current) return
    lastOut.current = clean
    const doc = clean ? parseHtml(clean) : emptyDoc()
    ed.current.innerHTML = renderHtml(doc); setCount(docText(doc))
  }, [clean])
  useEffect(() => { if (!hist.current.stack.length) hist.current = { stack: [{ html: first }], i: 0, t: 0 } }, [first])

  const docNow = (): Doc => {
    const raw = ed.current!.innerHTML.replace(/<div\b[^>]*>/gi, '<p>').replace(/<\/div>/gi, '</p>')
    const d = parseHtml(sanitizeHtml(raw))
    return d.length ? d : emptyDoc()
  }
  const commit = (doc: Doc, sel?: Sel, merge = false) => {
    const el = ed.current!
    if (!doc.length || !isLine(doc.at(-1)!)) doc = [...doc, { k: 'p', runs: [] }]   // never end on an atom: keep a place to type
    const html = renderHtml(doc)
    if (el.innerHTML !== html) { el.innerHTML = html; if (sel && el.ownerDocument.activeElement === el) writeSel(el, sel) }
    const h = hist.current, now = Date.now()
    if (h.stack[h.i]?.html !== html) {
      if (merge && now - h.t < 600 && h.i > 0) h.stack[h.i] = { html, sel }
      else { h.stack.splice(h.i + 1); h.stack.push({ html, sel }); if (h.stack.length > 200) h.stack.shift(); h.i = h.stack.length - 1 }
      h.t = now
    }
    const out = docHtml(doc)
    setCount(docText(doc))
    if (out !== lastOut.current) { lastOut.current = out; p.onChange(out) }
  }
  const onInput = () => {
    if (composing.current || !ed.current) return
    let doc = docNow(), sel = readSel(ed.current)
    if (sel && sel.a.leaf === sel.b.leaf && sel.a.off === sel.b.off) {
      const r = mdShortcut(doc, sel.a)
      if (r) { doc = r.doc; sel = { a: r.caret, b: r.caret } }
    }
    commit(doc, sel, true)
  }
  const sel = (): Sel => (ed.current && readSel(ed.current)) ?? lastSel.current ?? { a: { leaf: 0, off: 0 }, b: { leaf: 0, off: 0 } }
  const apply = (f: (d: Doc, s: Sel) => Doc | { doc: Doc; caret: Pos }) => {
    if (!ed.current || p.readOnly) return
    const s = sel(), r = f(docNow(), s)
    const [doc, ns] = 'caret' in r ? [r.doc, { a: r.caret, b: r.caret }] : [r, s]
    ed.current.focus()
    commit(doc, ns)
    setMsg(undefined)
  }
  const travel = (dir: -1 | 1) => {
    const h = hist.current, n = h.stack[h.i + dir]
    if (!n || !ed.current) return
    h.i += dir; ed.current.innerHTML = n.html
    if (n.sel) writeSel(ed.current, n.sel)
    const doc = parseHtml(n.html), out = docHtml(doc)
    setCount(docText(doc)); if (out !== lastOut.current) { lastOut.current = out; p.onChange(out) }
  }
  const link = () => {
    const u = globalThis.prompt?.('Link URL (https://…, mailto:, /path). Empty removes the link.')
    if (u == null) return
    if (u && !urlOk(u.trim())) { setMsg('Enter a valid URL (https://…, mailto: or /path).'); return }
    apply((d, s) => setLink(d, s, u.trim() || undefined))
  }
  const image = async (f?: File) => {
    let src: string | undefined
    if (f && p.uploadImage) { try { src = await p.uploadImage(f) } catch (e) { setMsg(`Upload failed: ${(e as Error).message}`); return } }
    else src = globalThis.prompt?.('Image URL (https://… or /path)')?.trim()
    if (!src) return
    if (!sanitizeHtml(`<img src="${src.replace(/"/g, '&quot;')}">`)) { setMsg(p.meta.allowRemoteImages ? 'Enter a valid image URL (https://… or /path).' : 'Enter an uploaded image path (/media/…).'); return }
    apply((d, s) => insertAfter(d, s, [{ k: 'img', src: src!, alt: f?.name ?? '' }]).doc)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase()
    if (!mod) return
    const mk = ({ b: 'b', i: 'i', u: 'u' } as Record<string, Mark>)[k]
    if (mk) { e.preventDefault(); apply((d, s) => toggleMark(d, s, mk)) }
    else if (k === 'z' || k === 'y') { e.preventDefault(); travel(k === 'y' || e.shiftKey ? 1 : -1) }
    else if (k === 'k') { e.preventDefault(); link() }
  }
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const html = e.clipboardData.getData('text/html'), text = e.clipboardData.getData('text/plain')
    const ins = html ? parseHtml(sanitizeHtml(html)) : text.split(/\r?\n/).map((l): Item => ({ k: 'p', runs: l ? [{ t: l }] : [] }))
    if (ins.length) apply((d, s) => insertDoc(d, s, ins))
  }
  const block = (k: LineKind) => () => apply((d, s) => setBlock(d, s, k))
  const tools: (Tool | '|')[] = [
    { label: 'P', title: 'Paragraph', run: () => apply((d, s) => setBlock(d, s, 'p', true)) },
    { label: 'H1', title: 'Heading 1', run: block('h1') }, { label: 'H2', title: 'Heading 2', run: block('h2') }, { label: 'H3', title: 'Heading 3', run: block('h3') }, '|',
    ...(['b', 'i', 'u', 's', 'code'] as Mark[]).map((m): Tool => ({ label: { b: 'B', i: 'I', u: 'U', s: 'S', code: '</>' }[m], title: { b: 'Bold (Ctrl+B)', i: 'Italic (Ctrl+I)', u: 'Underline (Ctrl+U)', s: 'Strikethrough', code: 'Inline code' }[m], run: () => apply((d, s) => toggleMark(d, s, m)) })),
    { label: '🔗', title: 'Link (Ctrl+K)', run: link }, '|',
    { label: '•', title: 'Bulleted list', run: block('ul') }, { label: '1.', title: 'Numbered list', run: block('ol') },
    { label: '❝', title: 'Quote', run: block('quote') }, { label: '{ }', title: 'Code block', run: block('pre') },
    { label: '―', title: 'Horizontal rule', run: () => apply((d, s) => insertAfter(d, s, [{ k: 'hr' }]).doc) },
    { label: '🖼', title: 'Image', run: () => (p.uploadImage ? fileIn.current?.click() : void image()) },
    { label: '⊞', title: 'Insert table', run: () => apply((d, s) => insertAfter(d, s, [{ k: 'table', rows: [[[], []], [[], []]] }]).doc) },
    { label: '+row', title: 'Add table row', run: () => apply((d, s) => tableEdit(d, s, 'row')) },
    { label: '+col', title: 'Add table column', run: () => apply((d, s) => tableEdit(d, s, 'col')) }, '|',
    { label: '↶', title: 'Undo (Ctrl+Z)', run: () => travel(-1) }, { label: '↷', title: 'Redo (Ctrl+Shift+Z)', run: () => travel(1) },
    { label: '⌫', title: 'Clear formatting', run: () => apply((d, s) => clearFormat(d, s)) },
  ]
  const max = p.meta.maxLength, chars = richTextLength(p.value ?? '', so), words = count.trim() ? count.trim().split(/\s+/).length : 0
  return <div className="tf-rich" data-part="rich">
    {!p.readOnly && <div className="tf-toolbar" role="toolbar" aria-label={`${p.meta.label} formatting`}>
      {tools.map((t, i) => t === '|' ? <span key={i} className="tf-tool-sep" aria-hidden="true" />
        : <button key={t.title} type="button" className="tf-btn tf-btn-ghost tf-tool" aria-label={t.title} title={t.title}
            onMouseDown={(e) => { e.preventDefault(); if (ed.current) lastSel.current = readSel(ed.current) }} onClick={t.run}>{t.label}</button>)}
      <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void image(f) }} />
    </div>}
    <div ref={ed} className="tf-input tf-editor" id={p.id} role="textbox" aria-multiline="true" aria-describedby={p.describedBy} aria-invalid={p.invalid || undefined}
      aria-readonly={p.readOnly || undefined} contentEditable={!p.readOnly} suppressContentEditableWarning spellCheck
      onInput={onInput} onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => { if (ed.current) lastSel.current = readSel(ed.current) ?? lastSel.current }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; onInput() }}
      dangerouslySetInnerHTML={{ __html: first }} />
    <div className="tf-rich-foot" data-part="count" aria-live="polite">
      {msg && <span className="tf-hint-error">{msg} </span>}
      <span data-over={max != null && chars > max ? '' : undefined}>{chars}{max != null ? ` / ${max}` : ''} characters · {words} words</span>
    </div>
    <input type="hidden" name={p.name} value={clean} />
  </div>
}
// For agent controls: markdown or HTML in, sanitized HTML out.
export const richFrom = (v: string, format?: 'html' | 'markdown', allowRemoteImages = false) =>
  docHtml((format ?? (looksHtml(v) ? 'html' : 'markdown')) === 'html' ? parseHtml(sanitize(v, { allowRemoteImages })) : parseMarkdown(v, allowRemoteImages))
export { MARKS }
