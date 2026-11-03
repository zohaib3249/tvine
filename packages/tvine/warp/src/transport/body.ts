// Shared request-body helpers for transport/api and transport/http.
import type { IncomingMessage } from 'node:http'
import { bodyCap } from '../security/ratelimit.js'

// Body up to `cap` bytes; null once it is exceeded (the rest is drained, never stored).
export function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    const onData = (c: Buffer) => {
      n += c.length
      if (bodyCap(n, cap).ok) return void chunks.push(c)
      req.off('data', onData)
      req.resume()
      resolve(null)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}

/** UTF-8 string body; null if over cap. Prefer this over re-wrapping `readBody` in each transport. */
export async function readBodyUtf8(req: IncomingMessage, cap: number): Promise<string | null> {
  const buf = await readBody(req, cap)
  return buf === null ? null : buf.toString('utf8')
}

// JSON.parse accepts any depth; recursive consumers (hash, clone, zod) then blow the stack.
export function tooDeep(v: unknown, max = 64): boolean {
  const stack: [unknown, number][] = [[v, 0]]
  while (stack.length) {
    const [x, d] = stack.pop()!
    if (typeof x !== 'object' || x === null) continue
    if (d >= max) return true
    for (const y of Object.values(x)) stack.push([y, d + 1])
  }
  return false
}

const BOUNDARY = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i

/** Multipart boundary from Content-Type, or undefined. Shared by api + http uploads. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  const m = BOUNDARY.exec(contentType ?? '')
  return m ? (m[1] ?? m[2]) : undefined
}

export type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'too_large' | 'not_json' | 'not_object' | 'too_deep' }

export type JsonValueResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'not_json' | 'too_deep' }

/** Read + parse any JSON value (MCP JSON-RPC may be a batch array). */
export async function readJsonValue(req: IncomingMessage, cap: number, maxDepth = 64): Promise<JsonValueResult> {
  const raw = await readBodyUtf8(req, cap)
  if (raw === null) return { ok: false, reason: 'too_large' }
  let body: unknown
  try { body = raw.length ? JSON.parse(raw) : {} } catch { return { ok: false, reason: 'not_json' } }
  if (tooDeep(body, maxDepth)) return { ok: false, reason: 'too_deep' }
  return { ok: true, value: body }
}

/** Read + parse a JSON object body (shared untrusted-JSON gate for api/urls/shield/tab/…). */
export async function readJsonObject(req: IncomingMessage, cap: number, maxDepth = 64): Promise<JsonObjectResult> {
  const got = await readJsonValue(req, cap, maxDepth)
  if (!got.ok) return got
  if (typeof got.value !== 'object' || got.value === null || Array.isArray(got.value)) return { ok: false, reason: 'not_object' }
  return { ok: true, value: got.value as Record<string, unknown> }
}
