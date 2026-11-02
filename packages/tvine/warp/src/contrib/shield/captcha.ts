// Shield image captcha (last-resort challenge level). No third party, no deps.
// A 3x3 grid of procedurally drawn shapes; the user picks every tile showing the target kind.
// Every shape (and every decoy) is the same kind of SVG node: a <path> resampled to the same number of
// jittered points, rotated, scaled and colour-jittered, so the source carries no class/id/element hint.
// A text question is issued alongside for screen-reader users (`question`); either answer passes.
// Answers are kept only as HMACs (key derived from settings.secret) in the shield claim store (claims.ts: no eviction;
// redis across servers), read-and-deleted on the first check (single-use), 2-minute expiry.
// The text question is not arithmetic: a word task with varied phrasing (large answer space). It is still scriptable by
// design (accessibility); what makes a scripted solve cost is the PoW the captcha level also requires + attempt limits.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { claims } from './claims.js'
import { loadedSettings } from '../../security/signing.js'
import type { Settings } from '../../core/types.js'
import { secretKeys } from '../../security/signing.js'

export interface Captcha { id: string; svg: string; prompt: string; question: string; answerHash: string }

const TTL_MS = 2 * 60_000
const key = () => createHmac('sha256', secretKeys()[0]!).update('tvine.shield.captcha').digest()

type Kind = 'circle' | 'square' | 'triangle' | 'star'
const KINDS: Kind[] = ['circle', 'square', 'triangle', 'star']
const PLURAL: Record<Kind, string> = { circle: 'circles', square: 'squares', triangle: 'triangles', star: 'stars' }
const N = 36                                // points per outline, identical for every kind
const TILE = 100, GAP = 4, SIZE = TILE * 3 + GAP * 4

const mac = (id: string, answer: string) => createHmac('sha256', key()).update(`${id}\n${answer}`).digest()
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const f = (n: number) => n.toFixed(1)

/** Vertices of the unit outline (radius 1, centred at 0,0). */
function vertices(kind: Kind): [number, number][] {
  if (kind === 'circle') return Array.from({ length: N }, (_, i) => [Math.cos((i / N) * 2 * Math.PI), Math.sin((i / N) * 2 * Math.PI)])
  if (kind === 'square') return [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]]
  if (kind === 'triangle') return [[0, -1], [0.87, 0.5], [-0.87, 0.5]]
  return Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 0.45 : 1, a = (i / 10) * 2 * Math.PI - Math.PI / 2
    return [r * Math.cos(a), r * Math.sin(a)]
  })
}

/** Resample a closed polygon into N points equally spaced along its perimeter. */
function resample(v: [number, number][]): [number, number][] {
  const seg = v.map((p, i) => { const q = v[(i + 1) % v.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]) })
  const total = seg.reduce((a, b) => a + b, 0)
  const out: [number, number][] = []
  const start = Math.random() * total       // random start point: the first M is not a vertex
  for (let k = 0; k < N; k++) {
    let d = (start + (k / N) * total) % total, i = 0
    while (d > seg[i]) { d -= seg[i]; i++ }
    const p = v[i], q = v[(i + 1) % v.length], t = d / seg[i]
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
  }
  return out
}

function shapePath(kind: Kind, cx: number, cy: number): string {
  const r = rnd(26, 36), rot = rnd(0, 2 * Math.PI), c = Math.cos(rot), s = Math.sin(rot)
  cx += rnd(-6, 6); cy += rnd(-6, 6)
  const pts = resample(vertices(kind)).map(([x, y]) => {
    const jx = x * r + rnd(-1.2, 1.2), jy = y * r + rnd(-1.2, 1.2)
    return [cx + jx * c - jy * s, cy + jx * s + jy * c]
  })
  return 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L') + 'Z'
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`

/** Open scribble decoy: same point count, never closed, so it is not a shape. */
function scribble(x0: number, y0: number, w: number): string {
  const pts = Array.from({ length: N }, (_, i) => [x0 + (i / N) * w + rnd(-4, 4), y0 + rnd(-w / 2, w / 2)])
  return 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

const WORDS = ['harbor', 'velvet', 'lantern', 'meadow', 'pickle', 'cobalt', 'falcon', 'tundra', 'walnut', 'orchid', 'quartz', 'saddle', 'thimble',
  'garnet', 'beacon', 'canyon', 'dolphin', 'ember', 'fjord', 'glacier', 'hammock', 'iguana', 'juniper', 'kettle', 'lagoon', 'marble', 'nutmeg', 'oyster',
  'pebble', 'quiver', 'raisin', 'sapphire', 'tangerine', 'umbrella', 'vortex', 'wombat', 'yonder', 'zephyr', 'biscuit', 'compass', 'drizzle', 'figment']
const ORD = ['first', 'second', 'third', 'fourth', 'fifth']
// a word task: [question, answer]
function wordTask(): [string, string] {
  const w = WORDS[randomInt(WORDS.length)]!, k = randomInt(4)
  if (k === 0) return [`Type the word "${w}" backwards.`, [...w].reverse().join('')]
  if (k === 1) { const i = randomInt(3), j = 3 + randomInt(2); return [`Type the ${ORD[i]} and the ${ORD[j]} letters of "${w}".`, `${w[i]}${w[j]}`] }
  if (k === 2) return [`How many letters are in the word "${w}"? Answer with a number.`, String(w.length)]
  return [`Type "${w}" without its vowels.`, w.replace(/[aeiou]/g, '')]
}

export async function makeCaptcha(): Promise<Captcha> {
  const id = randomBytes(16).toString('base64url')
  const target = KINDS[randomInt(KINDS.length)]
  const others = KINDS.filter((k) => k !== target)
  const count = 2 + randomInt(3)                                    // 2..4 targets
  const kinds = shuffle([...Array(count).fill(target), ...Array.from({ length: 9 - count }, () => others[randomInt(others.length)])])
  const answer = kinds.flatMap((k, i) => (k === target ? [i] : [])).join(',')

  const hue = rnd(0, 360)
  const nodes: string[] = []
  kinds.forEach((kind, i) => {
    const x = GAP + (i % 3) * (TILE + GAP), y = GAP + Math.floor(i / 3) * (TILE + GAP)
    const cx = x + TILE / 2, cy = y + TILE / 2
    nodes.push(`<path d="M${x} ${y}h${TILE}v${TILE}h-${TILE}Z" fill="${hsl(hue + rnd(-20, 20), rnd(20, 40), rnd(88, 95))}"/>`)
    const draw = [
      `<path d="${shapePath(kind, cx, cy)}" fill="${hsl(rnd(0, 360), rnd(45, 75), rnd(40, 58))}" stroke="${hsl(rnd(0, 360), 30, 25)}" stroke-width="${f(rnd(1.5, 3))}"/>`,
      `<path d="${scribble(x + 8, y + rnd(15, 85), TILE - 16)}" fill="none" stroke="${hsl(rnd(0, 360), 40, 45)}" stroke-opacity="0.45" stroke-width="${f(rnd(1, 2))}"/>`,
    ]
    nodes.push(...(Math.random() < 0.5 ? draw : draw.reverse()))
  })
  for (let k = 0; k < 6; k++) nodes.push(`<path d="${scribble(0, rnd(20, SIZE - 20), SIZE)}" fill="none" stroke="${hsl(rnd(0, 360), 35, 50)}" stroke-opacity="0.3" stroke-width="1"/>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Image puzzle: 3 by 3 grid of shapes">${nodes.join('')}</svg>`

  const [question, textAnswer] = wordTask()
  const grid = mac(id, `grid:${answer}`)
  await claims.set(loadedSettings() as Settings | undefined, `captcha:${id}`, JSON.stringify({ grid: grid.toString('hex'), text: mac(id, `text:${textAnswer}`).toString('hex') }), TTL_MS)
  return { id, svg, prompt: `Select all the ${PLURAL[target]}`, question, answerHash: grid.toString('hex') }
}

/** `answer` is `grid:<tile indices, comma separated>` or `text:<number>`. Single-use: always consumes `id`. */
export async function checkCaptcha(id: string, answer: string): Promise<boolean> {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return false
  const raw = await claims.take(loadedSettings() as Settings | undefined, `captcha:${id}`)   // read + delete: single-use everywhere
  if (!raw) return false
  const p = JSON.parse(raw) as { grid: string; text: string }
  if (typeof answer !== 'string' || answer.length > 64) return false
  const m = /^(grid|text):(.*)$/.exec(answer.trim().toLowerCase())
  if (!m) return false
  let norm: string
  if (m[1] === 'grid') {
    const idx = [...new Set(m[2].split(',').map((s) => s.trim()).filter(Boolean).map(Number))]
    if (!idx.every((n) => Number.isInteger(n) && n >= 0 && n < 9)) return false
    norm = `grid:${idx.sort((x, y) => x - y).join(',')}`
  } else norm = `text:${m[2].trim()}`
  const got = mac(id, norm)
  return timingSafeEqual(got, Buffer.from(m[1] === 'grid' ? p.grid : p.text, 'hex'))
}
