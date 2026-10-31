// Field encryption (docs/design/conventions/security-features.md): AES-256-GCM, random 96-bit nonce,
// stored as `e1.<kid>.<base64url(nonce | ciphertext | tag)>`. Root keys = settings.encryption.keys
// (newest first) or, when empty, an HKDF of each settings.secret key with its own salt. Each root key is
// expanded per `context` (a field option; default 'default') into an encryption key and an index (HMAC) key.
// kid = 8 hex chars naming the root key, so a rotated list still decrypts old values.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { encryptionSetting, secretKeys } from './signing.js'

const derive = (ikm: string, salt: string, info: string) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32))
interface Root { kid: string; root: string; salt: string }
const cache = new Map<string, Buffer>()
const key = (r: Root, info: string) => {
  const id = `${r.kid}|${info}`
  let k = cache.get(id)
  if (!k) { k = derive(r.root, r.salt, info); cache.set(id, k) }
  return k
}

export function rootKeys(): Root[] {
  const own = encryptionSetting()?.keys ?? []
  const [list, salt] = own.length ? [own, 'tvine.encryption.keys'] : [secretKeys(), 'tvine.encryption.secret']
  return list.map((root) => ({ root, salt, kid: derive(root, salt, 'kid').subarray(0, 4).toString('hex') }))
}

export function encrypt(plain: string, context = 'default'): string {
  const r = rootKeys()[0]!
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(r, `enc:${context}`), nonce)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `e1.${r.kid}.${Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url')}`
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && /^e1\.[0-9a-f]{8}\./.test(v)
export const kidOf = (v: string) => v.split('.')[1]

export function decrypt(stored: string, context = 'default'): string {
  if (!isEncrypted(stored)) throw new Error('encrypted field: value is not ciphertext (written outside the ORM?)')
  const [, kid, body] = stored.split('.')
  const r = rootKeys().find((x) => x.kid === kid)
  if (!r) throw new Error(`encrypted field: no key with id ${kid} in settings.encryption.keys / settings.secret (removed too early?)`)
  const b = Buffer.from(body!, 'base64url')
  const d = createDecipheriv('aes-256-gcm', key(r, `enc:${context}`), b.subarray(0, 12))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')
}

// deterministic index: HMAC per root key (lookups match rows not yet rotated too)
export const blindIndex = (plain: string, context = 'default', r: Root = rootKeys()[0]!) =>
  createHmac('sha256', key(r, `idx:${context}`)).update(plain).digest('base64url')
export const blindIndexes = (plain: string, context = 'default') => rootKeys().map((r) => blindIndex(plain, context, r))
