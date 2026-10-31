import type { Event, Rev, Settings, Sid, Snapshot } from '../core/types.js'
import { recoveryOf } from '../core/errors.js'
import { toJson } from './json.js'
import { toNotation, bare, cell, quote } from './notation.js'
import { disclose, expand, kindOfWidget, level, toTree, type Shaped } from '../shape/disclose.js'
import { HINT2 } from '../shape/notation.js'

export type Format = 'json' | 'notation'
export type Shapers = Record<string /* node type */, (data: Record<string, unknown>) => Record<string, unknown>>
export interface Ctx { sid: Sid; rev: Rev; page: string }
export type ViewOpt = 'auto' | 'full' | 'L1' | 'L0'
export interface ExpandOpt { id: string; offset?: number; limit?: number }
// view: forced level (default auto: full → L1 → L0 by budget); expand: L2 of one node (unknown id → L0 map)
export interface RenderOpts { ctx: Ctx; shapers?: Shapers; view?: ViewOpt; expand?: ExpandOpt }

const HINT = '#hint @type @id=node id then cols, rows=values in order, "-"=null | ! act name(p:type) bind=<b> -> POST {action,params,sid,bind}'

// json → the `"#tvine":"..."` first member; notation → line 1 (+ hint line for snapshots).
// view: v2 shapes only (`view=full|L1|L0|L2`); hint: v1 → the v1 hint, a string → that hint line.
export function head(s: { sid: Sid; rev: Rev; page: string; format: Format; hint?: boolean | string; view?: string }): string {
  const v = s.view ? ` view=${s.view}` : ''
  if (s.format === 'json') return `"#tvine":${JSON.stringify(`1 sid=${s.sid} rev=${s.rev} page=${s.page}${v}`)}`
  const l1 = `#tvine/1 sid=${s.sid} rev=${s.rev} page=${bare(s.page)}${v}`
  const h = s.hint === true ? HINT : s.hint
  return h ? `${l1}\n${h}` : l1
}

type ErrEvent = Extract<Event, { kind: 'err' }>

// message + static recovery hint + what only this Event knows (field, valid actions).
export function errText(e: ErrEvent): string {
  let t = `${e.message} — ${recoveryOf(e)}`
  if (e.field) t += ` (field ${e.field})`
  if (e.code === 'unknown_action' && e.snapshot) {
    const ids = [...new Set(e.snapshot.nodes.flatMap(n => n.actions.map(a => a.id)))]
    if (ids.length) t += ` Valid actions: ${ids.join(', ')}`
  }
  return t
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0)
}

// Notation status line. (json builds the same facts as fields in json.ts)
export function status(e: Event): string {
  switch (e.kind) {
    case 'ok': return `ok ${cell(e.action)}` + (isEmpty(clean(e.result)) ? '' : ` ${cell(clean(e.result))}`)
    case 'err': return `err ${e.code}${e.field ? ` ${cell(e.field)}` : ''} ${quote(errText(e))}`
    case 'goto': return `goto ${cell(e.url)}`
    case 'update': return `update ${e.source}` + (e.job ? ` ${cell(clean(e.job))}` : '')
    case 'patch': return `patch ${cell(clean(e.changes))}`
    default: throw new Error('status: not a status event')
  }
}

// Drop null/undefined/[] recursively (omit-empty).
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter(x => !isEmpty(x)).map(clean)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!isEmpty(x)) o[k] = clean(x)
    return o
  }
  return v
}

// Snapshot with shapers applied to node.data (and v2 entity widgets' data, by kind) and empties removed.
export function shape(s: Snapshot, shapers?: Shapers): Snapshot {
  const out: Snapshot = {
    ...s,
    nodes: s.nodes.map(n => {
      const f = shapers?.[n.type]
      return { ...n, data: clean(f ? f(n.data) : n.data) as Record<string, unknown> }
    }),
  }
  if (s.widgets) out.widgets = s.widgets.map(w => {
    const f = shapers?.[kindOfWidget(w)]
    return w.data ? { ...w, data: clean(f ? f(w.data) : w.data) as Record<string, unknown> } : w
  })
  return out
}

export function snapshotOf(e: Event): Snapshot | undefined {
  return e.kind === 'snapshot' ? e.snapshot : e.kind === 'err' ? e.snapshot : undefined
}

// ctx is REQUIRED (sid/rev/page): ok/goto/err events carry none; snapshot values win over it.
// head + status? + body. sid/rev come from the first snapshot/update in `events`; `ctx` fills the
// gaps (ok/goto/err carry no sid themselves).
// settings.agent.shape: 'v2' (default) → the snapshot goes through the shaper (budgeted view); 'v1' → today's bytes.
export function render(events: Event[], format: Format, settings: Settings, { ctx, shapers, view, expand: x }: RenderOpts): string {
  const evs: Event[] = events.map(e => {
    if (e.kind === 'snapshot') return { kind: 'snapshot', snapshot: shape(e.snapshot, shapers) }
    if (e.kind === 'err' && e.snapshot) return { ...e, snapshot: shape(e.snapshot, shapers) }
    return e
  })
  const snap = evs.map(snapshotOf).find(Boolean)
  const upd = evs.find((e): e is Extract<Event, { kind: 'update' }> => e.kind === 'update')
  const patch = evs.find((e): e is Extract<Event, { kind: 'patch' }> => e.kind === 'patch')
  const sid = snap?.sid ?? upd?.sid ?? ctx?.sid
  const rev = snap?.rev ?? upd?.rev ?? patch?.rev ?? ctx?.rev
  if (sid === undefined || rev === undefined) throw new Error('render: no sid/rev in events or ctx')
  const agent = settings?.agent
  const tree = snap && agent?.shape !== 'v1' ? toTree(snap, { headless: true }) : undefined
  const rowsL1 = agent?.rowsL1 ?? 10
  // allowL0: the L0 map is reachable now that expand exists (W2 ruling lifted by W5)
  const v2: Shaped | undefined = tree && (x
    ? expand(tree, x.id, x) ?? level(tree, 'L0', rowsL1)
    : disclose(tree, { budget: agent?.budget ?? 1500, rowsL1, view, allowL0: true }))
  const hint = format === 'notation' && !!snap && (!v2 || (v2.nodes.some(n => n.rows || n.actions || n.links) || !!v2.links) && HINT2)
  const h = head({ sid, rev, page: snap?.page ?? ctx.page, format, hint, view: v2?.view })
  return format === 'json' ? toJson(evs, h, v2) : toNotation(evs, h, v2)
}
