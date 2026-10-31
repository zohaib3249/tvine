// Minimal rich text sanitizer: string-based so it gives the same output on the server (SSR) and in the tab.
// Allowlist: b strong i em u s del p br ul ol li a[href] h1-h3 blockquote code pre hr table thead tbody tr th td
// img[src alt]. Every other tag is dropped (its text kept), script/style/iframe/… are dropped WITH their contents,
// comments dropped, all attributes dropped except a safe a[href] and img[src] (http(s) or same-site path) + alt.
// Anything the tag regex doesn't match is text and gets escaped, so malformed markup can only become text.
const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'p', 'br', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'blockquote', 'code', 'pre',
  'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'])
const VOID = new Set(['br', 'hr', 'img'])
const DROP = /<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|title|xmp)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g
const at = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
const HREF = at('href'), SRC = at('src'), ALT = at('alt')
const val = (re: RegExp, attrs: string) => { const h = re.exec(attrs); return h ? decode(h[1] ?? h[2] ?? h[3] ?? '') : undefined }
const SAFE = /^(https?:|mailto:|\/(?![\/\\])|#)/i   // `//x` and `/\x` are protocol-relative in browsers
// images: same-site paths (uploaded media) only; http(s) too with { allowRemoteImages: true }. Never data:/javascript:/protocol-relative.
const IMG_LOCAL = /^\/(?![\/\\])/, IMG_REMOTE = /^(https?:|\/(?![\/\\]))/i

const decode = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d)).replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '')
  .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (s: string) => s.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A link target from app code (admin list cells, …) set as a DOM attribute (no entity decoding there): the SAFE rule
// on the URL as the browser parses it (C0 controls, space and DEL ignored). undefined → show the text, no link.
export function safeHref(url: unknown): string | undefined {
  return typeof url === 'string' && SAFE.test(url.replace(/[\u0000- \u007f]/g, '')) ? url : undefined
}

export interface SanitizeOpts { allowRemoteImages?: boolean }
export function sanitizeHtml(html: string, o: SanitizeOpts = {}): string {
  const IMG = o.allowRemoteImages ? IMG_REMOTE : IMG_LOCAL
  const src = String(html ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(DROP, '')
  let out = '', last = 0
  for (const m of src.matchAll(TAG)) {
    out += text(src.slice(last, m.index)); last = m.index! + m[0].length
    const [, close, raw, attrs] = m, tag = raw!.toLowerCase()
    if (!KEEP.has(tag)) continue
    if (close) { if (!VOID.has(tag)) out += `</${tag}>`; continue }
    if (tag === 'a') {
      const h = val(HREF, attrs!), url = h !== undefined ? safeHref(h.replace(/[\u0000- \u007f]/g, '')) : undefined
      out += url ? `<a href="${attr(url)}" rel="noopener noreferrer nofollow">` : '<a>'
    } else if (tag === 'img') {
      const s = val(SRC, attrs!)?.replace(/[\u0000- \u007f]/g, ''), alt = val(ALT, attrs!)
      if (s && IMG.test(s)) out += `<img src="${attr(s)}" alt="${attr(alt ?? '')}">`   // no src = no image
    } else out += `<${tag}>`
  }
  return out + text(src.slice(last))
}

// Visible text length of rich HTML (what a reader counts): tags removed, each entity one character. The server's
// field.richText maxLength and the editor's counter both use this, so they always agree.
export function richTextLength(html: string, o: SanitizeOpts = {}): number {
  return sanitizeHtml(html, o).replace(/<[^>]*>/g, '').replace(/&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, '_').length
}
