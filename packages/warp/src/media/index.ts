import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { defineAction, DomainError } from '../core/actions.js'
import type { ActionDef, ActionRules, Settings, UploadedFile } from '../core/types.js'

export interface Storage {
  put(key: string, data: Readable | Buffer, meta: { type: string; size: number; public?: boolean }): Promise<void>
  url(key: string): string
  delete(key: string): Promise<void>
}

// `<id>.<ext>`, optionally under uploadTo folders (`docs/2024/<id>.<ext>`). No dots in folder names: no `..`.
const KEY_RE = /^(?:[A-Za-z0-9_-]+\/){0,8}[A-Za-z0-9_-]+\.[a-z0-9]+$/
const UPLOAD_TO = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,7}$/
const BASE64_MAX = 256 * 1024

// Magic-byte table (v1 types). Hand-rolled instead of `file-type`: 5 signatures, no dependency.
const SIGS: { type: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { type: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
]
const sniff = (b: Buffer) => SIGS.find((s) => s.test(b))

// Disk adapter. Writes `.tmp-*` in the same dir then renames (no partial files visible).
// Sidecar `<key>.json` holds {type,size}; the handler serves Content-Type from it.
export class DiskStorage implements Storage {
  constructor(readonly dir: string, readonly routePrefix = '/media') {}

  async put(key: string, data: Readable | Buffer, meta: { type: string; size: number; public?: boolean }): Promise<void> {
    if (!KEY_RE.test(key)) throw new Error(`bad storage key ${key}`)
    await mkdir(dirname(join(this.dir, key)), { recursive: true })
    const tmp = join(this.dir, `.tmp-${nanoid()}`)
    const metaTmp = `${tmp}.json`
    try {
      let size = meta.size
      if (Buffer.isBuffer(data)) await writeFile(tmp, data)
      else {
        const out = createWriteStream(tmp)
        await pipeline(data, out)
        size = out.bytesWritten
      }
      await writeFile(metaTmp, JSON.stringify({ type: meta.type, size, ...(meta.public && { public: true }) }))
      await rename(metaTmp, join(this.dir, `${key}.json`))
      await rename(tmp, join(this.dir, key))
    } catch (e) {
      await Promise.all([rm(tmp, { force: true }), rm(metaTmp, { force: true }), rm(join(this.dir, `${key}.json`), { force: true })])
      throw e
    }
  }
  url(key: string) { return `${this.routePrefix}/${key}` }
  async delete(key: string) {
    if (!KEY_RE.test(key)) return
    await Promise.all([rm(join(this.dir, key), { force: true }), rm(join(this.dir, `${key}.json`), { force: true })])
  }
}

type UploadRules = Pick<ActionRules, 'permissions' | 'rate'>
// uploadTo: key folder (Django upload_to), e.g. 'avatars' → 'avatars/<id>.png'; pass the file / image field's own uploadTo
// public: served with `Cache-Control: public` (shared caches, CDNs); default private (a user's upload)
export interface UploadOpts { maxBytes: number; types: string[]; storage?: Storage; permissions?: ActionRules['permissions']; uploadTo?: string; public?: boolean }
export type UploadDef = ActionDef & { upload: Required<Pick<UploadOpts, 'maxBytes' | 'types'>> & Pick<UploadOpts, 'storage' | 'uploadTo' | 'public'> }
type Media = Settings['media']

// The def's own storage, else disk at settings.media (known only once the server runs, so resolved per use).
export const storageOf = (def: UploadDef, media: Media = { dir: './media', route: '/media' }): Storage =>
  def.upload.storage ?? new DiskStorage(media.dir, media.route)

// Returns an ordinary ActionDef (JSON/base64 path via `file: {base64}`); transports call
// receiveUpload(stream, def, {field, media}) directly for multipart.
export function defineUpload(name: string, opts: UploadOpts & { rate?: ActionRules['rate'] }): UploadDef {
  const uploadTo = opts.uploadTo?.replace(/^\/+|\/+$/g, '')
  if (uploadTo !== undefined && !UPLOAD_TO.test(uploadTo)) throw new Error(`defineUpload ${name}: uploadTo must be folder names (letters, digits, _ -) joined by /`)
  const upload = { maxBytes: opts.maxBytes, types: opts.types, storage: opts.storage, uploadTo, ...(opts.public && { public: true }) }
  // the 5/min default yields to apps/<app>/rules.ts (defaultRules); an explicit opts.rate beats both
  const rules: UploadRules = { ...(opts.rate && { rate: opts.rate }), ...(opts.permissions && { permissions: opts.permissions }) }
  const def: ActionDef = defineAction(name, z.object({ file: z.record(z.unknown()) }), async (p, ctx): Promise<UploadedFile> =>
    // multipart: transport-http already streamed the file into storage (request.files is transport-only)
    ctx.request.files.find((f) => f.field === 'file') ?? receiveUpload(p.file as { base64: string }, def as UploadDef, { field: 'file', media: ctx.settings.media }), rules)
  return Object.assign(def, { upload, defaultRules: { rate: { limit: 5, windowMs: 60_000 } } }) as UploadDef
}

async function* guarded(head: Buffer[], rest: AsyncIterator<Buffer>, max: number, source: Readable): AsyncGenerator<Buffer> {
  let n = 0
  try {
    for (const b of head) { n += b.length; if (n > max) throw tooLarge(max); yield b }
    for (let r = await rest.next(); !r.done; r = await rest.next()) {
      const b = Buffer.from(r.value)
      n += b.length
      if (n > max) throw tooLarge(max)
      yield b
    }
  } finally { source.destroy() }
}
const tooLarge = (max: number) => new DomainError('too_large', `file exceeds ${max} bytes`, 'file')

export async function receiveUpload(
  src: Readable | { base64: string },
  def: UploadDef, meta: { field: string; media?: Media },
): Promise<UploadedFile> {
  const { maxBytes, types } = def.upload
  const storage = storageOf(def, meta.media)
  const field = meta.field
  let source: Readable
  if (src instanceof Readable) source = src
  else {
    if (!src || typeof (src as { base64?: unknown }).base64 !== 'string') {
      throw new DomainError('invalid_param', 'url ingestion disabled', field)
    }
    const b64 = src.base64
    if (b64.length > Math.ceil((BASE64_MAX * 4) / 3) + 4) throw new DomainError('too_large', 'base64 upload exceeds 256 KB', field)
    const buf = Buffer.from(b64, 'base64')
    if (buf.length > BASE64_MAX) throw new DomainError('too_large', 'base64 upload exceeds 256 KB', field)
    source = Readable.from([buf])
  }

  // Sniff before touching storage: collect ≥12 bytes (webp needs 12) or EOF.
  const head: Buffer[] = []
  let len = 0
  const it = source[Symbol.asyncIterator]()
  try {
    while (len < 12) {
      const r = await it.next()
      if (r.done) break
      head.push(Buffer.from(r.value))
      len += head[head.length - 1]!.length
    }
  } catch (e) { source.destroy(); throw e }
  const found = sniff(Buffer.concat(head))
  if (!found || !types.includes(found.type)) {
    source.destroy()
    throw new DomainError('unsupported_type', `file type not allowed (allowed: ${types.join(', ')})`, field)
  }
  const key = `${def.upload.uploadTo ? `${def.upload.uploadTo}/` : ''}${nanoid()}.${found.ext}`
  let size = 0
  const counted = Readable.from((async function* () {
    for await (const b of guarded(head, it as AsyncIterator<Buffer>, maxBytes, source)) { size += b.length; yield b }
  })())
  try { await storage.put(key, counted, { type: found.type, size: 0, ...(def.upload.public && { public: true }) }) } catch (e) { counted.destroy(); source.destroy(); throw e }
  return { field, key, url: storage.url(key), type: found.type, size }
}

// connect-style GET handler for `${routePrefix}/<key>`; paths outside the prefix fall through.
export function mediaHandler(storage: DiskStorage, routePrefix = '/media') {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const path = (req.url ?? '').split('?')[0]!
    if (path !== routePrefix && !path.startsWith(`${routePrefix}/`)) return next()
    const notFound = () => { res.statusCode = 404; res.setHeader('Cache-Control', 'no-store'); res.end() }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound()
    let key: string
    try { key = decodeURIComponent(path.slice(routePrefix.length + 1)) } catch { return notFound() }
    if (!KEY_RE.test(key) || key.endsWith('.json')) return notFound()
    try {
      const file = join(storage.dir, key)
      const [info, st] = await Promise.all([readFile(join(storage.dir, `${key}.json`), 'utf8'), stat(file)])
      if (!st.isFile()) return notFound()
      // Success headers only once the file is really open: a failed open must give a clean 404.
      const ok = () => {
        res.statusCode = 200
        const m = JSON.parse(info) as { type: string; public?: boolean }
        res.setHeader('Content-Type', m.type)
        res.setHeader('X-Content-Type-Options', 'nosniff')
        // a PDF downloads, never opens inline (security/headers.ts adds the sandbox CSP; this holds without it too)
        if (!m.type.startsWith('image/') && !res.hasHeader('Content-Disposition')) res.setHeader('Content-Disposition', 'attachment')
        res.setHeader('Cache-Control', `${m.public ? 'public' : 'private'}, max-age=31536000, immutable`)
        res.setHeader('Content-Length', String(st.size))
      }
      if (req.method === 'HEAD' || st.size === 0) { ok(); return void res.end() }
      const rs = createReadStream(file, { end: st.size - 1 })
      await new Promise<void>((resolve, reject) => { rs.once('open', () => resolve()); rs.once('error', reject) })
      ok()
      await pipeline(rs, res)
    } catch { if (!res.headersSent) notFound(); else res.destroy() }
  }
}

// ---- multipart api calls (POST /tvine/api/<id> for an action with `multipart`) ------------------------
// The api transport parses the (capped, buffered) body: a `params` JSON part plus one part per file field.
// The file parts ride on the request under PARTS; the action stores each with storePart (same sniffing,
// type list and byte cap as every upload).
export interface FilePart { field: string; filename: string; type: string; data: Buffer }
export const PARTS = Symbol.for('tvine.fileParts')
export const filePartsOf = (request: object): FilePart[] => (request as { [PARTS]?: FilePart[] })[PARTS] ?? []

export function storePart(p: FilePart, limits: { maxBytes: number; types: string[]; storage?: Storage; uploadTo?: string }, media?: Media): Promise<UploadedFile> {
  if (p.data.length > limits.maxBytes) return Promise.reject(new DomainError('too_large', `file exceeds ${limits.maxBytes} bytes`, p.field))
  return receiveUpload(Readable.from([p.data]), { upload: limits } as UploadDef, { field: p.field, media })
}

// a whole multipart body → text fields + file parts; null = malformed. Parts are capped by the caller's body cap.
export function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; files: FilePart[] } | null {
  const delim = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = Object.create(null)
  const files: FilePart[] = []
  let i = body.indexOf(delim)
  if (i < 0) return null
  for (;;) {
    i += delim.length
    if (body.subarray(i, i + 2).toString('latin1') === '--') return { fields, files }
    if (body.subarray(i, i + 2).toString('latin1') !== '\r\n') return null
    const headEnd = body.indexOf('\r\n\r\n', i)
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headEnd)
    if (headEnd < 0 || next < 0) return null
    const head = body.subarray(i + 2, headEnd).toString('utf8')
    const data = body.subarray(headEnd + 4, next)
    const disp = /^content-disposition:\s*form-data(.*)$/im.exec(head)?.[1] ?? ''
    const name = /;\s*name="([^"]{1,200})"/i.exec(disp)?.[1]
    if (name === undefined) return null
    const filename = /;\s*filename="([^"]*)"/i.exec(disp)?.[1]
    if (filename === undefined) fields[name] = data.toString('utf8')
    else files.push({ field: name, filename, type: /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1]?.trim() ?? 'application/octet-stream', data: Buffer.from(data) })
    i = next + 2
  }
}
