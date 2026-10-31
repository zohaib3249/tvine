// transport/compress — the response hook (headers decided at the moment they are sent) + gzip/brotli
// (docs/design/server/security-headers.md §Compression). node:zlib only.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { constants, createBrotliCompress, createGzip, type BrotliCompress, type Gzip } from 'node:zlib'
import type { CompressionSettings } from '../core/types.js'

type Enc = 'br' | 'gzip'

// text/event-stream is NOT compressible here: SSE frames must leave the moment they are written.
const COMPRESSIBLE = /^(?:text\/(?!event-stream)[\w.+-]+|application\/(?:json|javascript|ecmascript|xml|x-ndjson|graphql|[\w.-]+\+(?:json|xml))|image\/svg\+xml)\s*(?:;|$)/i
export const compressible = (type: string | undefined) => !!type && COMPRESSIBLE.test(type)

// Accept-Encoding with q-values. br wins a tie; `*` stands for any coding not named; q=0 refuses.
export function negotiate(header: string | undefined, brotli = true): Enc | undefined {
  if (!header) return undefined
  const q = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const qp = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find(Boolean)
    const v = qp ? Number(qp[1]) : 1
    q.set(name, Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  }
  const of = (e: string) => q.get(e) ?? q.get('*') ?? 0
  const br = brotli ? of('br') : 0, gz = of('gzip')
  if (br > 0 && br >= gz) return 'br'
  return gz > 0 ? 'gzip' : undefined
}

// Vary tokens, merged case-insensitively into whatever the route set.
export function addVary(res: ServerResponse, ...tokens: string[]): void {
  const cur = res.getHeader('vary')
  const list = (Array.isArray(cur) ? cur.join(',') : String(cur ?? '')).split(',').map((s) => s.trim()).filter(Boolean)
  if (list.includes('*')) return
  const have = new Set(list.map((s) => s.toLowerCase()))
  for (const t of tokens) if (!have.has(t.toLowerCase())) { list.push(t); have.add(t.toLowerCase()) }
  res.setHeader('vary', list.join(', '))
}

// RFC 9110 §13.1.2: If-None-Match uses the weak comparison. Dropping `W/` lets a route that compares
// strong tags (transport/http.ts) still answer 304 to the weak tag a compressed response carried.
export function weakIfNoneMatch(req: IncomingMessage): void {
  const inm = req.headers['if-none-match']
  if (inm) req.headers['if-none-match'] = inm.replace(/(^|,)\s*W\//g, '$1')
}

// BREACH (security-headers.md ruling): a body may hold secrets next to reflected input; refuse the
// attacker-driven half — a cookie-bearing request is compressed only when it did not come from another site.
const breachSafe = (req: IncomingMessage) => {
  if (!req.headers.cookie) return true
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || site === 'none'
}

export interface HookOptions {
  onHeaders: () => void                    // runs once, right before the status line + headers are decided
  compression?: CompressionSettings | false
}

type Cb = (err?: Error | null) => void
const len = (c: unknown, enc?: BufferEncoding) => (c == null ? 0 : typeof c === 'string' ? Buffer.byteLength(c, enc) : (c as Uint8Array).length)
const buf = (c: unknown, enc?: BufferEncoding) => (typeof c === 'string' ? Buffer.from(c, enc) : Buffer.from(c as Uint8Array))

// Wraps res.writeHead/write/end/flushHeaders (+ 'drain' listeners while compressing) on this instance.
// Returns the unhook (only valid before anything was written: embedded mode hands the request back).
export function hookResponse(req: IncomingMessage, res: ServerResponse, o: HookOptions): () => void {
  type Fn = (this: unknown, ...a: unknown[]) => unknown
  const orig = { writeHead: res.writeHead, write: res.write, end: res.end, flushHeaders: res.flushHeaders, on: res.on, addListener: res.addListener } as unknown as Record<'writeHead' | 'write' | 'end' | 'flushHeaders' | 'on' | 'addListener', Fn>
  const c = o.compression && o.compression.enabled ? o.compression : undefined
  let state: 'open' | 'held' | 'sent' = 'open'
  let enc: Enc | undefined
  let z: Gzip | BrotliCompress | undefined
  let held: Buffer[] = [], heldLen = 0
  const r = res as ServerResponse & { flush?: () => void }

  const setFrom = (headers: OutgoingHttpHeaders | readonly unknown[]) => {
    if (!Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers)) if (v != null) res.setHeader(k, v as string | number | string[])
      return
    }
    // [[k, v], …] or the flat raw form [k, v, k, v]
    const pairs: [string, string][] = Array.isArray(headers[0])
      ? (headers as [string, string][])
      : Array.from({ length: headers.length / 2 }, (_, i) => [String(headers[2 * i]), String(headers[2 * i + 1])])
    const by = new Map<string, string[]>()
    for (const [k, v] of pairs) by.set(k.toLowerCase(), [...(by.get(k.toLowerCase()) ?? []), String(v)])
    for (const [k, v] of by) res.setHeader(k, v.length === 1 ? v[0]! : v)
  }

  const sendHead = () => {
    state = 'sent'
    orig.writeHead.call(res, res.statusCode, res.statusMessage || undefined)
  }
  // Start compressing: headers, then the zlib stream feeding the real write.
  const startZ = () => {
    const size = Number(res.getHeader('content-length'))
    res.setHeader('content-encoding', enc!)
    res.removeHeader('content-length')
    res.removeHeader('accept-ranges')
    const etag = res.getHeader('etag')
    if (typeof etag === 'string' && etag.startsWith('"')) res.setHeader('etag', `W/${etag}`)
    z = enc === 'br'
      ? createBrotliCompress({ params: {
          [constants.BROTLI_PARAM_QUALITY]: c!.brotliQuality,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          ...(Number.isFinite(size) && size > 0 && { [constants.BROTLI_PARAM_SIZE_HINT]: size }),
        } })
      : createGzip({ level: c!.gzipLevel })
    const zz = z
    zz.on('data', (chunk: Buffer) => { if (!orig.write.call(res, chunk)) zz.pause() })
    orig.on.call(res, 'drain', () => zz.resume())
    zz.on('end', () => orig.end.call(res))
    zz.on('error', (e) => res.destroy(e))
    orig.on.call(res, 'close', () => { if (!zz.writableEnded) zz.destroy() })
    sendHead()
  }
  // Leave the held state: compress (big enough, or someone asked to flush a stream) or send plain.
  const release = (compress: boolean, endChunk?: Buffer, cb?: Cb): void => {
    const body = Buffer.concat(endChunk ? [...held, endChunk] : held)
    held = []; heldLen = 0
    if (compress) {
      startZ()
      if (endChunk) { z!.end(body); if (cb) res.once('finish', () => cb()) }
      else if (body.length) z!.write(body)
      return
    }
    if (endChunk && !res.hasHeader('transfer-encoding')) res.setHeader('content-length', body.length)
    sendHead()
    if (endChunk) orig.end.call(res, body, cb)
    else if (body.length) orig.write.call(res, body)
  }

  // The headers are decided here, once: security/CORS headers first, then whether to compress.
  const decide = () => {
    o.onHeaders()
    const type = res.getHeader('content-type')
    const s = res.statusCode
    const eligible = !!c && compressible(typeof type === 'string' ? type : undefined) && !res.hasHeader('content-encoding') &&
      req.method !== 'HEAD' && s >= 200 && s !== 204 && s !== 206 && s !== 304 && !res.hasHeader('content-range') &&
      !/\bno-transform\b/i.test(String(res.getHeader('cache-control') ?? ''))
    if (eligible) addVary(res, 'Accept-Encoding')
    enc = eligible && breachSafe(req) ? negotiate(req.headers['accept-encoding'] as string | undefined, c!.brotli) : undefined
    if (!enc) return sendHead()
    const known = Number(res.getHeader('content-length'))
    if (res.hasHeader('content-length') && Number.isFinite(known)) return known >= c!.threshold ? startZ() : sendHead()
    state = 'held'   // length unknown: hold the first bytes until threshold, end, or flush
  }

  res.writeHead = function (this: ServerResponse, status: number, a?: unknown, b?: unknown) {
    if (state === 'sent') return orig.writeHead.call(res, status, a, b) as ServerResponse
    const headers = typeof a === 'string' ? b : a
    if (typeof a === 'string') res.statusMessage = a
    res.statusCode = status
    if (headers && typeof headers === 'object') setFrom(headers as OutgoingHttpHeaders)
    if (state === 'open') decide()
    return res
  } as ServerResponse['writeHead']

  const head = () => { if (state === 'open') res.writeHead(res.statusCode) }

  res.write = function (chunk: unknown, a?: unknown, b?: unknown): boolean {
    const encoding = typeof a === 'string' ? a as BufferEncoding : undefined
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    head()
    if (state === 'held') {
      held.push(buf(chunk, encoding)); heldLen += len(chunk, encoding)
      if (heldLen >= c!.threshold) release(true)
      if (cb) process.nextTick(cb)
      return true
    }
    if (z) return cb ? z.write(buf(chunk, encoding), cb) : z.write(buf(chunk, encoding))
    return orig.write.call(res, chunk, a, b) as boolean
  } as ServerResponse['write']

  res.end = function (chunk?: unknown, a?: unknown, b?: unknown): ServerResponse {
    const fnChunk = typeof chunk === 'function'
    const data = fnChunk ? undefined : chunk
    const encoding = typeof a === 'string' ? a as BufferEncoding : undefined
    const cb = (fnChunk ? chunk : typeof a === 'function' ? a : b) as Cb | undefined
    head()
    if (state === 'held') {
      const last = data == null ? Buffer.alloc(0) : buf(data, encoding)
      release(heldLen + last.length >= c!.threshold, last, cb)
      return res
    }
    if (z) {
      if (data != null) z.end(buf(data, encoding)); else z.end()
      if (cb) res.once('finish', () => cb())
      return res
    }
    return orig.end.call(res, chunk, a, b) as ServerResponse
  } as ServerResponse['end']

  res.flushHeaders = function () {
    head()
    if (state === 'held') release(true)
    orig.flushHeaders.call(res)
  }
  // Next's streaming renderer calls res.flush() after each chunk (like the `compression` package offers).
  r.flush = () => {
    head()
    if (state === 'held') release(true)
    z?.flush()
  }
  // while compressing, writers wait on the zlib stream's drain (its buffer), not the socket's
  const onDrain = (orig_: Fn) => function (this: ServerResponse, ev: string | symbol, fn: (...x: unknown[]) => void) {
    if (ev === 'drain' && z) { z.on('drain', fn); return res }
    return orig_.call(res, ev, fn)
  } as typeof res.on
  res.on = onDrain(orig.on)
  res.addListener = onDrain(orig.addListener)

  return () => {
    if (state !== 'open') return
    for (const [k, v] of Object.entries(orig)) {
      delete (res as unknown as Record<string, unknown>)[k]   // back to the prototype's method
      if ((res as unknown as Record<string, unknown>)[k] !== v) (res as unknown as Record<string, unknown>)[k] = v
    }
    delete r.flush
  }
}
