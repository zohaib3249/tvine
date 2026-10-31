// Password hashing + validation (docs/design/contrib/auth.md §2). Hashers are pluggable (settings.auth.hashers,
// first = preferred); every encoded hash names its algorithm and carries its own parameters.
import { pbkdf2, randomBytes, scrypt, type ScryptOptions } from 'node:crypto'
import type { PasswordHasher, PasswordValidator, Settings } from '../../core/types.js'
import { same } from './crypto.js'

export const UNUSABLE = '!'   // prefix of a password that can never match (Django set_unusable_password)
export const MAX_PASSWORD = 4096

const scryptP = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((ok, bad) => scrypt(pw, salt, len, o, (e, k) => (e ? bad(e) : ok(k))))
const pow2 = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0

// scrypt$N$r$p$<salt b64>$<hash b64>. Default N=2^15, r=8, p=1 (~32 MiB, OWASP's minimum class).
export function scryptHasher(o: { N?: number; r?: number; p?: number } = {}): PasswordHasher {
  const N = o.N ?? 2 ** 15, r = o.r ?? 8, p = o.p ?? 1
  if (!pow2(N) || r < 1 || p < 1) throw new Error('scryptHasher: N must be a power of two > 1; r, p >= 1')
  const parse = (enc: string) => {
    const [alg, n, rr, pp, salt, hash] = enc.split('$')
    const v = { N: Number(n), r: Number(rr), p: Number(pp) }
    // bounds: a stored hash cannot make verify allocate unbounded memory
    if (alg !== 'scrypt' || !salt || !hash || !pow2(v.N) || v.N > 2 ** 20 || !(v.r >= 1 && v.r <= 32) || !(v.p >= 1 && v.p <= 16)) return undefined
    return { ...v, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') }
  }
  const run = (pw: string, salt: Buffer, len: number, v: { N: number; r: number; p: number }) =>
    scryptP(pw, salt, len, { N: v.N, r: v.r, p: v.p, maxmem: 256 * v.N * v.r * v.p + 1024 * 1024 })
  return {
    algorithm: 'scrypt',
    async encode(pw) {
      const salt = randomBytes(16)
      return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${(await run(pw, salt, 32, { N, r, p })).toString('base64')}`
    },
    async verify(pw, enc) {
      const v = parse(enc)
      if (!v || !v.hash.length) return false
      return same(await run(pw, v.salt, v.hash.length, v), v.hash)
    },
    mustUpdate(enc) {
      const v = parse(enc)
      return !v || v.N < N || v.r < r || v.p < p
    },
  }
}

// Django's format: pbkdf2_sha256$<iterations>$<salt>$<hash b64> (hashes migrated from Django verify as-is)
export function pbkdf2Hasher(o: { iterations?: number } = {}): PasswordHasher {
  const iterations = o.iterations ?? 600_000
  if (!Number.isInteger(iterations) || iterations < 100_000) throw new Error('pbkdf2Hasher: iterations must be >= 100000 (OWASP 2023: 600000 for sha256)')
  const run = (pw: string, salt: string, it: number) =>
    new Promise<Buffer>((ok, bad) => pbkdf2(pw, salt, it, 32, 'sha256', (e, k) => (e ? bad(e) : ok(k))))
  const parse = (enc: string) => {
    const [alg, it, salt, hash] = enc.split('$')
    const n = Number(it)
    return alg === 'pbkdf2_sha256' && salt && hash && Number.isInteger(n) && n > 0 && n <= 10_000_000 ? { n, salt, hash: Buffer.from(hash, 'base64') } : undefined
  }
  return {
    algorithm: 'pbkdf2_sha256',
    async encode(pw) {
      const salt = randomBytes(16).toString('base64url')
      return `pbkdf2_sha256$${iterations}$${salt}$${(await run(pw, salt, iterations)).toString('base64')}`
    },
    async verify(pw, enc) {
      const v = parse(enc)
      return !!v && same(await run(pw, v.salt, v.n), v.hash)
    },
    mustUpdate(enc) { const v = parse(enc); return !v || v.n < iterations },
  }
}

let fallback: PasswordHasher | undefined
const hashers = (s: Settings): PasswordHasher[] => s.auth?.hashers ?? [(fallback ??= scryptHasher())]

export const makePassword = (pw: string, s: Settings): Promise<string> => hashers(s)[0]!.encode(pw)
export const isUsable = (enc: string | null | undefined) => !!enc && !enc.startsWith(UNUSABLE)

// The same work whether or not there is a real hash to check: no timing oracle for "this user exists".
const dummies = new WeakMap<PasswordHasher, Promise<string>>()
async function dummy(pw: string, s: Settings): Promise<false> {
  const h = hashers(s)[0]!
  let d = dummies.get(h)
  if (!d) dummies.set(h, (d = h.encode(randomBytes(16).toString('hex'))))
  await h.verify(pw, await d)
  return false
}

// ok + upgrade: the hash should be re-encoded with the preferred hasher (different algorithm, weaker parameters)
export async function checkPassword(pw: string, enc: string | null | undefined, s: Settings): Promise<{ ok: boolean; upgrade: boolean }> {
  const list = hashers(s), alg = enc?.split('$')[0]
  const h = isUsable(enc) ? list.find((x) => x.algorithm === alg) : undefined
  if (!h || pw.length > MAX_PASSWORD) return { ok: await dummy(pw, s), upgrade: false }
  const ok = await h.verify(pw, enc!)
  return { ok, upgrade: ok && (h !== list[0] || list[0]!.mustUpdate(enc!)) }
}
export const dummyCheck = (pw: string, s: Settings) => dummy(pw, s)

// ---- validators (Django AUTH_PASSWORD_VALIDATORS) ------------------------------------------------
export const minLength = (n = 8): PasswordValidator => (pw) =>
  pw.length < n ? [`This password is too short. It must contain at least ${n} characters.`] : []

export const numericPassword = (): PasswordValidator => (pw) => (/^\d+$/.test(pw) ? ['This password is entirely numeric.'] : [])

// Django's top-of-list common passwords (the full 20k list is a later data file; pass your own with `list`).
const COMMON = `123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football
monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777
121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster soccer harley batman andrew
tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel starwars klaster 112233 george computer michelle
jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass maggie 159753 aaaaaa ginger princess joshua cheese
amanda summer love ashley nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder taylor matrix
mobilemail mom monitor monitoring montana moon moscow welcome welcome1 password1 password123 admin admin123 changeme
passw0rd p@ssw0rd qwerty123 letmein1 abcd1234 1q2w3e4r 1q2w3e4r5t zaq12wsx secret login guest root default test test123`
  .split(/\s+/)
export const commonPassword = (list: Iterable<string> = COMMON): PasswordValidator => {
  const set = new Set([...list].map((p) => p.trim().toLowerCase()))
  return (pw) => (set.has(pw.trim().toLowerCase()) ? ['This password is too common.'] : [])
}

// Django UserAttributeSimilarityValidator: SequenceMatcher.quick_ratio (multiset character overlap) of the
// password against each attribute and its \W-separated parts.
const quickRatio = (a: string, b: string) => {
  const left = new Map<string, number>()
  for (const c of b) left.set(c, (left.get(c) ?? 0) + 1)
  let m = 0
  for (const c of a) { const n = left.get(c); if (n) { m++; left.set(c, n - 1) } }
  return a.length + b.length ? (2 * m) / (a.length + b.length) : 0
}
export const userAttributeSimilarity = (attrs: string[] = ['username', 'email'], max = 0.7): PasswordValidator => (pw, user) => {
  if (!user) return []
  const p = pw.toLowerCase()
  for (const a of attrs) {
    const v = user[a]
    if (typeof v !== 'string' || !v) continue
    for (const part of [v, ...v.split(/\W+/)]) {
      if (part && quickRatio(p, part.toLowerCase()) >= max) return [`The password is too similar to the ${a}.`]
    }
  }
  return []
}

export const DEFAULT_VALIDATORS = [userAttributeSimilarity(), minLength(8), commonPassword(), numericPassword()]
export const validatePassword = (pw: string, s: Settings, user?: Record<string, unknown>): string[] =>
  pw.length > MAX_PASSWORD ? [`This password is too long (max ${MAX_PASSWORD} characters).`] : (s.auth?.validators ?? DEFAULT_VALIDATORS).flatMap((v) => v(pw, user))
