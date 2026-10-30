'use client'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { describeWidget, widgetFragment } from '../runtime/fragment.js'
import { getRegistry, type Entry } from '../runtime/registry.client.js'
import { widgetId } from './ids.js'
import { WidgetScopeCtx, chainOf, useScopeValue } from './scope.js'
import type { AgentState, Json, Widget, WidgetSpec } from './types.js'

const dev = () => process.env.NODE_ENV !== 'production'

function assertJson(v: unknown, path: string): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return
  if (Array.isArray(v)) return v.forEach((x, i) => assertJson(x, `${path}[${i}]`))
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v)) assertJson(x, `${path}.${k}`)
    return
  }
  throw new Error(`tvine: widget state must be JSON; ${path} is ${typeof v === 'object' ? v.constructor?.name ?? 'object' : typeof v}`)
}

// registry-client.md lifecycle. Render is pure (id from scope + spec); the registry is written
// only in layout effects with a per-mount token, so StrictMode and discarded concurrent renders
// leave exactly the committed widgets. Nothing in here subscribes to the registry.
export function useWidget<S extends Json>(spec: WidgetSpec<S>): Widget {
  const outer = useScopeValue()
  const parent = outer.id
  const chain = chainOf(outer)
  const id = widgetId(parent, spec)
  if (dev()) {
    if (!spec.label) throw new Error(`tvine: widget ${id} needs a non-empty label`)
    if (spec.state !== undefined) assertJson(spec.state, `${id} state`)
  }

  // Frozen to the first render: SSR and hydration produce byte-identical fragments; later state never re-renders it.
  const [embed] = useState(() => widgetFragment(describeWidget(id, parent, spec), { personal: spec.personal }))
  const [agent, setAgent] = useState<AgentState>({ active: false })

  const entry = useRef<Entry | null>(null)
  const el = useRef<HTMLElement | null>(null)

  const ref = useCallback((node: HTMLElement | null) => {
    el.current = node
    if (entry.current) entry.current.el = node
  }, [])

  useLayoutEffect(() => {
    let active = false
    const e: Entry = {
      id, parent, kind: spec.kind, spec, el: el.current, token: Symbol(id), order: 0, chain,
      agent: (a) => {
        setAgent((prev) => (prev.active === a.active && prev.verb === a.verb ? prev : a))
        if (a.active !== active) { active = a.active; e.spec.hooks?.onAgentFocus?.(active) }
      },
    }
    entry.current = e
    const off = getRegistry().register(e)
    return () => { off(); if (entry.current === e) entry.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-register only when the address changes; spec follows via update()
  }, [id, parent])

  // Every commit: pointer write of the latest spec (controls are read at call time).
  useLayoutEffect(() => {
    if (entry.current) { entry.current.chain = chain; getRegistry().update(id, entry.current.token, spec) }
  })

  const key = chain.join('\n')
  const Scope = useMemo(() => {
    const value = { id, up: chain }
    return function Scope({ children }: { children: ReactNode }) {
      return <WidgetScopeCtx.Provider value={value}>{children}</WidgetScopeCtx.Provider>
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chain by value (key)
  }, [id, key])

  return {
    id, ref, embed, Scope, agent,
    props: { 'data-tvine-id': id, ...(agent.active && { 'data-agent-active': '' as const, ...(agent.verb && { 'data-agent-verb': agent.verb }) }) },
  }
}
