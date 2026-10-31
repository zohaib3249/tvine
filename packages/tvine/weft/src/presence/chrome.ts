import { getOverlay } from './overlay.js'

// security.md §Remote agents: the trusted chrome's Allow prompt and Connect (pairing code) box. They live in
// the overlay's CLOSED shadow root on the top layer: page CSS can't cover them, page script and agent controls
// can't reach their buttons. A button acts only on a TRUSTED pointer/keyboard click (isTrusted) that comes at
// least armMs after the prompt appeared (anti-clickjack: a button that pops up under a moving cursor doesn't
// count). The agent's name is its own claim: always shown with "(unverified)", as text, never as HTML.

// `trusted`/`hasFocus` are seams for tests only (jsdom can't make a trusted event); not exported from the package.
export const CHROME = { armMs: 500, trusted: (e: Event) => e.isTrusted, hasFocus: () => globalThis.document.hasFocus() }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\0-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').slice(0, max) || 'Agent'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = globalThis.document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (cls) e.className = cls
  return e
}

// Arming for one prompt. A press counts only when it is trusted, the page is visible and focused, and the
// prompt has been armed for armMs; focus/visibility changes RE-arm it (a window that just came to the front, or
// a tab switched to under the cursor, can't be clicked through). The press must START on the button itself
// (trusted pointerdown, or Enter/Space keydown) after arming: a click that began elsewhere doesn't count.
function armed() {
  let at = Date.now() + CHROME.armMs
  const rearm = () => { at = Date.now() + CHROME.armMs }
  const doc = globalThis.document
  globalThis.addEventListener?.('focus', rearm)
  globalThis.addEventListener?.('blur', rearm)
  doc.addEventListener('visibilitychange', rearm)
  const ready = () => Date.now() >= at && doc.visibilityState !== 'hidden' && CHROME.hasFocus()
  const button = (text: string, onClick: () => void, cls?: string): HTMLButtonElement => {
    const b = el('button', text, cls)
    b.type = 'button'
    let pressed = false
    b.addEventListener('pointerdown', (e) => { pressed = CHROME.trusted(e) && ready() })
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pressed = CHROME.trusted(e) && ready() })
    b.addEventListener('click', (e) => { const ok = pressed && CHROME.trusted(e) && ready(); pressed = false; if (ok) onClick() })
    return b
  }
  const dispose = () => {
    globalThis.removeEventListener?.('focus', rearm)
    globalThis.removeEventListener?.('blur', rearm)
    doc.removeEventListener('visibilitychange', rearm)
  }
  return { button, dispose }
}

// 'Unverified agent "<name>" wants to control this tab — Allow / Deny' (the label comes BEFORE the name, so a
// name can't pose as the sentence). Newer replaces older. Returns close().
export function showRequest(o: { name: string; onAllow: () => void; onDeny: () => void }): () => void {
  const p = getOverlay().panel()!
  const { button, dispose } = armed()
  let open = true
  const close = () => { if (open) { open = false; dispose(); getOverlay().panel(false) } }
  const msg = el('p')
  msg.append('Unverified agent "', el('b', clean(o.name, 40)), '" wants to control this tab. It will act as you; you can press Stop at any time.')
  const row = el('div', undefined, 'row')
  row.append(button('Deny', () => { close(); o.onDeny() }), button('Allow', () => { close(); o.onAllow() }, 'go'))
  p.append(msg, row)
  return close
}

// Fallback: the human types the code the agent gave them. `submit` answers an error text, or null on success.
export function showConnect(submit: (code: string) => Promise<string | null>): () => void {
  const p = getOverlay().panel()!
  const { button, dispose } = armed()
  let open = true
  const close = () => { if (open) { open = false; dispose(); getOverlay().panel(false) } }
  const msg = el('p', 'Connect an agent: type the code it gave you.')
  const input = el('input')
  input.maxLength = 12
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Agent code')
  const note = el('p')
  note.hidden = true
  const row = el('div', undefined, 'row')
  row.append(button('Cancel', close), button('Connect', () => {
    void submit(input.value).then((err) => {
      if (err === null) return close()
      note.textContent = clean(err, 120)
      note.hidden = false
    })
  }, 'go'))
  p.append(msg, input, note, row)
  return close
}
