// Field encryption (docs/design/conventions/security-features.md): AES-256-GCM, random 96-bit nonce.
//   e2.<kid>.<base64url(nonce | ciphertext | tag)>   AAD = 'tvine.enc.v2|<binding>' (model.column, + |pk with bindRow)
//   e1.<kid>.<…>                                       legacy, no AAD: still read; `tvine encryption rotate` upgrades it
// Root keys: settings.encryption.keys (newest first) THEN an HKDF of every settings.secret key. Encryption uses the
// first; decryption picks the key by its id from the whole list, so adding encryption.keys never strands old data.
// Each root key is expanded per `context` (a field option; default 'default') into an encryption and an index key.
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
const rootOf = (root: string, salt: string): Root => ({ root, salt, kid: derive(root, salt, 'kid').subarray(0, 4).toString('hex') })

export function rootKeys(): Root[] {
  const own = (encryptionSetting()?.keys ?? []).map((k) => rootOf(k, 'tvine.encryption.keys'))
  const fromSecret = secretKeys().map((k) => rootOf(k, 'tvine.encryption.secret'))
  return [...own, ...fromSecret]
}

const aadOf = (binding: string) => Buffer.from(`tvine.enc.v2|${binding}`)

export function encrypt(plain: string, context = 'default', binding = ''): string {
  const r = rootKeys()[0]!
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(r, `enc:${context}`), nonce)
  c.setAAD(aadOf(binding))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `e2.${r.kid}.${Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url')}`
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && /^e[12]\.[0-9a-f]{8}\./.test(v)
export const kidOf = (v: string) => v.split('.')[1]

export function decrypt(stored: string, context = 'default', binding = ''): string {
  if (!isEncrypted(stored)) throw new Error('encrypted field: value is not ciphertext (written outside the ORM?)')
  const [ver, kid, body] = stored.split('.')
  const r = rootKeys().find((x) => x.kid === kid)
  if (!r) throw new Error(`encrypted field: no key with id ${kid} in settings.encryption.keys / settings.secret (removed too early?)`)
  const b = Buffer.from(body!, 'base64url')
  const d = createDecipheriv('aes-256-gcm', key(r, `enc:${context}`), b.subarray(0, 12))
  if (ver === 'e2') d.setAAD(aadOf(binding))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')
}

// deterministic index: HMAC per root key, bound to model.column (lookups also match rows not yet rotated:
// every key, and the legacy unbound form)
export const blindIndex = (plain: string, context = 'default', binding = '', r: Root = rootKeys()[0]!) =>
  createHmac('sha256', key(r, `idx:${context}`)).update(binding ? `${binding}\0${plain}` : plain).digest('base64url')
export const blindIndexes = (plain: string, context = 'default', binding = '') =>
  rootKeys().flatMap((r) => [blindIndex(plain, context, binding, r), ...(binding ? [blindIndex(plain, context, '', r)] : [])])
