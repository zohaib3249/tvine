// The ONE check for every redirect target Tvine hands on (Next redirect() in an action or in a page
// render): http(s), one of this site's hosts, a routed page. Anything else is refused as forbidden — an
// agent (or a browser through <Form>) is never sent off-site or to a javascript: URL. A target that is
// not even a URL is a plain Error (→ err internal).
import { DomainError } from './errors.js'

export interface RedirectScope { base: string; hosts: string[]; route?: (path: string) => string | undefined }

export function siteRedirect(target: string, o: RedirectScope): string {
  let u: URL
  try { u = new URL(target, o.base) } catch { throw new Error(`redirect target is not a valid URL: ${JSON.stringify(target).slice(0, 80)}`) }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !o.hosts.includes(u.host.toLowerCase())) {
    throw new DomainError('forbidden', 'forbidden: redirect to another site')
  }
  if (o.route && o.route(u.pathname) === undefined) throw new DomainError('forbidden', 'forbidden: redirect to a page this site does not have')
  return u.pathname + u.search
}
