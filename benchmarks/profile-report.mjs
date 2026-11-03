// Self-time breakdown of a .cpuprofile: top functions and time per module group. node profile-report.mjs <file.cpuprofile>
import { readFileSync } from 'node:fs'
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const dt = new Map()   // node id -> self µs, from samples + timeDeltas (exact, not hitCount)
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0))
const total = [...dt.values()].reduce((a, b) => a + b, 0)

function group(url, fn) {
  if (!url) return fn.startsWith('(') ? fn : 'native/builtin'
  if (url.includes('/better-sqlite3/')) return 'sqlite (better-sqlite3 JS)'
  if (url.includes('/next/')) return 'Next.js'
  if (url.includes('/zod/')) return 'zod'
  if (url.includes('/redis/') || url.includes('/@redis/')) return 'redis client'
  const m = url.match(/tvine\/warp\/dist\/([^/]+)(?:\/([^/]+))?/)
  if (m) return `tvine ${m[1]}${m[2] && !m[2].endsWith('.js') ? '/' + m[2] : m[2] ? '/' + m[2].replace('.js', '') : ''}`
  if (url.startsWith('node:')) return url.replace(/^node:(internal\/)?/, 'node:').split('/').slice(0, 2).join('/')
  if (url.includes('/node_modules/')) return 'npm ' + url.split('/node_modules/').at(-1).split('/')[0]
  return url.split('/').slice(-2).join('/')
}
const byFn = new Map(), byGroup = new Map()
for (const n of p.nodes) {
  const us = dt.get(n.id) ?? 0; if (!us) continue
  const { functionName, url, lineNumber } = n.callFrame
  const fn = functionName || '(anonymous)'
  const k = `${fn}  ${url ? url.replace(/^.*\/(node_modules|dist)\//, '$1/') + ':' + (lineNumber + 1) : ''}`
  byFn.set(k, (byFn.get(k) ?? 0) + us)
  const g = group(url, fn); byGroup.set(g, (byGroup.get(g) ?? 0) + us)
}
const pct = (us) => ((us / total) * 100).toFixed(1) + '%'
const busy = total - (byGroup.get('(idle)') ?? 0)
console.log(`profile: ${(total / 1e6).toFixed(1)} s sampled, busy ${(busy / 1e6).toFixed(1)} s (${pct(busy)})\n`)
console.log('| # | function (self time) | share of all samples |\n|---|---|---|')
;[...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, us], i) => console.log(`| ${i + 1} | \`${k.replace(/\|/g, '/')}\` | ${pct(us)} |`))
console.log('\n| module group | self time | share of busy |\n|---|---|---|')
for (const [g, us] of [...byGroup].sort((a, b) => b[1] - a[1]).slice(0, 25)) if (g !== '(idle)') console.log(`| ${g} | ${(us / 1e3).toFixed(0)} ms | ${((us / busy) * 100).toFixed(1)}% |`)
