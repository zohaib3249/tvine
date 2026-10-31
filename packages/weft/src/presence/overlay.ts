import type { ActionKind, Presence, PresenceOptions } from '../widget/types.js'
import { typeInto } from './typing.js'

// agent-presence.md + security.md §Presence can't be spoofed: one runtime-created host on <html>,
// CLOSED shadow root, top layer (popover=manual). Page script can't reach the shadow root; page CSS
// can't restyle it (`:host … !important` wins over outer !important); removing the host re-attaches it.
// All text goes through textContent and is composed here from verb + declared label: never page/agent HTML.

// Theme = the CSS custom properties below (they inherit into the shadow root; nothing else does).
// The pill's font, z-index, text/button colors are fixed and its theme color sits on an opaque base: a theme can't make Stop invisible.
const CSS = `
:host{all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;
  margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;
  pointer-events:none!important;visibility:visible!important;opacity:1!important;transform:none!important;clip-path:none!important;filter:none!important;
  z-index:2147483647!important;
  --c:var(--tvine-agent-color,#7c3aed);--fg:var(--tvine-agent-contrast,#fff);--d:var(--tvine-agent-danger-color,#dc2626);
  font:var(--tvine-agent-font,500 12px/1.2 system-ui)}
.ring{position:fixed;box-sizing:border-box;border:var(--tvine-agent-ring,2px) solid var(--c);border-radius:var(--tvine-agent-radius,6px);transition:opacity .6s}
.label{position:fixed;padding:3px 6px;border-radius:4px;background:var(--c);color:var(--fg);white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
.danger .ring{border-color:var(--d)} .danger.label,.danger .label{background:var(--d)}
.cursor{position:fixed;left:0;top:0;width:var(--tvine-agent-cursor-size,20px);height:var(--tvine-agent-cursor-size,20px)}
.cursor svg{width:100%;height:100%;fill:var(--c);stroke:var(--fg);stroke-width:1.5}
.reduced *{transition:none!important}
.pill{font:600 12px/1.2 system-ui!important;z-index:2147483647!important;position:fixed;right:16px;bottom:16px;display:flex!important;align-items:center;gap:8px;min-width:160px;min-height:32px;padding:6px 8px 6px 12px;
  border-radius:999px;background:linear-gradient(var(--c),var(--c)),#7c3aed;color:#fff;text-shadow:0 0 2px #000;outline:2px solid #fff;
  opacity:1!important;visibility:visible!important;pointer-events:auto!important;box-shadow:0 2px 8px #0008}
.panel{font:500 13px/1.4 system-ui!important;z-index:2147483647!important;position:fixed;right:16px;bottom:60px;box-sizing:border-box;width:min(340px,calc(100vw - 32px));padding:12px;border-radius:10px;
  background:#fff;color:#111;outline:2px solid var(--c);box-shadow:0 4px 16px #0006;opacity:1!important;visibility:visible!important;pointer-events:auto!important}
.panel p{margin:0 0 10px} .panel b{font-weight:700} .panel .row{display:flex;gap:8px;justify-content:flex-end}
.panel button{all:unset;font:600 13px/1.2 system-ui!important;cursor:pointer;padding:6px 12px;border-radius:6px;background:#eee;color:#111}
.panel button.go{background:#7c3aed;color:#fff} .panel button:focus-visible{outline:2px solid #111}
.panel input{font:600 15px/1.2 ui-monospace,monospace!important;letter-spacing:2px;width:100%;box-sizing:border-box;margin:0 0 10px;padding:6px 8px;border:1px solid #999;border-radius:6px;color:#111;background:#fff}
.pill button{all:unset;font:600 12px/1.2 system-ui!important;cursor:pointer;padding:4px 10px;border-radius:999px;background:#fff;color:#111;text-shadow:none;font-weight:600}
[hidden]{display:none!important}
`
const CURSOR = '<svg viewBox="0 0 20 20"><path d="M2 2l6 16 2.5-6.5L17 9z"/></svg>'   // static, runtime-owned

const PAST: Partial<Record<ActionKind, string>> = {
  click: 'clicked', input: 'typed into', clear: 'cleared', select: 'selected in', toggle: 'toggled', set: 'set',
  open: 'opened', close: 'closed', submit: 'submitted', navigate: 'went to', scroll: 'scrolled', focus: 'focused', move: 'moved', upload: 'uploaded to',
}
export const POINTED: ReadonlySet<ActionKind> = new Set(['click', 'select', 'toggle', 'open'])

const clean = (s: string, max: number) => s.replace(/[\0-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "").slice(0, max)
export const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export interface Act { verb: ActionKind; label: string; control: string; danger?: boolean; options?: false | PresenceOptions }

export class Overlay {
  private host: HTMLElement | null = null
  private root!: ShadowRoot
  private wrap!: HTMLElement
  private ring!: HTMLElement
  private label!: HTMLElement
  private cursor!: HTMLElement
  private pill!: HTMLElement
  private panelEl!: HTMLElement
  private pillText!: HTMLElement
  private pillBtn!: HTMLButtonElement
  private onPill: (() => void) | null = null
  private target: Element | null = null
  private last = { x: -1, y: -1 }
  private fade: ReturnType<typeof setTimeout> | undefined
  private watch: MutationObserver | null = null
  private ro: ResizeObserver | null = null
  options: PresenceOptions = {}
  enabled = true                                  // <WeftRoot presence={false}>: never hides the pill

  private ensure(): void {
    const doc = globalThis.document
    if (!doc) return
    if (!this.host) {
      // A page-defined custom element of our tag name would run page code on our host: use a div then.
      const tag = globalThis.customElements?.get('tvine-presence') ? 'div' : 'tvine-presence'
      const host = doc.createElement(tag)
      this.root = host.attachShadow({ mode: 'closed' })
      const style = doc.createElement('style')
      style.textContent = CSS
      this.wrap = doc.createElement('div')
      this.ring = this.part('ring'); this.label = this.part('label'); this.cursor = this.part('cursor')
      this.cursor.innerHTML = CURSOR
      this.pill = this.part('pill')
      this.pill.setAttribute('role', 'status')
      this.pillText = doc.createElement('span')
      this.pillBtn = doc.createElement('button')
      this.pillBtn.type = 'button'
      // Only a real human click: page/agent script can't dispatch a trusted event.
      this.pillBtn.addEventListener('click', (e) => { if (e.isTrusted) this.onPill?.() })
      this.pill.append(this.pillText, this.pillBtn)
      this.panelEl = this.part('panel')
      this.panelEl.setAttribute('role', 'dialog')
      this.root.append(style, this.wrap)
      this.host = host
    }
    if (!this.host.isConnected) doc.documentElement.append(this.host)
    this.top()
    if (!this.watch && typeof MutationObserver !== 'undefined') {
      // Page removed the host while something is shown → put it back.
      this.watch = new MutationObserver(() => { if (this.host && !this.host.isConnected && this.showing()) this.ensure() })
      this.watch.observe(doc.documentElement, { childList: true })
    }
  }

  private part(cls: string): HTMLElement {
    const el = globalThis.document.createElement('div')
    el.className = cls
    el.hidden = true
    this.wrap.append(el)
    return el
  }

  // Re-promote to the top layer so it stays above page dialogs opened after us.
  raise(): void { if (this.host?.isConnected) this.top() }

  private top(): void {
    const h = this.host as HTMLElement & { showPopover?: () => void; hidePopover?: () => void }
    if (!h.showPopover) return
    h.setAttribute('popover', 'manual')
    try { h.hidePopover?.(); h.showPopover() } catch { /* not connected / unsupported */ }
  }

  private showing(): boolean { return !!this.host && (!this.pill.hidden || !this.ring.hidden || !this.panelEl.hidden) }

  // The trusted chrome's prompt box (presence/chrome.ts): emptied and shown; null hides it. Inside the closed
  // shadow root, so page script and agent controls can't reach its buttons.
  panel(show = true): HTMLElement | null {
    if (!show) { if (this.host) { this.panelEl.hidden = true; this.panelEl.replaceChildren() } return null }
    this.ensure()
    this.panelEl.replaceChildren()
    this.panelEl.hidden = false
    return this.panelEl
  }

  get reduced(): boolean { return reducedMotion() }

  // The Stop pill: shown whenever an agent controls the tab — ignores `enabled` and themes.
  setPill(state: { text: string; button: string; onClick: () => void } | null): void {
    if (!state) { if (this.host) this.pill.hidden = true; this.onPill = null; return }
    this.ensure()
    this.pillText.textContent = clean(state.text, 80)
    this.pillBtn.textContent = state.button
    this.onPill = state.onClick
    this.pill.hidden = false
  }

  // Runtime-composed label (i18n via options.labels, which is app code, not agent input).
  labelFor(a: Act): string {
    const o = this.opts(a)
    const label = clean(a.label, 60)
    if (o?.labels) return clean(o.labels({ verb: a.verb, label, control: a.control }), 80)
    return a.verb === 'input' ? `Agent: typing… ${label}` : `Agent ${PAST[a.verb] ?? a.verb} ${label}`
  }

  private opts(a: Act): PresenceOptions | null {
    if (!this.enabled || a.options === false) return null
    return { ...this.options, ...a.options }
  }

  // Outline + label on the target while a control runs; returns `done` (fades after holdMs).
  begin(el: Element | null, a: Act): () => void {
    const o = this.opts(a)
    if (!o || !el) return () => {}
    this.ensure()
    clearTimeout(this.fade)
    this.target = el
    this.wrap.classList.toggle('reduced', this.reduced)
    this.wrap.classList.toggle('danger', !!a.danger)
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: this.reduced ? 'auto' : 'smooth' })
    this.label.textContent = this.labelFor(a)
    this.ring.hidden = o.outline === false
    this.label.hidden = o.label === false
    this.ring.style.opacity = '1'
    this.track(true)
    this.place()
    return () => {
      const hold = this.reduced ? 0 : (o.holdMs ?? 600)
      if (!this.reduced) this.ring.style.opacity = '0'
      this.fade = setTimeout(() => {
        if (this.target !== el) return
        this.ring.hidden = this.label.hidden = this.cursor.hidden = true
        this.target = null
        this.track(false)
      }, hold)
    }
  }

  private place = (): void => {
    if (!this.target) return
    const r = this.target.getBoundingClientRect()
    Object.assign(this.ring.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` })
    Object.assign(this.label.style, { left: `${r.left - 3}px`, top: `${Math.max(0, r.top - 24)}px` })
  }

  // ResizeObserver + one passive scroll listener, only while an outline is up.
  private track(on: boolean): void {
    if (on && !this.ro) {
      addEventListener('scroll', this.place, { passive: true, capture: true })
      addEventListener('resize', this.place, { passive: true })
      if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(this.place); if (this.target) this.ro.observe(this.target) }
      else this.ro = {} as ResizeObserver
    } else if (!on && this.ro) {
      removeEventListener('scroll', this.place, { capture: true })
      removeEventListener('resize', this.place)
      this.ro.disconnect?.()
      this.ro = null
    }
  }

  // Cursor: glides (400 ms) to the target centre and pulses; reduced motion → appears there, no animation.
  async point(el: Element | null, a: Act): Promise<void> {
    const o = this.opts(a)
    if (!o || o.cursor === false || !el) return
    this.ensure()
    const r = el.getBoundingClientRect()
    const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    const c = this.cursor
    c.hidden = false
    const from = this.last.x < 0 ? to : this.last
    this.last = to
    c.style.transform = `translate(${to.x}px, ${to.y}px)`
    if (this.reduced || typeof c.animate !== 'function') return
    // not awaited: the glide runs alongside the step (agent steps never wait for animations)
    c.animate(
      [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px) scale(.8)` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
      { duration: 400, easing: 'ease-out' },
    ).finished.catch(() => {})
  }

  // ctx.presence for one step: point / type / say. `say` is reserved: labels come only from the runtime.
  presenceFor(a: Act, signal?: AbortSignal): Presence {
    // The executor points before click-like controls and the control may point again: once per element per step.
    let pointed: Element | null = null
    return {
      point: async (el) => { if (el && el === pointed) return; pointed = el; await this.point(el, a) },
      type: async (el, text) => {
        const o = this.opts(a)
        await typeInto(el, String(text), { signal, cps: o?.cps, instant: !o || this.reduced || o.typing === 'instant' })
      },
      say: () => {},
    }
  }
}

// One per tab, module-private: no global key, so page script can't reach it and hide Stop.
// ponytail: duplicated weft bundles would each get their own overlay; dedupe the bundle if that happens.
let one: Overlay | undefined
export const getOverlay = (): Overlay => (one ??= new Overlay())
// A page dialog/drawer just opened: put the presence host back above it (only if it exists).
export const raisePresence = (): void => { one?.raise() }
