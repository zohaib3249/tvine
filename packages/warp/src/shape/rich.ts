// Minimal rich text sanitizer: string-based so it gives the same output on the server (SSR) and in the tab.
// Allowlist: b strong i em u p br ul ol li a[href]. Every other tag is dropped (its text kept), script/style/
// iframe/… are dropped WITH their contents, comments dropped, all attributes dropped except a safe href.
// Anything the tag regex doesn't match is text and gets escaped, so malformed markup can only become text.
const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'a'])
const DROP = /<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|title|xmp)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const SAFE = /^(https?:|mailto:|\/(?![\/\\])|#)/i   // `//x` and `/\x` are protocol-relative in browsers

const decode = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d)).replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '').replace(/&amp;/gi, '&')
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (s: string) => s.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A link target from app code (admin list cells, …) set as a DOM attribute (no entity decoding there): the SAFE rule
// on the URL as the browser parses it (C0 controls, space and DEL ignored). undefined → show the text, no link.
export function safeHref(url: unknown): string | undefined {
  return typeof url === 'string' && SAFE.test(url.replace(/[\u0000- \u007f]/g, '')) ? url : undefined
}

export function sanitizeHtml(html: string): string {
  const src = String(html ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(DROP, '')
  let out = '', last = 0
  for (const m of src.matchAll(TAG)) {
    out += text(src.slice(last, m.index)); last = m.index! + m[0].length
    const [, close, raw, attrs] = m, tag = raw!.toLowerCase()
    if (!KEEP.has(tag)) continue
    if (close) { if (tag !== 'br') out += `</${tag}>`; continue }
    if (tag === 'a') {
      const h = HREF.exec(attrs!), url = h ? safeHref(decode(h[1] ?? h[2] ?? h[3] ?? '').replace(/[\u0000- \u007f]/g, '')) : undefined
      out += url ? `<a href="${attr(url)}" rel="noopener noreferrer nofollow">` : '<a>'
    } else out += `<${tag}>`
  }
  return out + text(src.slice(last))
}
