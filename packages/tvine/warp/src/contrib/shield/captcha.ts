// Shield image captcha (last-resort challenge level). No third party, no deps.
// Two server-rendered RASTER PNGs (encoded here with zlib), so the client never gets vectors, text or numbers to parse:
//  - a 3x3 grid of procedurally drawn shapes; the user picks every tile showing the target kind. Shapes are jittered,
//    rotated, filled/outlined in random colours over noisy tiles, crossed by scribbles, then pixel-noised, sine-warped, blurred.
//  - an arithmetic task ("7 + 5 = ?") drawn glyph by glyph from stroke polylines, each glyph randomly scaled/rotated/moved,
//    with noise dots, crossing lines, warp and blur. There is no plain-text alternative: no answer-revealing text reaches
//    the client. Either answer passes; a scripted (OCR / vision) solve still also costs the PoW + attempt limits.
// Answers are kept only as HMACs (key derived from settings.secret) in the shield claim store (claims.ts: no eviction;
// redis across servers), read-and-deleted on the first check (single-use), 2-minute expiry.
// [D] Not routed through Signer: wire stores raw hex of HMAC(id\\nanswer) with key = HMAC(secret, 'tvine.shield.captcha').
// Signer's salt derivation is inverted (HMAC(salt+'signer', secret)) and emits value:sig tokens — changing would
// invalidate in-flight captchas. Purpose string above already isolates the key from other MACs.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { claims } from './claims.js'
import { loadedSettings } from '../../security/signing.js'
import type { Settings } from '../../core/types.js'
import { secretKeys } from '../../security/signing.js'

export interface Captcha { id: string; image: string; prompt: string; mathImage: string; answerHash: string }

const TTL_MS = 2 * 60_000
const key = () => createHmac('sha256', secretKeys()[0]!).update('tvine.shield.captcha').digest()

type Kind = 'circle' | 'square' | 'triangle' | 'star'
const KINDS: Kind[] = ['circle', 'square', 'triangle', 'star']
const PLURAL: Record<Kind, string> = { circle: 'circles', square: 'squares', triangle: 'triangles', star: 'stars' }
const N = 36                                // points per outline, identical for every kind
const TILE = 100, GAP = 4, SIZE = TILE * 3 + GAP * 4

const mac = (id: string, answer: string) => createHmac('sha256', key()).update(`${id}\n${answer}`).digest()
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

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
  const start = Math.random() * total       // random start point: the outline does not start on a vertex
  for (let k = 0; k < N; k++) {
    let d = (start + (k / N) * total) % total, i = 0
    while (d > seg[i]) { d -= seg[i]; i++ }
    const p = v[i], q = v[(i + 1) % v.length], t = d / seg[i]
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
  }
  return out
}

// ── raster: an RGB buffer drawn into with discs / scanline fills, then noised, warped, blurred, PNG-encoded ──
type RGB = [number, number, number]
interface Img { w: number; h: number; px: Buffer }
function image(w: number, h: number, bg: RGB): Img {
  const px = Buffer.alloc(w * h * 3)
  for (let i = 0; i < px.length; i += 3) px.set(bg, i)
  return { w, h, px }
}
const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n)

function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))) as RGB
}

function plot(m: Img, x: number, y: number, c: RGB, alpha = 1) {
  x = Math.round(x); y = Math.round(y)
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return
  const i = (y * m.w + x) * 3
  for (let k = 0; k < 3; k++) m.px[i + k] = Math.round(m.px[i + k] * (1 - alpha) + c[k] * alpha)
}

/** A thick polyline: discs of radius r stamped every half pixel (each pixel blended once). */
function stroke(m: Img, pts: [number, number][], r: number, c: RGB, alpha = 1) {
  const done = new Set<number>(), R = Math.ceil(r)
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2))
    for (let t = 0; t <= n; t++) {
      const cx = x0 + ((x1 - x0) * t) / n, cy = y0 + ((y1 - y0) * t) / n
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r) continue
        const x = Math.round(cx + dx), y = Math.round(cy + dy), id = y * m.w + x
        if (x < 0 || x >= m.w || done.has(id)) continue
        done.add(id); plot(m, x, y, c, alpha)
      }
    }
  }
}

/** Filled polygon, scanline even-odd rule. */
function fill(m: Img, pts: [number, number][], c: RGB) {
  for (let y = 0; y < m.h; y++) {
    const sy = y + 0.5, xs: number[] = []
    pts.forEach(([x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length]
      if ((y0 <= sy) !== (y1 <= sy)) xs.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0))
    })
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x < xs[k + 1] - 0.5; x++) plot(m, x, y, c)
  }
}

function noise(m: Img, amp: number) {
  for (let i = 0; i < m.px.length; i++) m.px[i] = clamp(m.px[i] + Math.round(rnd(-amp, amp)))
}

/** Sine-wave warp: every pixel is displaced by up to `amp` px along both axes. */
function warp(m: Img, amp: number) {
  const src = Buffer.from(m.px), ph = [rnd(0, 7), rnd(0, 7)], wl = [rnd(14, 26), rnd(14, 26)]
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const sx = Math.min(m.w - 1, Math.max(0, Math.round(x + amp * Math.sin(y / wl[0] + ph[0]))))
    const sy = Math.min(m.h - 1, Math.max(0, Math.round(y + amp * Math.sin(x / wl[1] + ph[1]))))
    src.copy(m.px, (y * m.w + x) * 3, (sy * m.w + sx) * 3, (sy * m.w + sx) * 3 + 3)
  }
}

/** 3x3 box blur (radius 1). */
function blur(m: Img) {
  const src = Buffer.from(m.px)
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) for (let k = 0; k < 3; k++) {
    let sum = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < m.w && yy < m.h) { sum += src[(yy * m.w + xx) * 3 + k]; n++ }
    }
    m.px[(y * m.w + x) * 3 + k] = Math.round(sum / n)
  }
}

function png(m: Img): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(m.w, 0); ihdr.writeUInt32BE(m.h, 4); ihdr[8] = 8; ihdr[9] = 2   // 8-bit truecolour RGB, no interlace
  const row = m.w * 3, raw = Buffer.alloc((row + 1) * m.h)                          // filter byte 0 at the start of each row
  for (let y = 0; y < m.h; y++) m.px.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return 'data:image/png;base64,' + Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

// ── grid puzzle ──
function shapePoints(kind: Kind, cx: number, cy: number): [number, number][] {
  const r = rnd(26, 36), rot = rnd(0, 2 * Math.PI), c = Math.cos(rot), s = Math.sin(rot)
  cx += rnd(-6, 6); cy += rnd(-6, 6)
  return resample(vertices(kind)).map(([x, y]) => {
    const jx = x * r + rnd(-1.2, 1.2), jy = y * r + rnd(-1.2, 1.2)
    return [cx + jx * c - jy * s, cy + jx * s + jy * c]
  })
}

/** Open scribble: a wobbly line across `w` px. */
const scribble = (x0: number, y0: number, w: number): [number, number][] =>
  Array.from({ length: N }, (_, i) => [x0 + (i / (N - 1)) * w + rnd(-4, 4), y0 + rnd(-w / 6, w / 6)])

function drawGrid(kinds: Kind[]): string {
  const m = image(SIZE, SIZE, hsl(rnd(0, 360), 15, 96)), hue = rnd(0, 360)
  kinds.forEach((kind, i) => {
    const x = GAP + (i % 3) * (TILE + GAP), y = GAP + Math.floor(i / 3) * (TILE + GAP)
    const bg = hsl(hue + rnd(-20, 20), rnd(20, 40), rnd(85, 94))
    for (let yy = y; yy < y + TILE; yy++) for (let xx = x; xx < x + TILE; xx++) plot(m, xx, yy, bg.map((v) => clamp(v + rnd(-14, 14))) as RGB)
    const draw = [
      () => {
        const pts = shapePoints(kind, x + TILE / 2, y + TILE / 2), h = rnd(0, 360)
        fill(m, pts, hsl(h, rnd(45, 75), rnd(42, 60)))
        stroke(m, [...pts, pts[0]], rnd(1, 1.8), hsl(h + rnd(-30, 30), 35, rnd(18, 28)))          // darker outline
      },
      () => stroke(m, scribble(x + 6, y + rnd(15, 85), TILE - 12), rnd(0.6, 1.2), hsl(rnd(0, 360), 40, 45), 0.5),
    ]
    for (const d of Math.random() < 0.5 ? draw : draw.reverse()) d()
  })
  for (let k = 0; k < 6; k++) stroke(m, scribble(0, rnd(20, SIZE - 20), SIZE), rnd(0.5, 1), hsl(rnd(0, 360), 35, 50), 0.4)
  noise(m, 6); warp(m, rnd(2, 3.5)); blur(m)
  return png(m)
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

// ── math puzzle: glyphs as stroke polylines on a unit box (x right, y down) ──
const GLYPHS: Record<string, [number, number][][]> = {
  '0': [[[0.5, 0], [0.85, 0.15], [0.95, 0.5], [0.85, 0.85], [0.5, 1], [0.15, 0.85], [0.05, 0.5], [0.15, 0.15], [0.5, 0]]],
  '1': [[[0.25, 0.2], [0.55, 0], [0.55, 1]], [[0.25, 1], [0.85, 1]]],
  '2': [[[0.1, 0.2], [0.3, 0], [0.7, 0], [0.9, 0.2], [0.9, 0.4], [0.1, 1], [0.9, 1]]],
  '3': [[[0.1, 0], [0.9, 0], [0.45, 0.42], [0.8, 0.55], [0.9, 0.75], [0.75, 0.95], [0.5, 1], [0.1, 0.9]]],
  '4': [[[0.7, 1], [0.7, 0], [0.05, 0.7], [0.95, 0.7]]],
  '5': [[[0.9, 0], [0.15, 0], [0.1, 0.45], [0.5, 0.38], [0.85, 0.55], [0.9, 0.8], [0.6, 1], [0.1, 0.9]]],
  '6': [[[0.8, 0.05], [0.4, 0.1], [0.15, 0.45], [0.1, 0.75], [0.3, 0.98], [0.65, 1], [0.9, 0.8], [0.85, 0.55], [0.55, 0.45], [0.15, 0.6]]],
  '7': [[[0.1, 0], [0.9, 0], [0.4, 1]]],
  '8': [[[0.5, 0], [0.82, 0.12], [0.82, 0.35], [0.5, 0.47], [0.18, 0.35], [0.18, 0.12], [0.5, 0]],
    [[0.5, 0.47], [0.88, 0.6], [0.88, 0.88], [0.5, 1], [0.12, 0.88], [0.12, 0.6], [0.5, 0.47]]],
  '9': [[[0.85, 0.4], [0.45, 0.55], [0.15, 0.4], [0.15, 0.12], [0.45, 0], [0.8, 0.1], [0.85, 0.4], [0.75, 0.75], [0.4, 1], [0.15, 0.95]]],
  '+': [[[0.5, 0.2], [0.5, 0.8]], [[0.15, 0.5], [0.85, 0.5]]],
  '−': [[[0.15, 0.5], [0.85, 0.5]]],
  '×': [[[0.2, 0.25], [0.8, 0.75]], [[0.8, 0.25], [0.2, 0.75]]],
  '=': [[[0.15, 0.36], [0.85, 0.36]], [[0.15, 0.64], [0.85, 0.64]]],
  '?': [[[0.15, 0.25], [0.3, 0.05], [0.6, 0], [0.85, 0.15], [0.85, 0.35], [0.5, 0.55], [0.5, 0.75]], [[0.5, 0.92], [0.5, 0.98]]],
}

/** A random arithmetic task: [glyphs, answer]. a+b (1–20 each), a−b (never negative), a×b (2–9). */
function mathTask(): [string, number] {
  const k = randomInt(3)
  if (k === 2) { const a = 2 + randomInt(8), b = 2 + randomInt(8); return [`${a}×${b}=?`, a * b] }
  let a = 1 + randomInt(20), b = 1 + randomInt(20)
  if (k === 0) return [`${a}+${b}=?`, a + b]
  if (b > a) [a, b] = [b, a]
  return [`${a}−${b}=?`, a - b]
}

function drawMath(text: string): string {
  const W = 220, H = 70, m = image(W, H, hsl(rnd(0, 360), rnd(15, 35), rnd(88, 95)))
  const ink = () => hsl(rnd(0, 360), rnd(45, 75), rnd(22, 40))
  for (let k = 0; k < 220; k++) plot(m, rnd(0, W), rnd(0, H), ink(), rnd(0.3, 0.8))            // noise dots
  const glyphs = [...text], hs = glyphs.map(() => rnd(40, 50)), adv = hs.map((h) => h * 0.55 + rnd(8, 14))
  const total = adv.reduce((a, b) => a + b, 0), scale = Math.min(1, (W - 16) / total)
  let x = (W - total * scale) / 2 + rnd(-4, 4)
  glyphs.forEach((g, i) => {
    const h = hs[i] * scale, w = h * 0.55, rot = rnd(-0.3, 0.3), c = Math.cos(rot), s = Math.sin(rot)
    const ox = x + w / 2, oy = H / 2 + rnd(-4, 4), col = ink(), r = rnd(1.4, 2.2)
    for (const line of GLYPHS[g]) stroke(m, line.map(([u, v]): [number, number] => {
      const px = (u - 0.5) * w, py = (v - 0.5) * h
      return [ox + px * c - py * s, oy + px * s + py * c]
    }), r, col)
    x += adv[i] * scale
  })
  for (let k = 0, n = 2 + randomInt(2); k < n; k++) {                                          // crossing lines
    const y0 = rnd(10, H - 10), y1 = rnd(10, H - 10)
    stroke(m, Array.from({ length: 12 }, (_, i): [number, number] => [(i / 11) * W, y0 + ((y1 - y0) * i) / 11 + rnd(-3, 3)]), rnd(0.7, 1.3), ink(), 0.8)
  }
  noise(m, 10); warp(m, rnd(1.5, 2.5)); blur(m)
  return png(m)
}

export async function makeCaptcha(): Promise<Captcha> {
  const id = randomBytes(16).toString('base64url')
  const target = KINDS[randomInt(KINDS.length)]
  const others = KINDS.filter((k) => k !== target)
  const count = 2 + randomInt(3)                                    // 2..4 targets
  const kinds = shuffle([...Array(count).fill(target), ...Array.from({ length: 9 - count }, () => others[randomInt(others.length)])])
  const answer = kinds.flatMap((k, i) => (k === target ? [i] : [])).join(',')
  const [task, result] = mathTask()

  const grid = mac(id, `grid:${answer}`)
  await claims.set(loadedSettings() as Settings | undefined, `captcha:${id}`, JSON.stringify({ grid: grid.toString('hex'), text: mac(id, `text:${result}`).toString('hex') }), TTL_MS)
  return { id, image: drawGrid(kinds), prompt: `Select all the ${PLURAL[target]}`, mathImage: drawMath(task), answerHash: grid.toString('hex') }
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
