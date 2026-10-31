// Node handler Warp mounts at settings.admin.path when `tvine.admin` is installed (Django's admin.site.urls):
// the app ships no admin files. Every page under <path>/ gets the same HTML shell; the prebuilt client bundle and
// the compiled CSS are served from <path>/_static/. The shell's script carries the request's CSP nonce
// (security headers put it on req.headers['x-nonce']). No React on the server: the client renders, data via api.*.
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

const STATIC: Record<string, [string, URL]> = {
  'admin.js': ['text/javascript; charset=utf-8', new URL('./static/admin.js', import.meta.url)],
  'admin.css': ['text/css; charset=utf-8', new URL('./admin.css', import.meta.url)],
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function adminHandler(o: { path?: string; title?: string } = {}) {
  const base = (o.path ?? '/admin').replace(/\/$/, '')
  const files = new Map<string, Buffer>()
  const file = (n: string) => files.get(n) ?? (files.set(n, readFileSync(STATIC[n]![1])), files.get(n)!)
  return function admin(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const p = (req.url ?? '/').split('?')[0]!
    if (p !== base && !p.startsWith(base + '/')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const s = p.startsWith(base + '/_static/') ? p.slice(base.length + 9) : undefined
    if (s !== undefined) {
      if (!STATIC[s]) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return }
      // ponytail: no content hash in the name, so revalidate each load (ETag via the server's weak-etag layer is not needed at this size)
      res.writeHead(200, { 'content-type': STATIC[s]![0], 'cache-control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : file(s))
      return
    }
    const nonce = req.headers['x-nonce'] as string | undefined
    const n = nonce ? ` nonce="${esc(nonce)}"` : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' }).end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex, nofollow"><title>${esc(o.title ?? 'Administration')}</title>` +
      `<link rel="stylesheet" href="${esc(base)}/_static/admin.css"></head>` +
      `<body class="tva-page"><div id="tva-root" data-base="${esc(base)}"></div>` +
      `<script type="module"${n} src="${esc(base)}/_static/admin.js"></script></body></html>`)
  }
}
