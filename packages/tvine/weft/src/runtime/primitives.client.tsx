'use client'
import type { ReactNode } from 'react'
import { WeftError } from '../widget/hooks.js'
import { useWidget } from '../widget/useWidget.js'
import type { ActionHandle, Control, Json, ParamSpec } from '../widget/types.js'

// compatibility-v1.md: the client half of the v1 primitives. Server primitives keep emitting their v1
// fragments (headless truth, byte-identical); these register the same ids in the in-tab registry so
// agents can operate them through the UI. They render no v2 embed (it would collide with the v1 node).

const PTYPE: Record<string, ParamSpec['type']> = { string: 'string', number: 'number', boolean: 'boolean', enum: 'string' }

// One server action as a `submit` control: through the hooks (danger/attention from the handle), then
// ctx.run → dispatch. `agent:false` (denyAgents / mcp:false) → not listed, not callable.
// Bind-only params are already absent from handle.params (bindAction).
export function submitControl(h: ActionHandle): Control {
  return {
    kind: 'submit',
    enabled: h.agent,
    params: Object.fromEntries(h.params.map((p) => [p.name, { type: PTYPE[p.type] ?? 'json', ...(!p.required && { optional: true }) }])),
    headless: { params: h },
    run: async (args, ctx) => {
      const r = await ctx.run(h, args)
      if (!r.ok) throw new WeftError(r.code, r.message, undefined, r.field)
      return r as Json
    },
  }
}

// ponytail: submit goes straight through ctx.run with the given values (same dispatch as the human
// submit); it does not type into the visible fields first. Add fill + requestSubmit with presence (W4).
export function FormWidget({ seg, label, handle, children }: { seg: string; label: string; handle: ActionHandle | null; children?: ReactNode }) {
  const w = useWidget({ id: seg, kind: 'form', label, ...(handle ? { controls: { submit: submitControl(handle) } } : { disabled: true }) })
  return <w.Scope>{children}</w.Scope>
}

export function LinkWidget({ seg, label, href }: { seg: string; label: string; href: string }) {
  useWidget({ id: seg, kind: 'link', label, controls: { navigate: { kind: 'navigate', run: (_: unknown, ctx) => ctx.navigate(href) } } })
  return null
}
