import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Settings } from '../core/types.js'

// security/sign: HMAC over the bind payload. Format: b64url(json).b64url(mac).expiry
export const BIND_TTL_MS = 24 * 60 * 60 * 1000

export type VerifyResult = { ok: true; payload: Record<string, unknown> } | { ok: false }

const keys = (s: Settings) => [s.secret].flat()
const mac = (data: string, key: string) => createHmac('sha256', key).update(data).digest()

// Signs with the first key; the expiry is covered by the MAC so it cannot be extended.
export function signBind(payload: Record<string, unknown>, settings: Settings): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const exp = String(Date.now() + BIND_TTL_MS)
  return `${body}.${mac(`${body}.${exp}`, keys(settings)[0]).toString('base64url')}.${exp}`
}

// Verifies against every key (rotation). Never throws: any failure is { ok: false }.
export function verifyBind(bind: string, settings: Settings): VerifyResult {
  try {
    const parts = bind.split('.')
    if (parts.length !== 3) return { ok: false }
    const [body, sig, exp] = parts
    if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return { ok: false }
    const got = Buffer.from(sig, 'base64url')
    const valid = keys(settings).some((k) => {
      const want = mac(`${body}.${exp}`, k)
      return got.length === want.length && timingSafeEqual(got, want)
    })
    if (!valid) return { ok: false }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false }
    return { ok: true, payload }
  } catch {
    return { ok: false }
  }
}
