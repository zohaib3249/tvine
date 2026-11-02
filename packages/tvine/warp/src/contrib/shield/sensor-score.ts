// Pure scoring of a client SensorReport (L4 environment + L5 behaviour) → 1 (bot) .. 99 (human).
// Start at 99 and subtract the penalty of every signal that fires; each fired signal adds a reason.
//
// Weights (penalty points):
//   webdriver                    60   navigator.webdriver is true: automation said so itself
//   headless:ua-headless         50   "HeadlessChrome" in the UA
//   headless:<other marker>      15   each other marker from sensor.js (no-chrome-obj, no-plugins, no-langs,
//                                     perm-mismatch, zero-outer, no-dpr), capped at 45 together
//   webgl-soft                   35   software GL renderer (SwiftShader / llvmpipe): typical of headless/VMs
//   no-webgl                      5
//   no-canvas / no-audio          5   each (blocked or broken APIs)
//   bad-screen                   15   screen or window reported as 0x0
//   no-langs                     10   empty navigator.languages (only when not already a headless marker)
//   no-behaviour                 25   checkbox/captcha level with no pointer, key, scroll or touch input at all
//   straight-path                20   20+ pointer moves with direction entropy < 0.5 bit (scripted line)
//   too-fast                     20   checkbox/captcha level answered < 800 ms after the page loaded
// The PoW level is invisible, so missing behaviour there is not penalised.
import type { SensorReport } from './types.js'

export type { SensorReport }

const W = { webdriver: 60, uaHeadless: 50, marker: 15, markerCap: 45, webglSoft: 35, noWebgl: 5, noHash: 5, badScreen: 15, noLangs: 10, noBehaviour: 25, straight: 20, tooFast: 20 }

export function scoreSensor(r: SensorReport, level: 'pow' | 'checkbox' | 'captcha' = 'pow'): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let pen = 0
  const hit = (reason: string, w: number) => { reasons.push(reason); pen += w }

  if (r.webdriver) hit('webdriver', W.webdriver)
  const markers = Array.isArray(r.headless) ? r.headless : []
  let markerPen = 0
  for (const m of markers) {
    if (m === 'ua-headless') hit('headless:ua-headless', W.uaHeadless)
    else { reasons.push(`headless:${m}`); markerPen += W.marker }
  }
  pen += Math.min(markerPen, W.markerCap)

  if (!r.webgl) hit('no-webgl', W.noWebgl)
  else if (r.webgl.startsWith('soft')) hit('webgl-soft', W.webglSoft)
  if (!r.canvas) hit('no-canvas', W.noHash)
  if (!r.audio) hit('no-audio', W.noHash)
  if (/(^|\|)0x0(\||$)/.test(r.screen ?? '')) hit('bad-screen', W.badScreen)
  if ((!r.langs || r.langs.length === 0) && !markers.includes('no-langs')) hit('no-langs', W.noLangs)

  const b = r.behaviour ?? { moves: 0, entropy: 0, scrolls: 0, keys: 0, dwellMs: 0 }
  if (level !== 'pow') {
    if (b.moves + b.keys + b.scrolls === 0 && !(r.touch > 0)) hit('no-behaviour', W.noBehaviour)
    if (b.dwellMs < 800) hit('too-fast', W.tooFast)
  }
  if (b.moves >= 20 && b.entropy < 0.5) hit('straight-path', W.straight)

  return { score: Math.max(1, Math.min(99, 99 - pen)), reasons }
}
