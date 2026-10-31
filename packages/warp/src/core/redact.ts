// Secret-looking names (shared by command hooks and the inspector feed): long stems anywhere in the key, short
// ones only as a whole word (cardNumber / credit_card yes, shipping / discard no).
const SECRET_STEM = /pass|secret|token|credential|cookie|authorization|creditcard|recovery/i
const SECRET_WORD = new Set(['sid', 'bind', 'cmdid', 'auth', 'key', 'ssn', 'card', 'cvv', 'cvc', 'otp', 'pin'])
export const secretName = (k: string) =>
  k === '$confirm' || SECRET_STEM.test(k) || k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some((w) => SECRET_WORD.has(w))

// a JSON-ish value with every secret-named key's value replaced (any depth); extra: more key names (lowercase)
export function redactSecrets(v: unknown, depth = 0, extra?: ReadonlySet<string>): unknown {
  if (!v || typeof v !== 'object' || depth > 32) return v
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1, extra))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secretName(k) || extra?.has(k.toLowerCase()) ? '[redacted]' : redactSecrets(x, depth + 1, extra)]))
}
