// Shared x-tvine-forward MAC (Warp verifyForward + Weft signForward). Purpose-salted like Signer
// (salt `tvine.forward`, sep `.`): body.b64url(hmac). One algorithm — do not reimplement in weft/warp.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const FORWARD_SALT = 'tvine.forward'
export const FORWARD_TTL_MS = 30_000

const b64 = (b: Buffer) => b.toString('base64url')

function mac(body: string, secret: string): Buffer {
  const k = createHmac('sha256', `${FORWARD_SALT}signer`).update(secret).digest()
  return createHmac('sha256', k).update(body).digest()
}

/** `body` is already base64url JSON. Returns `body.sig`. */
export function signForwardBody(body: string, secret: string): string {
  return `${body}.${b64(mac(body, secret))}`
}

/** Packs `{ ...p, exp }` as base64url and signs — used by Warp + Weft `signForward`. */
export function signForwardPayload(p: Record<string, unknown>, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: now + FORWARD_TTL_MS })).toString('base64url')
  return signForwardBody(body, secret)
}

/** Any matching secret (rotation). Returns the body or undefined. */
export function unsignForwardBody(token: string, secrets: string | string[]): string | undefined {
  const i = token.lastIndexOf('.')
  if (i < 0) return undefined
  const body = token.slice(0, i)
  const got = Buffer.from(token.slice(i + 1), 'base64url')
  for (const secret of [secrets].flat()) {
    const want = mac(body, secret)
    if (got.length === want.length && timingSafeEqual(got, want)) return body
  }
  return undefined
}
