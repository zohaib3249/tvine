import { getOverlay } from './overlay.js'

// security.md §Remote agents: the trusted chrome's Allow prompt and Connect (pairing code) box. They live in
// the overlay's CLOSED shadow root on the top layer: page CSS can't cover them, page script and agent controls
// can't reach their buttons. A button acts only on a TRUSTED pointer/keyboard click (isTrusted) that comes at
// least armMs after the prompt appeared (anti-clickjack: a button that pops up under a moving cursor doesn't
// count). The agent's name is its own claim: always shown with "(unverified)", as text, never as HTML.

// `trusted` is a seam for tests only (jsdom can't make a trusted event); not exported from the package.
export const CHROME = { armMs: 500, trusted: (e: Event) => e.isTrusted }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\0-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) || 'Agent'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = globalThis.document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (cls) e.className = cls
  return e
}

// One button, armed: ignores synthetic clicks and clicks before the arm delay.
function button(text: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = el('button', text, cls)
  b.type = 'button'
  const armedAt = Date.now() + CHROME.armMs
  b.addEventListener('click', (e) => { if (CHROME.trusted(e) && Date.now() >= armedAt) onClick() })
  return b
}

// "<name> (unverified) wants to control this tab — Allow / Deny". Newer replaces older. Returns close().
export function showRequest(o: { name: string; onAllow: () => void; onDeny: () => void }): () => void {
  const p = getOverlay().panel()!
  let open = true
  const close = () => { if (open) { open = false; getOverlay().panel(false) } }
  const msg = el('p')
  msg.append(el('b', clean(o.name, 40)), ' (unverified) wants to control this tab. It will act as you; you can press Stop at any time.')
  const row = el('div', undefined, 'row')
  row.append(button('Deny', () => { close(); o.onDeny() }), button('Allow', () => { close(); o.onAllow() }, 'go'))
  p.append(msg, row)
  return close
}

// Fallback: the human types the code the agent gave them. `submit` answers an error text, or null on success.
export function showConnect(submit: (code: string) => Promise<string | null>): () => void {
  const p = getOverlay().panel()!
  let open = true
  const close = () => { if (open) { open = false; getOverlay().panel(false) } }
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
