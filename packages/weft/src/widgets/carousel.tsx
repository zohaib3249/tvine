'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { Control, ControlCtx, Json } from '../widget/types.js'
import { AutoOff, flag, inner, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/carousel.md: APG Carousel on a native CSS scroll-snap viewport. Every slide is SSR'd and its
// data is published, so a headless agent reads all slides with no control; the position is presentation,
// so set/next/prev/toggle have no headless map (in-tab only). Any manual move (human or agent, through the
// real buttons) stops autoplay; hover, focus and an acting agent pause it; reduced motion disables it.
// ponytail: flat `slides` instead of Carousel.Root/Viewport/Slide parts.
type C = Record<string, Control<any, any>>
type S = { index: number; count: number; playing?: boolean }
export type CarouselSlide = { key: string; label: string; content: ReactNode; data?: Json }
export type CarouselProps = {
  name: string; label: string; slides: CarouselSlide[]
  index?: number; defaultIndex?: number; onIndexChange?(i: number): void
  loop?: boolean; autoplay?: number
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'viewport' | 'slide' | 'prev' | 'next' | 'dot' | 'play', S>
}
type Inner = CarouselProps & { playing: boolean }

const useCarousel = defineWidget<Inner, S, C>({
  kind: 'carousel',
  state: (p) => ({ index: p.index ?? 0, count: p.slides.length, ...(p.autoplay && { playing: p.playing }) }),
  controls: ({ props: p, el }) => {
    const n = p.slides.length, i = p.index ?? 0
    const press = (ctx: ControlCtx, sel: string) => inner<HTMLButtonElement>(ctx, el(), sel).click()
    const c: C = {
      set: { kind: 'set', params: { index: { type: 'number', min: 0, max: Math.max(0, n - 1), step: 1 } },
        run: async (a: { index: number }, ctx) => press(ctx, `[data-part=dot][data-index="${a.index}"]`) },
    }
    if (p.loop || i < n - 1) c.next = { kind: 'set', run: async (_a, ctx) => press(ctx, '[data-part=next]') }
    if (p.loop || i > 0) c.prev = { kind: 'set', run: async (_a, ctx) => press(ctx, '[data-part=prev]') }
    if (p.autoplay) c.toggle = { kind: 'toggle', params: { on: { type: 'boolean', optional: true } },
      run: async (a: { on?: boolean }, ctx) => { if (a.on === undefined || a.on !== p.playing) press(ctx, '[data-part=play]') } }
    return c
  },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, data: { slides: p.slides.map((s) => s.data ?? s.label) } }),
})

export function Carousel(props: DefinedProps<CarouselProps, C>) {
  const { label, slides, index, defaultIndex, onIndexChange, loop, autoplay, disabled, className, slots } = props
  const n = slides.length
  const [i, setI] = useControllable<number>(index, defaultIndex ?? 0)
  const [playing, setPlaying] = useState(false)
  const [hold, setHold] = useState(false)
  const w = useCarousel({ ...props, index: i, playing })
  const s: S = { index: i, count: n, ...(autoplay && { playing }) }
  const view = useRef<HTMLDivElement>(null)
  const cur = useRef(i); cur.current = i
  const show = (x: number) => {
    const to = loop ? (x + n) % n : Math.max(0, Math.min(x, n - 1))
    if (to !== cur.current) { cur.current = to; setI(to); onIndexChange?.(to) }
  }
  const manual = (x: number) => { setPlaying(false); show(x) }

  useEffect(() => { if (autoplay && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setPlaying(true) }, [autoplay])
  useEffect(() => {
    if (!autoplay || !playing || hold || w.agent.active) return
    const t = setInterval(() => show(cur.current + 1 >= n ? 0 : cur.current + 1), autoplay)
    return () => clearInterval(t)
  })
  useEffect(() => {
    const v = view.current, slide = v?.children[i] as HTMLElement | undefined
    if (v && slide && Math.abs(v.scrollLeft - slide.offsetLeft) > 1) v.scrollTo?.({ left: slide.offsetLeft })
  }, [i])

  const btn = (part_: 'prev' | 'next' | 'play', text: string, on: () => void, extra: Record<string, unknown> = {}) =>
    part('button', { type: 'button', 'data-part': part_, disabled, onClick: on, ...extra }, slots?.[part_], s, text)
  return part('section', {
    ref: w.ref, ...w.props, 'data-tvine-widget': 'carousel', 'aria-roledescription': 'carousel', 'aria-label': label,
    'data-playing': flag(playing), 'data-disabled': flag(disabled), style: { '--carousel-index': i },
    onMouseEnter: () => setHold(true), onMouseLeave: () => setHold(false), onFocus: () => setHold(true), onBlur: () => setHold(false),
  }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {autoplay && btn('play', playing ? 'Stop slide rotation' : 'Start slide rotation', () => setPlaying(!playing), { 'aria-pressed': playing })}
      {btn('prev', 'Previous slide', () => manual(i - 1), { disabled: disabled || (!loop && i === 0) })}
      {btn('next', 'Next slide', () => manual(i + 1), { disabled: disabled || (!loop && i === n - 1) })}
    </AutoOff>
    {part('div', {
      ref: view, 'aria-live': playing ? 'off' : 'polite', style: { display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory' },
      onScrollEnd: (e: { currentTarget: HTMLDivElement }) => { const v = e.currentTarget; if (v.clientWidth) show(Math.round(v.scrollLeft / v.clientWidth)) },
    }, slots?.viewport, s, slides.map((sl, k) => part('div', {
      key: sl.key, role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${k + 1} of ${n}`, title: sl.label,
      'data-state': k === i ? 'active' : 'inactive', style: { flex: '0 0 100%', scrollSnapAlign: 'start' },
    }, slots?.slide, s, sl.content)))}
    <AutoOff><div role="group" aria-label="Choose slide">
      {slides.map((sl, k) => part('button', { key: sl.key, type: 'button', 'data-part': 'dot', 'data-index': k, 'aria-label': sl.label, 'aria-current': k === i || undefined, 'data-state': k === i ? 'active' : 'inactive', disabled, onClick: () => manual(k) }, slots?.dot, s))}
    </div></AutoOff>
  </>)
}
