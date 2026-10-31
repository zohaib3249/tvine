// Redaction shared by logs, command hooks, audit params and the confirm prompt.
// Keys: secret-looking names — long stems anywhere in the key, short ones only as a whole word (cardNumber /
// credit_card yes, shipping / discard no). Values: secrets inside strings (URL query tokens, DSN passwords,
// `Bearer …`, cookie headers) are scrubbed wherever they sit.
const SECRET_STEM = /pass|secret|token|credential|cookie|authorization|creditcard|recovery|bearer|jwt|apikey|session_?id|(reset|magic|login|invite|verif\w*|activat\w*|confirm\w*)_?(link|url)/i
const SECRET_WORD = new Set(['sid', 'bind', 'cmdid', 'auth', 'key', 'ssn', 'card', 'cvv', 'cvc', 'otp', 'pin', 'dsn'])
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
// a sid's one-way hash is the safe stand-in for the sid (logs, audit): kept
export const secretName = (k: string) => !/^sid_?hash$/i.test(k) && (
  k === '$confirm' || SECRET_STEM.test(k) || SECRET_STEM.test(snake(k).replace(/[^a-z0-9]+/g, '_')) ||
  snake(k).split(/[^a-z0-9]+/).some((w) => SECRET_WORD.has(w)))

const R = '[redacted]'
// query params whose value is a credential (+ any secret-looking name)
const QUERY_SECRET = new Set(['code', 'signature', 'sig', 'key', 'sid', 'password', 'secret', 'token'])
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const scrubUrl = (u: string): string => {
  // userinfo (DSNs: postgres://user:pass@host) — the password goes, the user stays
  let out = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]*):([^/@\s]*)@/i, `$1$2:${R}@`)
  out = out.replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (m, sep: string, name: string) => {
    let n = name
    try { n = decodeURIComponent(name) } catch { /* keep */ }
    return QUERY_SECRET.has(n.toLowerCase()) || secretName(n) ? `${sep}${name}=${R}` : m
  })
  return out
}
// a Cookie / Set-Cookie looking string: every value goes
const COOKIE = /^\s*[!#$%&'*+.^`|~\w-]+=[^;]*(;\s*[!#$%&'*+.^`|~\w-]+(=[^;]*)?)*\s*;?\s*$/
export function scrubString(s: string): string {
  if (s.length > 1_000_000) return R   // ponytail: huge strings are not scanned, blanked instead
  let out = s.replace(/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=:-]+/gi, `$1 ${R}`)
  if (out.includes('://')) out = out.replace(URLISH, scrubUrl)
  if (out.includes('=') && (out.includes(';') || /(^|\b)(tvine_s|__host-|session|sess|csrf|jwt)[\w-]*=/i.test(out)) && COOKIE.test(out)) {
    out = out.replace(/([!#$%&'*+.^`|~\w-]+)=([^;]*)/g, (m, name: string) => (/^(path|domain|expires|max-age|samesite)$/i.test(name) ? m : `${name}=${R}`))
  }
  return out
}

// THE request depth cap (transport/http.ts tooDeep): deeper than this is blanked, never passed through
export const MAX_DEPTH = 64

// a JSON-ish value with every secret-named key's value replaced and every string scrubbed (any depth up to MAX_DEPTH,
// beyond it blanked); extra: more key names (lowercase). Errors keep name / message / stack / cause, scrubbed.
export function redactSecrets(v: unknown, depth = 0, extra?: ReadonlySet<string>): unknown {
  if (typeof v === 'string') return scrubString(v)
  if (!v || typeof v !== 'object') return v
  if (depth > MAX_DEPTH) return '[redacted: too deep]'
  if (v instanceof Error) {
    const e = v as Error & { code?: unknown }
    return { name: e.name, message: scrubString(e.message), ...(e.code !== undefined && { code: e.code }),
      ...(e.stack && { stack: scrubString(e.stack) }), ...(e.cause !== undefined && { cause: redactSecrets(e.cause, depth + 1, extra) }) }
  }
  if (v instanceof Date) return v
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1, extra))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secretName(k) || extra?.has(k.toLowerCase()) ? R : redactSecrets(x, depth + 1, extra)]))
}
