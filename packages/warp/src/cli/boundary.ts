// The FE/DB boundary (docs/design/frontend/v2/core/api-client.md §The FE/DB boundary rule): frontend code
// (app/**, src/app/**, components/**, any 'use client' file) must not runtime-import apps/** (models, views,
// the ORM in them) or Warp's data API, directly or through any helper. `import type` is erased, so allowed.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { build, type Metafile } from 'esbuild'

const DATA_API = new Set(['defineModel', 'field', 'QuerySet', 'connections', 'atomic', 'configureDb'])
const FE_DIRS = ['app', 'src/app', 'components', 'src/components']
const SKIP = new Set(['node_modules', '.next', 'dist', '.git', 'apps', 'coverage'])
const CODE = /\.(m?[jt]sx?)$/
const ASSETS = ['.css', '.scss', '.sass', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.md', '.mdx']

export interface Violation { file: string; chain: string[]; what: string }

const posix = (p: string) => p.split(sep).join('/')
function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name) || d.name.startsWith('.')) continue
    const p = join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else if (CODE.test(d.name) && !/\.d\.ts$/.test(d.name)) out.push(p)
  }
}
const useClient = (file: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(readFileSync(file, 'utf8'))

// Runtime names a source file imports from '@tvine/warp' (type-only imports and specifiers skipped).
function warpNames(file: string): string[] {
  const src = readFileSync(file, 'utf8'), names: string[] = []
  for (const m of src.matchAll(/(?:import|export)\s+(type\s+)?([^'";]*?)\s+from\s+['"]@tvine\/warp['"]/g)) {
    if (m[1]) continue
    if (/\*/.test(m[2]!)) { names.push('*'); continue }
    for (const s of /\{([^}]*)\}/.exec(m[2]!)?.[1]?.split(',') ?? []) {
      const n = s.trim()
      if (n && !n.startsWith('type ')) names.push(n.split(/\s+as\s+/)[0]!.trim())
    }
  }
  return names
}

export async function boundaryCheck(root: string): Promise<Violation[]> {
  const files: string[] = []
  for (const d of FE_DIRS) walk(join(root, d), files)
  const fe = new Set(files)
  const all: string[] = []
  walk(root, all)
  for (const f of all) if (!fe.has(f) && useClient(f)) fe.add(f)
  if (!fe.size) return []
  let meta: Metafile
  try {
    meta = (await build({
      entryPoints: [...fe], absWorkingDir: root, bundle: true, write: false, metafile: true, outdir: join(root, '.tvine-check'),
      platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'silent',
      loader: Object.fromEntries(ASSETS.map((e) => [e, 'empty' as const])),
    })).metafile
  } catch (e) {
    const errs = (e as { errors?: { text: string; location?: { file: string } | null }[] }).errors ?? []
    return errs.map((x) => ({ file: x.location?.file ?? '?', chain: [], what: `cannot be checked: ${x.text}` }))
  }
  const out: Violation[] = []
  for (const entry of fe) {
    const start = posix(relative(root, entry))
    const prev = new Map<string, string | null>([[start, null]])
    const queue = [start]
    const chainTo = (p: string) => { const c: string[] = []; for (let x: string | null | undefined = p; x; x = prev.get(x)) c.unshift(x); return c }
    let found: Violation | undefined
    while (queue.length && !found) {
      const cur = queue.shift()!
      for (const imp of meta.inputs[cur]?.imports ?? []) {
        if (imp.external) {
          if (imp.path === '@tvine/warp') {
            // a dynamic import()/require() gets the whole module: flagged like `import *`
            const bad = imp.kind === 'import-statement' ? warpNames(join(root, cur)).filter((n) => n === '*' || DATA_API.has(n)) : [`${imp.kind}`]
            if (bad.length) { found = { file: start, chain: chainTo(cur), what: `@tvine/warp data API (${bad.join(', ')})` }; break }
          } else if (imp.path.startsWith('@tvine/warp/migrations')) { found = { file: start, chain: chainTo(cur), what: imp.path }; break }
          continue
        }
        if (prev.has(imp.path)) continue
        prev.set(imp.path, cur)
        if (imp.path.startsWith('apps/')) { found = { file: start, chain: chainTo(imp.path), what: imp.path }; break }
        queue.push(imp.path)
      }
    }
    if (found) out.push(found)
  }
  return out
}

// level = settings.frontend.boundary: 'warn' prints the same report with `warn` lines (and check does not fail)
export const boundaryReport = (v: Violation[], level: 'error' | 'warn' = 'error') => v.map((x) => x.chain.length
  ? `${level.padEnd(5)}  ${x.chain.join(' → ')}${x.chain.at(-1) === x.what ? '' : ` → ${x.what}`}\n       frontend code must not use models/the ORM. Fix: add a view (e.g. a ListView with readOnly rules) in apps/<app>/views.ts and call it: \`must(await api.<app>.<name>(params))\` from '@tvine/weft/api'.`
  : `${level.padEnd(5)}  ${x.file}: ${x.what}`).join('\n')
