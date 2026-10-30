import type { RouteInfo } from './discovery.js'

// Next pattern match: [x] one segment, [...x] one or more, [[...x]] zero or more.
function matches(pattern: string, ps: string[]): boolean {
  const rs = pattern.split('/').filter(Boolean)
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!
    if (/^\[\[\.\.\.\w+\]\]$/.test(r)) return true
    if (/^\[\.\.\.\w+\]$/.test(r)) return ps.length > i
    if (i >= ps.length || (/^\[\w+\]$/.test(r) ? ps[i] === '' : r !== ps[i])) return false
  }
  return ps.length === rs.length
}

// The one route-table matcher the composition root hands to MCP (and the human Form path): a site
// path → its Next pattern, undefined = not a page. Same rules as transport/http.ts routeOf + matchRoute:
// canonical paths only (no //, trailing /, encoded / or \, dot segments), matched decoded.
// ponytail: http.ts still carries its own copy (Task 19b owns it); switch it to this export there.
export function routeMatcher(routes: RouteInfo[]): (path: string) => string | undefined {
  const statics = new Set(routes.map((r) => r.path).filter((p) => !p.includes('[')))
  const dynamics = routes.map((r) => r.path).filter((p) => p.includes('['))
  return (raw) => {
    if (raw.includes('//') || /%(2f|5c)/i.test(raw) || (raw.length > 1 && raw.endsWith('/'))) return undefined
    let d: string
    try { d = decodeURIComponent(raw) } catch { return undefined }
    if (d.includes('\\') || d.split('/').some((s) => s === '.' || s === '..')) return undefined
    if (statics.has(d)) return d
    const ps = d === '/' ? [] : d.split('/').slice(1)
    return dynamics.find((p) => matches(p, ps))
  }
}
