import type { ReactElement } from 'react'
import type { Json, WidgetSpec } from '../widget/types.js'
import { listed } from '../widget/vocabulary.js'

// snapshot-format.md §fragment: the Weft → Warp contract for v2 widgets.
// {"v":2,"k":"w","w":{id,p,kind,label,state,ctl:{name:{kind,in,h}},e,…}} — descriptors only, no functions.

export interface WidgetDescriptor {
  id: string; p?: string; kind: string; label: string; sum?: string
  state?: Json
  ctl?: Record<string, { kind: string; in?: object; h?: object }>
  e?: string; data?: Record<string, unknown>
  summary?: string[]; detail?: string[]; collapsed?: true
  ho?: string                       // humanOnly reason (HumanOnly): no controls are listed
}

// Sensitive state never leaves the widget: only whether it is filled.
export function agentState(spec: WidgetSpec): Json | undefined {
  const s = spec.state
  if (!spec.sensitive || s === undefined) return s
  const v = s && typeof s === 'object' && !Array.isArray(s) && 'value' in s ? s.value : s
  return { filled: v != null && v !== '' && v !== false }
}

export function describeWidget(id: string, parent: string, spec: WidgetSpec): WidgetDescriptor {
  const ctl = spec.humanOnly ? {} : Object.fromEntries(listed(spec).map(([n, c]) => [n, { kind: c.kind, ...(c.params && { in: c.params }), ...(c.headless && { h: c.headless }) }]))
  const hidden = new Set(spec.hidden)
  const data = spec.data && Object.fromEntries(Object.entries(spec.data).filter(([k]) => !hidden.has(k)))
  const state = agentState(spec)
  return {
    id, ...(parent && { p: parent }), kind: spec.kind, label: spec.label,
    ...(spec.sum && { sum: spec.sum }),
    ...(spec.humanOnly && { ho: spec.humanOnly }),
    ...(state !== undefined && { state }),
    ...(Object.keys(ctl).length && { ctl }),
    ...(spec.entity && { e: spec.entity }),
    ...(data && Object.keys(data).length && { data }),
    ...(spec.summary && { summary: spec.summary }),
    ...(spec.detail && { detail: spec.detail }),
    ...(spec.collapsed && { collapsed: true as const }),
  }
}

// `<` escaped so no string can close the tag. personal/live sit beside `w`, as v1 flags do.
export function widgetFragment(w: WidgetDescriptor, flags: { personal?: boolean } = {}): ReactElement {
  const json = JSON.stringify({ v: 2, k: 'w', ...(flags.personal && { personal: true }), w }).replace(/</g, '\\u003c')
  return <script type="text/tvine" dangerouslySetInnerHTML={{ __html: json }} />
}
