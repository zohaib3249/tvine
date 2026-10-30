// The inspector UI: one static page + three GET endpoints, on loopback only. It reaches the target only
// through public surfaces (agent GETs, /tvine/channel?group=inspector, /tvine/manifest), so every
// target guard still applies: the page sees exactly what any agent would.
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { redact, refuseInProduction } from './attach.js'

export interface InspectorOptions { target: string; port?: number }
export interface Inspector { url: string; address: string; port: number; close(): Promise<void> }

const HOST = '127.0.0.1'   // ponytail: loopback only, no --host flag; the page proxies a dev server's agent view
const PAGE = new URL('../static/index.html', import.meta.url)

export async function startInspector(o: InspectorOptions): Promise<Inspector> {
  refuseInProduction('tvine inspect')
  const t = new URL(o.target)
  if (t.protocol !== 'http:' && t.protocol !== 'https:') throw new Error(`target must be an http(s) URL: ${o.target}`)
  const target = t.origin
  const html = await readFile(PAGE)
  let sid = ''   // the inspector's own agent session, so refreshes don't mint a session each
  const streams = new Set<AbortController>()
  let port = 0

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) =>
    void res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body)
  const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, 'application/json', JSON.stringify(v))

  async function snapshot(u: URL, res: ServerResponse) {
    const path = u.searchParams.get('path') ?? '/'
    const to = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? new URL(path, target) : undefined
    if (!to || to.origin !== target) return json(res, 400, { error: 'path must be a site path like /shop' })
    const notation = u.searchParams.get('format') === 'notation'
    const r = await fetch(to, { redirect: 'manual', headers: { accept: notation ? 'text/tvine' : 'application/tvine+json', ...(sid && { 'x-tvine-sid': sid }) } })
    const body = Buffer.from(await r.arrayBuffer())
    sid = /sid=([A-Za-z0-9_-]+)/.exec(body.subarray(0, 200).toString())?.[1] ?? sid
    send(res, r.status, r.headers.get('content-type') ?? 'text/plain', body)   // byte-for-byte what an agent gets
  }

  // Upstream SSE → one redacted row per frame. Rows are already redacted by attachInspector; this is the second net.
  async function log(req: IncomingMessage, res: ServerResponse) {
    const ac = new AbortController()
    streams.add(ac)
    req.on('close', () => ac.abort())
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write('retry: 2000\n\n')
    const note = (message: string) => res.write(`event: note\ndata: ${JSON.stringify({ message })}\n\n`)
    try {
      const up = await fetch(`${target}/tvine/channel?group=inspector`, { signal: ac.signal, headers: { accept: 'text/event-stream' } })
      if (!up.ok || !up.body) return note(`target refused the inspector stream (${up.status})`)
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '))
          buf = buf.slice(i + 2)
          if (!data) continue
          const f = JSON.parse(data.slice(6)) as { action?: string; status?: string; message?: string; result?: Record<string, unknown> }
          if (f.action === 'inspector.command' && f.result) {
            const row = { ...f.result, params: redact(f.result.params), ...(f.result.message !== undefined && { message: redact(f.result.message) }) }
            res.write(`data: ${JSON.stringify(row)}\n\n`)
          } else if (f.status === 'err') note(String(redact(f.message ?? 'error')))
        }
      }
      note('target closed the stream')
    } catch (e) {
      if (!ac.signal.aborted) note(`target unreachable: ${(e as Error).message}`)
    } finally {
      streams.delete(ac)
      res.end()
    }
  }

  const server = createServer((req, res) => {
    // DNS rebinding: a foreign page resolving its own name to 127.0.0.1 still sends its own Host.
    if (req.headers.host !== `${HOST}:${port}` && req.headers.host !== `localhost:${port}`) return json(res, 403, { error: 'forbidden host' })
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' })
    const u = new URL(req.url ?? '/', 'http://x')
    const fail = (e: unknown) => { if (!res.headersSent) json(res, 502, { error: `target: ${(e as Error).message}` }); else res.end() }
    switch (u.pathname) {
      case '/':
        res.setHeader('x-frame-options', 'DENY')
        res.setHeader('content-security-policy', `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${target}; frame-ancestors 'none'`)
        return send(res, 200, 'text/html; charset=utf-8', html)
      case '/api/config':
        return void fetch(`${target}/tvine/manifest`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
          .then((m: { routes?: { path: string }[] }) => json(res, 200, { target, mcp: `${target}/mcp`, routes: (m.routes ?? []).map((r) => r.path) }))
      case '/api/snapshot': return void snapshot(u, res).catch(fail)
      case '/api/log': return void log(req, res).catch(fail)
      default: return json(res, 404, { error: 'not found' })
    }
  })
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(o.port ?? 7357, HOST, () => { server.off('error', bad); ok() }) })
  port = (server.address() as AddressInfo).port
  return {
    url: `http://${HOST}:${port}`, address: (server.address() as AddressInfo).address, port,
    close: () => new Promise<void>((ok) => {
      for (const ac of streams) ac.abort()
      server.close(() => ok())
      server.closeAllConnections()
    }),
  }
}
