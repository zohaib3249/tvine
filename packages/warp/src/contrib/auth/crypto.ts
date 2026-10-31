// node:crypto building blocks for tvine.auth. Every derived key comes from settings.secret per purpose
// (HKDF, domain-separated); MACs and ciphertexts verify under ANY secret key and are made with the first
// (secret rotation, BACKLOG #8).
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { crc32 } from 'node:zlib'
import type { Settings } from '../../core/types.js'

const keys = (settings: Settings): string[] => [settings.secret].flat()
const derive = (key: string, purpose: string) => Buffer.from(hkdfSync('sha256', key, '', `tvine.auth.${purpose}`, 32))

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// constant time on equal lengths; unequal lengths answer false without comparing
export function same(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a), y = Buffer.isBuffer(b) ? b : Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const mac = (settings: Settings, purpose: string, data: string) =>
  createHmac('sha256', derive(keys(settings)[0]!, purpose)).update(data).digest('base64url')
export const macOk = (settings: Settings, purpose: string, data: string, given: string) =>
  keys(settings).map((k) => same(createHmac('sha256', derive(k, purpose)).update(data).digest('base64url'), given)).includes(true)

// AES-256-GCM: v1.<iv>.<tag>.<ciphertext> (base64url)
export function seal(settings: Settings, purpose: string, plain: Buffer): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', derive(keys(settings)[0]!, purpose), iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.')
}
export function unseal(settings: Settings, purpose: string, sealed: string): Buffer | undefined {
  const [v, iv, tag, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || ct === undefined) return undefined
  for (const k of keys(settings)) {
    try {
      const d = createDecipheriv('aes-256-gcm', derive(k, purpose), Buffer.from(iv, 'base64url'))
      d.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()])
    } catch { /* next key */ }
  }
  return undefined
}

// RFC 4648 base32, no padding (authenticator apps)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(b: Buffer): string {
  let bits = 0, v = 0, out = ''
  for (const byte of b) {
    v = (v << 8) | byte; bits += 8
    while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5 }
  }
  return bits ? out + B32[(v << (5 - bits)) & 31] : out
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const random62 = (n: number) => Array.from({ length: n }, () => B62[randomInt(62)]).join('')
export function base62(n: number, width: number): string {
  let s = ''
  for (let i = 0; i < width; i++) { s = B62[n % 62] + s; n = Math.floor(n / 62) }
  return s
}
export const checksum = (s: string) => base62(crc32(s), 6)

// RFC 4226 HOTP / RFC 6238 TOTP: HMAC-SHA1, 6 digits
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const o = h[h.length - 1]! & 15
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
