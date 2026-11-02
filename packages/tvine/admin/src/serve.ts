// Node handler Warp mounts at settings.admin.path when `tvine.admin` is installed (Django's admin.site.urls):
// the app ships no admin files. Every page under <path>/ gets the same HTML shell; the prebuilt client bundle and
// the compiled CSS are served from <path>/_static/. The shell's script carries the request's CSP nonce
// (security headers put it on req.headers['x-nonce']). No React on the server: the client renders, data via api.*.
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void
type Panel = { path: string; title: string; root: string; files: Record<string, [string, URL]>; js: string; css: string }

// one prebuilt client app under <path>/: the HTML shell for every page, its bundle + CSS under <path>/_static/
function panelHandler(o: Panel): Handler {
  const base = o.path.replace(/\/$/, '')
  const files = new Map<string, Buffer>()
  const file = (n: string) => files.get(n) ?? (files.set(n, readFileSync(o.files[n]![1])), files.get(n)!)
  return function panel(req, res, next) {
    const p = (req.url ?? '/').split('?')[0]!
    if (p !== base && !p.startsWith(base + '/')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const s = p.startsWith(base + '/_static/') ? p.slice(base.length + 9) : undefined
    if (s !== undefined) {
      if (!Object.hasOwn(o.files, s)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return }
      // ponytail: no content hash in the name, so revalidate each load (ETag via the server's weak-etag layer is not needed at this size)
      res.writeHead(200, { 'content-type': o.files[s]![0], 'cache-control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : file(s))
      return
    }
    const nonce = req.headers['x-nonce'] as string | undefined
    const n = nonce ? ` nonce="${esc(nonce)}"` : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' }).end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex, nofollow"><title>${esc(o.title)}</title>` +
      `<link rel="stylesheet" href="${esc(base)}/_static/${o.css}"></head>` +
      `<body class="tva-page"><div id="${o.root}" data-base="${esc(base)}"></div>` +
      `<script type="module"${n} src="${esc(base)}/_static/${o.js}"></script></body></html>`)
  }
}

const JS = 'text/javascript; charset=utf-8', CSS = 'text/css; charset=utf-8'
export function adminHandler(o: { path?: string; title?: string } = {}): Handler {
  return panelHandler({ path: o.path ?? '/admin', title: o.title ?? 'Administration', root: 'tva-root', js: 'admin.js', css: 'admin.css',
    files: { 'admin.js': [JS, new URL('./static/admin.js', import.meta.url)], 'admin.css': [CSS, new URL('./admin.css', import.meta.url)] } })
}

// The tvine.shield panel (docs/design/contrib/shield.md): Warp mounts it at settings.shield.panel.path (default /shield),
// before Next. Same shell as the admin; the bundle is the admin package's second entry (dist/shield/shield.{js,css}).
export function shieldHandler(o: { path?: string; title?: string } = {}): Handler {
  return panelHandler({ path: o.path ?? '/shield', title: o.title ?? 'Shield', root: 'tvs-root', js: 'shield.js', css: 'shield.css',
    files: { 'shield.js': [JS, new URL('./shield/shield.js', import.meta.url)], 'shield.css': [CSS, new URL('./shield/shield.css', import.meta.url)] } })
}
