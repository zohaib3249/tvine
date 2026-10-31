// Django django.core.signing (docs/design/conventions/security-features.md): tamper-proof, optionally
// expiring tokens for links, cookies and one-time values. Signs with the first settings.secret key and
// verifies against every key (rotation), constant-time. Values are readable (base64), not encrypted.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { Settings } from '../core/types.js'

export class BadSignature extends Error { constructor(msg = 'bad signature') { super(msg); this.name = 'BadSignature' } }
export class SignatureExpired extends BadSignature { constructor(msg = 'signature expired') { super(msg); this.name = 'SignatureExpired' } }

// settings.secret, set at boot (loadSettings) or by configureSigning in scripts/tests; read lazily so the
// non-enumerable "missing secret" getter fires at first use, not at configure time
type Src = Pick<Settings, 'secret'> & Partial<Settings>
let source: Src | undefined
export function configureSigning(settings: Src): void { source = settings }
export const encryptionSetting = () => source?.encryption
export const loadedSettings = () => source
export function secretKeys(): string[] {
  if (!source) throw new Error('signing: settings are not loaded (call loadSettings() or configureSigning(settings))')
  return [source.secret].flat()
}

const b64 = (b: Buffer) => b.toString('base64url')
const SEP = ':'

export interface SignerOpts { key?: string | string[]; salt?: string; sep?: string }

export class Signer {
  readonly salt: string
  readonly sep: string
  constructor(protected opts: SignerOpts = {}) {
    this.salt = opts.salt ?? 'tvine.signing.Signer'
    this.sep = opts.sep ?? SEP
    if (/^[A-Za-z0-9_-]*$/.test(this.sep)) throw new Error('Signer: sep may not be a base64url character')
  }
  private keys(): string[] { return this.opts.key === undefined ? secretKeys() : [this.opts.key].flat() }
  // Django salted_hmac: a per-salt key, so a token for one purpose never verifies for another
  private mac(value: string, key: string): Buffer {
    const k = createHmac('sha256', `${this.salt}signer`).update(key).digest()
    return createHmac('sha256', k).update(value).digest()
  }
  signature(value: string): string { return b64(this.mac(value, this.keys()[0]!)) }
  sign(value: string): string { return `${value}${this.sep}${this.signature(value)}` }
  unsign(signed: string): string {
    const i = signed.lastIndexOf(this.sep)
    if (i < 0) throw new BadSignature(`no "${this.sep}" found in value`)
    const value = signed.slice(0, i)
    const got = Buffer.from(signed.slice(i + this.sep.length), 'base64url')
    const ok = this.keys().some((k) => { const want = this.mac(value, k); return got.length === want.length && timingSafeEqual(got, want) })
    if (!ok) throw new BadSignature()
    return value
  }
}

// value:timestamp:signature; the timestamp (seconds, base36) is covered by the MAC. maxAge in seconds (Django).
export class TimestampSigner extends Signer {
  constructor(opts: SignerOpts = {}) { super({ salt: 'tvine.signing.TimestampSigner', ...opts }) }
  timestamp(): string { return Math.floor(Date.now() / 1000).toString(36) }
  sign(value: string): string { return super.sign(`${value}${this.sep}${this.timestamp()}`) }
  unsign(signed: string, opts: { maxAge?: number } = {}): string {
    const inner = super.unsign(signed)
    const i = inner.lastIndexOf(this.sep)
    if (i < 0) throw new BadSignature('no timestamp')
    const ts = parseInt(inner.slice(i + this.sep.length), 36)
    if (!Number.isFinite(ts)) throw new BadSignature('bad timestamp')
    if (opts.maxAge !== undefined && Date.now() / 1000 - ts > opts.maxAge) throw new SignatureExpired(`signature age > ${opts.maxAge} seconds`)
    return inner.slice(0, i)
  }
}

export interface DumpsOpts { salt?: string; compress?: boolean; key?: string | string[] }
// Django signing.dumps: JSON → base64url (deflated when shorter, marked by a leading ".") → TimestampSigner
export function dumps(obj: unknown, opts: DumpsOpts = {}): string {
  const json = Buffer.from(JSON.stringify(obj))
  let data = b64(json)
  if (opts.compress) { const z = deflateRawSync(json); if (z.length < json.length - 1) data = `.${b64(z)}` }
  return new TimestampSigner({ salt: opts.salt ?? 'tvine.signing', key: opts.key }).sign(data)
}
// throws BadSignature / SignatureExpired; maxAge in seconds
export function loads<T = unknown>(token: string, opts: { salt?: string; maxAge?: number; key?: string | string[] } = {}): T {
  const data = new TimestampSigner({ salt: opts.salt ?? 'tvine.signing', key: opts.key }).unsign(token, { maxAge: opts.maxAge })
  try {
    const raw = data.startsWith('.') ? inflateRawSync(Buffer.from(data.slice(1), 'base64url'), { maxOutputLength: 1 << 24 }) : Buffer.from(data, 'base64url')
    return JSON.parse(raw.toString('utf8')) as T
  } catch { throw new BadSignature('bad payload') }
}

export const signing = { dumps, loads, Signer, TimestampSigner, BadSignature, SignatureExpired }
