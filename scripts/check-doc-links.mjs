// Checks README.md and docs/*.md: every relative link resolves to a file outside docs/design, and nothing mentions docs/design.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const files = ['README.md', ...readdirSync(join(root, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)]
let links = 0, bad = []
for (const f of files) {
  const text = readFileSync(join(root, f), 'utf8')
  if (/docs\/design|\]\([^)]*design\//.test(text)) bad.push(`${f}: mentions docs/design`)
  for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue
    links++
    const target = resolve(root, dirname(f), href.split('#')[0])
    const rel = relative(root, target)
    if (!existsSync(target)) bad.push(`${f}: ${href} (missing)`)
    else if (rel.startsWith('docs/design')) bad.push(`${f}: ${href} (inside docs/design)`)
  }
}
console.log(`${files.length} files, ${links} relative links, ${bad.length} problems`)
for (const b of bad) console.log('  ' + b)
process.exit(bad.length ? 1 : 0)
