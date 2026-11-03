// One cookie-header parser for every transport (http, api, channel, tab, shield, dispatch).
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

// THE Set-Cookie attribute formatter (session mint, Shield clearance, …): SameSite/Secure/Path/HttpOnly from the caller.
export type CookieAttrs = {
  httpOnly?: boolean
  sameSite: 'lax' | 'strict' | 'none'
  secure?: boolean
  path?: string
  maxAge: number
  domain?: string
}
export function setCookieHeader(name: string, value: string, o: CookieAttrs): string {
  const sameSite = `${o.sameSite[0]!.toUpperCase()}${o.sameSite.slice(1)}`
  return `${name}=${value}; Path=${o.path ?? '/'}; Max-Age=${o.maxAge}`
    + `${o.httpOnly === false ? '' : '; HttpOnly'}; SameSite=${sameSite}`
    + `${o.secure ? '; Secure' : ''}${o.domain ? `; Domain=${o.domain}` : ''}`
}
