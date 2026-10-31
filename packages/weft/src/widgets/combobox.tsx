'use client'
import { useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { agentNavigate } from '../runtime/nav.js'
import { AutoOff, flag, headlessOf, inner, part, typeText, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/combobox.md: APG combobox (input + listbox). Async `items` get an AbortSignal and a sequence
// number: only the newest request may write suggestions, so a slow old response never overwrites a newer one.
// ponytail: no debounce (each keystroke aborts the previous load); add one when a backend needs it.
type C = Record<string, Control<any, any>>
type Opt = { value: string; label: string }
type S = { query: string; value: string | null; open: boolean; suggestions: Opt[]; loading: boolean }
export type ComboboxProps<T = any> = {
  name: string; label: string
  items: T[] | ((q: string, signal: AbortSignal) => Promise<T[]>)
  itemValue(t: T): string; itemLabel(t: T): string
  query?: string; defaultQuery?: string; onQueryChange?(q: string): void
  value?: string | null; defaultValue?: string | null; onValueChange?(v: string | null): void
  freeText?: boolean                       // search box: any text is a value; submit() runs
  onSubmit?(q: string): void
  url?: string                             // headless + submit: ?<url>=<query> (search page)
  suggest?: ActionHandle                   // headless suggestions via a readOnly server action (param `q`)
  placeholder?: string
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'input' | 'content' | 'item' | 'empty' | 'loading', S>
}
type Internal = ComboboxProps & { s: S; load: { current: Promise<Opt[]> } }

const MAX = 10
const WAIT_MS = 3000

const useCombobox = defineWidget<Internal, S, C>({
  kind: 'combobox',
  state: (p) => p.s,
  controls: ({ props: p, el }) => {
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLInputElement>(ctx, el(), 'input')
    const c: C = {
      search: { kind: 'input', params: { text: { type: 'string' } }, run: async (a: { text: string }, ctx) => {
        await typeText(ctx, field(ctx), a.text)
        let t: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<Opt[]>((res) => { t = setTimeout(() => res([]), WAIT_MS) })
        try { return await Promise.race([p.load.current, late]) } finally { clearTimeout(t) }
      } },
      choose: { kind: 'select', params: { value: { type: 'string', ...(!p.freeText && { enum: p.s.suggestions.map((o) => o.value) }) } },
        run: async (a: { value: string }, ctx) => {
          const opt = el()?.querySelector<HTMLElement>(`[role=option][data-value="${CSS.escape(a.value)}"]`)
          if (opt) return void opt.click()
          await typeText(ctx, field(ctx), a.value)   // freeText: the typed text is the value
        } },
      clear: { kind: 'clear', run: async (_a, ctx) => { await typeText(ctx, field(ctx), '') } },
    }
    if (p.freeText) c.submit = { kind: 'submit', run: async (_a, ctx) => { field(ctx).form ? field(ctx).form!.requestSubmit() : await submit(p, p.s.query, ctx.signal) } }
    return c
  },
  headless: (p) => {
    const h = headlessOf({ url: p.url, action: p.suggest, name: 'q' }, 'any')
    return h ? { search: h, ...('url' in h && { submit: h }) } : {}
  },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

async function submit(p: ComboboxProps, q: string, signal?: AbortSignal) {
  p.onSubmit?.(q)
  if (p.url && typeof location !== 'undefined') {
    const u = new URLSearchParams(location.search); u.set(p.url, q)
    await agentNavigate(`?${u}`, signal ?? new AbortController().signal)
  }
}

export function Combobox<T>(props: DefinedProps<ComboboxProps<T>, C>) {
  const { name, label, items, itemValue, itemLabel, query, defaultQuery, onQueryChange, value, defaultValue, onValueChange,
    freeText, placeholder, disabled, className, slots } = props
  const [q, setQ] = useControllable<string>(query, defaultQuery ?? '')
  const [v, setV] = useControllable<string | null>(value, defaultValue ?? null)
  const [sugg, setSugg] = useState<Opt[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [hi, setHi] = useState(-1)
  const seq = useRef(0)
  const ctrl = useRef<AbortController | null>(null)
  const load = useRef<Promise<Opt[]>>(Promise.resolve([]))
  const id = useId()

  const toOpt = (t: T): Opt => ({ value: itemValue(t), label: itemLabel(t) })
  const fetchFor = (text: string) => {
    ctrl.current?.abort()
    const n = ++seq.current
    if (typeof items !== 'function') {
      const low = text.toLowerCase(), out = items.map(toOpt).filter((o) => o.label.toLowerCase().includes(low)).slice(0, MAX)
      setSugg(out); setLoading(false)
      return (load.current = Promise.resolve(out))
    }
    const ac = (ctrl.current = new AbortController())
    setLoading(true)
    return (load.current = items(text, ac.signal).then(
      (r) => { const out = r.map(toOpt).slice(0, MAX); if (n === seq.current) { setSugg(out); setLoading(false) } return out },
      () => { if (n === seq.current) setLoading(false); return [] },
    ).then((out) => (n === seq.current ? out : load.current)))   // superseded: answer with the newest load
  }
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value
    setQ(text); onQueryChange?.(text); setOpen(true); setHi(-1)
    if (freeText) { setV(text || null); onValueChange?.(text || null) }
    void fetchFor(text)
  }
  const pick = (o: Opt) => {
    setQ(o.label); onQueryChange?.(o.label); setOpen(false)
    if (o.value !== v) { setV(o.value); onValueChange?.(o.value) }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!open) { setOpen(true); void fetchFor(q) }
      const n = sugg.length; if (n) setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter') {
      if (open && sugg[hi]) { e.preventDefault(); pick(sugg[hi]!) } else if (freeText && !e.currentTarget.form) { e.preventDefault(); void submit(props, q) }
    } else if (e.key === 'Escape') setOpen(false)
  }

  const s: S = { query: q, value: v, open, suggestions: sugg, loading }
  const w = useCombobox({ ...props, s, load } as Internal)
  return part('div', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'combobox', 'data-state': open ? 'open' : 'closed',
    'data-loading': flag(loading), 'data-disabled': flag(disabled),
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: `${id}-i` }, slots?.label, s, label)}
      {part('input', {
        id: `${id}-i`, name, type: freeText ? 'search' : 'text', role: 'combobox', value: q, placeholder, disabled, autoComplete: 'off',
        'aria-expanded': open, 'aria-controls': `${id}-l`, 'aria-autocomplete': 'list',
        'aria-activedescendant': open && sugg[hi] ? `${id}-o-${hi}` : undefined,
        onChange: onInput, onKeyDown: onKey, onBlur: () => setOpen(false),
      }, slots?.input, s)}
      {part('ul', { id: `${id}-l`, role: 'listbox', 'aria-label': label, hidden: !open, 'aria-busy': loading || undefined }, slots?.content, s, <>
        {sugg.map((o, i) => part('li', {
          key: o.value, id: `${id}-o-${i}`, role: 'option', 'data-value': o.value, 'aria-selected': o.value === v,
          'data-highlighted': flag(i === hi), onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(), onClick: () => pick(o),
        }, slots?.item, s, o.label))}
        {loading && part('li', { role: 'presentation' }, slots?.loading, s, 'Loading…')}
        {!loading && !sugg.length && part('li', { role: 'presentation' }, slots?.empty, s, 'No results')}
      </>)}
    </AutoOff>
  </>)
}
