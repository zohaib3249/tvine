// Overlay helpers shared by dialog/drawer/popover/menu (W9c).
// Modal open: every sibling along the path to <body> gets `inert`, so the human can't reach the
// background and W3's domOff/autoExcluded leaves it out of the agent view. Returns the undo.
export function inertOutside(el: HTMLElement): () => void {
  const done: Element[] = []
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    for (const s of n.parentElement?.children ?? []) if (s !== n && !s.hasAttribute('inert')) { s.setAttribute('inert', ''); done.push(s) }
  }
  return () => { for (const s of done) s.removeAttribute('inert') }
}

// Native top layer where available (popover API); jsdom/old browsers fall back to the attribute.
export function showPopover(el: HTMLElement | null, on: boolean): void {
  if (!el) return
  const p = el as HTMLElement & { showPopover?: () => void; hidePopover?: () => void }
  try { on ? p.showPopover?.() : p.hidePopover?.() } catch { /* already in that state */ }
}
