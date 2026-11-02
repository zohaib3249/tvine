// Web Bot Auth (L7): RFC 9421 HTTP Message Signatures + the Signature-Agent key directory
// (draft-meunier-web-bot-auth-architecture). ed25519 only, via node:crypto; the directory is fetched with safeFetch
// (https only, size + time capped) and cached. A valid signature fills request.agent.verified { directory, keyid }.
import { createHash, createPublicKey, verify as edVerify, type JsonWebKey, type KeyObject } from 'node:crypto'
import { safeFetch } from '../../security/safe-fetch.js'

export interface SigRequest { method: string; path: string; query?: string; authority: string; scheme: string; header(name: string): string | undefined }
export interface SigParams { components: string[]; params: Record<string, string | number | boolean>; raw: string }

// ---- RFC 8941 bits we need: a dictionary of inner lists with params (Signature-Input), of byte sequences (Signature)
export function parseSignatureInput(v: string): Map<string, SigParams> {
  const out = new Map<string, SigParams>()
  for (const [label, rest] of members(v)) {
    const m = /^\(([^)]*)\)(.*)$/.exec(rest)
    if (!m) continue
    const components = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!)
    const params: Record<string, string | number | boolean> = {}
    for (const p of m[2]!.split(';').slice(1)) {
      const [k, val] = [p.slice(0, p.indexOf('=') < 0 ? p.length : p.indexOf('=')).trim(), p.includes('=') ? p.slice(p.indexOf('=') + 1).trim() : undefined]
      params[k] = val === undefined ? true : val.startsWith('"') ? val.slice(1, -1) : /^-?\d+$/.test(val) ? Number(val) : val
    }
    out.set(label, { components, params, raw: rest })
  }
  return out
}
export function parseSignature(v: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const [label, rest] of members(v)) { const m = /^:([A-Za-z0-9+/=]*):$/.exec(rest); if (m) out.set(label, Buffer.from(m[1]!, 'base64')) }
  return out
}
// top-level dictionary members, splitting on commas outside quotes / parens
function members(v: string): [string, string][] {
  const out: [string, string][] = []
  let depth = 0, q = false, start = 0
  const push = (s: string) => { const i = s.indexOf('='); if (i > 0) out.push([s.slice(0, i).trim(), s.slice(i + 1).trim()]) }
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '"' && v[i - 1] !== '\\') q = !q
    else if (!q && c === '(') depth++
    else if (!q && c === ')') depth--
    else if (!q && depth === 0 && c === ',') { push(v.slice(start, i)); start = i + 1 }
  }
  push(v.slice(start))
  return out
}

// RFC 9421 §2.5 signature base. Unknown or missing components → undefined (the signature fails).
export function signatureBase(r: SigRequest, sp: SigParams): string | undefined {
  const lines: string[] = []
  for (const c of sp.components) {
    let v: string | undefined
    switch (c) {
      case '@method': v = r.method.toUpperCase(); break
      case '@authority': v = r.authority.toLowerCase(); break
      case '@scheme': v = r.scheme.toLowerCase(); break
      case '@path': v = r.path; break
      case '@query': v = `?${r.query ?? ''}`; break
      case '@target-uri': v = `${r.scheme}://${r.authority}${r.path}${r.query ? `?${r.query}` : ''}`; break
      case '@request-target': v = `${r.path}${r.query ? `?${r.query}` : ''}`; break
      default: v = c.startsWith('@') ? undefined : r.header(c)?.trim().replace(/\s*\r?\n\s*/g, ' ')
    }
    if (v === undefined) return undefined
    lines.push(`"${c}": ${v}`)
  }
  lines.push(`"@signature-params": ${sp.raw}`)
  return lines.join('\n')
}

// RFC 7638 JWK thumbprint (OKP), the Web Bot Auth keyid
export const jwkThumbprint = (k: { crv: string; kty: string; x: string }) => createHash('sha256').update(`{"crv":"${k.crv}","kty":"${k.kty}","x":"${k.x}"}`).digest('base64url')

export function verifyEd25519(base: string, sig: Buffer, key: KeyObject | JsonWebKey): boolean {
  try {
    const k = 'type' in key && typeof (key as KeyObject).export === 'function' ? key as KeyObject : createPublicKey({ key: key as JsonWebKey, format: 'jwk' })
    return edVerify(null, Buffer.from(base), k, sig)
  } catch { return false }
}

// ---- the key directory: <agent>/.well-known/http-message-signatures-directory (JWKS), cached 1 h ---------------------
type Dir = { at: number; keys: Map<string, JsonWebKey> }
const dirs = new Map<string, Dir | Promise<Dir>>()
export type Fetcher = (url: string) => Promise<Response>
const defaultFetch: Fetcher = (url) => safeFetch(url, { timeoutMs: 3000, maxBytes: 64 * 1024, maxRedirects: 1, headers: { accept: 'application/http-message-signatures-directory+json, application/json' } })
async function directory(origin: string, fetcher: Fetcher): Promise<Dir> {
  const hit = dirs.get(origin)
  if (hit && (hit instanceof Promise || Date.now() - hit.at < 3_600_000)) return hit
  const p = (async () => {
    const keys = new Map<string, JsonWebKey>()
    try {
      const res = await fetcher(`${origin}/.well-known/http-message-signatures-directory`)
      const body = res.ok ? await res.json() as { keys?: { kty?: string; crv?: string; x?: string }[] } : {}
      for (const k of body.keys ?? []) if (k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string') keys.set(jwkThumbprint(k as never), k as JsonWebKey)
    } catch { /* unreachable directory: no keys (fails closed), retried after the cache window */ }
    const d = { at: Date.now(), keys }
    if (dirs.size > 1000) dirs.clear()
    dirs.set(origin, d)
    return d
  })()
  dirs.set(origin, p)
  return p
}
export const clearDirectories = () => dirs.clear()

// the Signature-Agent header: an sf-string ("https://agent.example") or, in newer drafts, a dictionary (label="…")
function agentOrigin(v: string | undefined, label: string): string | undefined {
  if (!v) return undefined
  const raw = v.trim().startsWith('"') ? v.trim() : members(v).find(([k]) => k === label)?.[1]
  const s = raw?.replace(/^"|"$/g, '')
  try { const u = new URL(s ?? ''); return u.protocol === 'https:' ? u.origin : undefined } catch { return undefined }
}

const MAX_SKEW_S = 60, MAX_LIFE_S = 86_400
// verified { directory, keyid } or undefined. Checks: signature-agent covered (when sent), tag web-bot-auth, created /
// expires in range, alg ed25519, key in the agent's directory, the signature itself.
export async function verifyWebBotAuth(r: SigRequest, o: { now?: number; fetcher?: Fetcher } = {}): Promise<{ directory: string; keyid: string } | undefined> {
  const input = r.header('signature-input'), sigH = r.header('signature')
  if (!input || !sigH) return undefined
  const sigs = parseSignature(sigH)
  const now = Math.floor((o.now ?? Date.now()) / 1000)
  for (const [label, sp] of parseSignatureInput(input)) {
    const { created, expires, keyid, alg, tag } = sp.params
    if (tag !== 'web-bot-auth' || typeof keyid !== 'string' || (alg !== undefined && alg !== 'ed25519')) continue
    if (typeof created !== 'number' || created > now + MAX_SKEW_S) continue
    if (typeof expires !== 'number' || expires < now || expires - created > MAX_LIFE_S) continue
    if (!sp.components.includes('@authority')) continue
    const origin = agentOrigin(r.header('signature-agent'), label)
    if (!origin || !sp.components.includes('signature-agent')) continue
    const sig = sigs.get(label)
    const base = signatureBase(r, sp)
    if (!sig || base === undefined) continue
    const key = (await directory(origin, o.fetcher ?? defaultFetch)).keys.get(keyid)
    if (key && verifyEd25519(base, sig, key)) return { directory: origin, keyid }
  }
  return undefined
}
