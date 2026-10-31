import { readdirSync, statSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadNextRoutes, type RouteInfo } from './discovery.js'

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

// The app router's pages, read from the source tree (app/ or src/app/): every page.{tsx,ts,jsx,js,mdx} is a
// route. Next's folder rules: (group) segments vanish, _private folders and @slot / (.)intercepting segments
// are not URL routes. Dev needs this: next dev writes no app-path-routes-manifest and compiles pages lazily.
export function appDirRoutes(projectDir: string): RouteInfo[] {
  const root = [join(projectDir, 'app'), join(projectDir, 'src', 'app')].find((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory())
  if (!root) return []
  const out = new Set<string>()
  const walk = (dir: string, segs: string[]) => {
    let ents: Dirent[]
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isFile() && /^page\.(tsx|ts|jsx|js|mdx)$/.test(e.name)) out.add('/' + segs.join('/'))
      if (!e.isDirectory()) continue
      const n = e.name
      if (n.startsWith('_') || n.startsWith('@') || /^\(\.{1,3}\)/.test(n) || n === 'node_modules') continue
      walk(join(dir, n), /^\(.+\)$/.test(n) ? segs : [...segs, n])
    }
  }
  walk(root, [])
  return [...out].sort().map((path) => ({ path }))
}

// Dev: the routes come from the app/ tree (rescanned at most once a second, so a new page is routable without
// a restart), plus whatever a previous `next build` left in the manifest.
export function liveRouteMatcher(nextDir: string): (path: string) => string | undefined {
  const projectDir = dirname(nextDir)
  let at = 0, match = routeMatcher([])
  return (path) => {
    if (Date.now() - at > 1000) {
      at = Date.now()
      const all = new Map([...loadNextRoutes(nextDir), ...appDirRoutes(projectDir)].map((r) => [r.path, r]))
      match = routeMatcher([...all.values()])
    }
    return match(path)
  }
}
