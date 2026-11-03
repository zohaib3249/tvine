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
