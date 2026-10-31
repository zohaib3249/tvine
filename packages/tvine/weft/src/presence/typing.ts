// agent-presence.md §Mechanics: typing = the native value setter + one `input` event per char, so
// React's value tracker sees a change and onChange runs for each char; a final `change` event.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// The widget's ref may be a wrapper: type into the field inside it.
export function fieldOf(el: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!el) return null
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el
  return el.querySelector('input, textarea')
}

export async function typeInto(el: Element | null, text: string, o: { cps?: number; instant?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const f = fieldOf(el)
  if (!f) return
  const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  const put = (v: string) => { set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })) }
  f.focus?.({ preventScroll: true })
  if (o.instant || text.length > 200) put(text)
  else {
    if (f.value !== '') put('')
    const gap = 1000 / Math.min(o.cps ?? 40, 40)   // security.md: ≤ 40 cps animated
    for (let i = 1; i <= text.length; i++) {
      if (o.signal?.aborted) break
      put(text.slice(0, i))
      if (i < text.length) await sleep(gap)
    }
  }
  f.dispatchEvent(new Event('change', { bubbles: true }))
}
