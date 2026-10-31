'use client'
import { createElement, Fragment, Suspense, useLayoutEffect, type ReactNode } from 'react'
import { WeftError } from '../widget/hooks.js'
import { getRegistry } from './registry.client.js'

// navigation-spa.md: the in-tab agent view across client navigations. The registry follows
// mounts/unmounts on its own; this module adds the settle rule, agent `navigate` (client transition,
// same-site only), human/back-forward notices, and pending (still-streaming) regions.

export const navLimits = { quietMs: 100, capMs: 3_000, tickMs: 20 }

const loc = () => (globalThis as any).location as Location | undefined
export const currentPage = (): string => { const l = loc(); return l ? l.pathname + l.search : '' }

let lastChange = 0          // last registry/pending change (ms)
let pending = 0             // mounted <AgentSuspense> fallbacks
let popped = false          // a back/forward happened since the agent last looked
let agentPage: string | undefined   // the page the agent's last answer described
let lastUrl: string | undefined     // the URL settle last observed
const touch = () => { lastChange = Date.now() }

// Started by <WeftRoot> (survives client navigations: it lives in the root layout).
let watchers = 0, unwatch: (() => void) | undefined
export function watchNav(): () => void {
  if (!watchers++) {
    const off = getRegistry().subscribe(touch)
    const pop = () => { popped = true; touch() }
    globalThis.addEventListener?.('popstate', pop)
    unwatch = () => { off(); globalThis.removeEventListener?.('popstate', pop) }
  }
  let done = false
  return () => { if (done) return; done = true; if (!--watchers) { unwatch?.(); unwatch = undefined } }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Settle rule: wait until the URL equals `target` (when given), then until the registry has been
// quiet for quietMs and no pending region is mounted; capped at capMs. Returns the pending count at
// the end (> 0 → the agent should re-read).
// urlWaitMs: give up early when the URL has not reached `target` by then (a control that may not navigate).
export async function settle(target?: string, signal?: AbortSignal, urlWaitMs = navLimits.capMs): Promise<{ pending: number }> {
  const end = Date.now() + navLimits.capMs, urlEnd = Date.now() + urlWaitMs
  let urlAt = target === undefined ? 0 : -1
  while (Date.now() < end && !signal?.aborted && (urlAt >= 0 || Date.now() < urlEnd)) {
    // A URL we have not seen yet counts as a change: its route's widgets may still be mounting.
    const now = currentPage()
    if (now !== lastUrl) { lastUrl = now; touch() }
    if (urlAt < 0 && now === target) urlAt = Date.now()
    if (urlAt >= 0 && !pending && Date.now() - Math.max(lastChange, urlAt) >= navLimits.quietMs) break
    await sleep(navLimits.tickMs)
  }
  return { pending }
}

// The one check for an agent navigate target — same rules as Warp's siteRedirect: http(s), this
// site's origin. Returns the path; anything else is refused as forbidden.
export function siteHref(href: string): string {
  const l = loc()
  let u: URL
  try { u = new URL(href, l?.href) } catch { throw new WeftError('invalid_param', 'href is not a valid URL', undefined, 'href') }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !l || u.origin !== l.origin) {
    throw new WeftError('domain', 'forbidden: navigate to another site', 'forbidden')
  }
  return u.pathname + u.search + u.hash
}

// Agent navigate: a client transition through Next's App Router when present (window.next.router,
// the same instance useRouter() returns), else a plain document load. Resolves after settle.
// ponytail: no client-side route table check (Warp's route()); an unknown same-site path gets Next's
// 404 page, which the agent then reads. Add a route list to WeftRoot if that proves noisy.
// `go` replaces the push: an auto <a> clicks the real link (app onClick + Next <Link> prefetch/transition).
export async function agentNavigate(href: string, signal?: AbortSignal, go?: () => unknown): Promise<{ page: string; pending: number }> {
  const path = siteHref(href)
  const target = path.split('#')[0]!
  const router = (globalThis as any).next?.router
  if (go) await go()
  else if (typeof router?.push === 'function') router.push(path)
  else loc()!.assign(path)
  const { pending: p } = await settle(target, signal)
  return { page: currentPage(), pending: p }
}

// The notice for the agent's next result when the page moved under it (human click, back/forward).
export function navNotice(): string | undefined {
  const now = currentPage()
  if (agentPage === undefined || agentPage === now) return undefined
  return `human ${popped ? 'went back/forward' : 'navigated'} ${agentPage} → ${now}`
}
// Call after answering the agent: its view is now the current page.
export function markSeen(): void { agentPage = currentPage(); popped = false }

export function resetNav(): void { agentPage = lastUrl = undefined; popped = false; pending = 0; lastChange = 0 }

// A Suspense boundary the agent view knows about: while its fallback shows, the snapshot says
// `pending` and the settle rule waits (up to the cap) for it to resolve.
function Pending(): null {
  useLayoutEffect(() => { pending++; touch(); return () => { pending--; touch() } }, [])
  return null
}
export function AgentSuspense({ fallback, children }: { fallback?: ReactNode; children?: ReactNode }) {
  return createElement(Suspense, { fallback: createElement(Fragment, null, createElement(Pending), fallback) }, children)
}
export const pendingRegions = (): number => pending
