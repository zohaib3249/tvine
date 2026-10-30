import type { Event, Rev, Settings, Sid, Snapshot } from '../core/types.js'
import { recovery } from '../core/errors.js'
import { toJson } from './json.js'
import { toNotation, bare, cell, quote } from './notation.js'

export type Format = 'json' | 'notation'
export type Shapers = Record<string /* node type */, (data: Record<string, unknown>) => Record<string, unknown>>
export interface Ctx { sid: Sid; rev: Rev; page?: string }

const HINT = '#hint @type cols=schema, rows=values in order, "-"=null | ! act name(p:type) -> POST {action,params,sid}'

// json → the `"#tvine":"..."` first member; notation → line 1 (+ hint line for snapshots).
export function head(s: { sid: Sid; rev: Rev; page: string; format: Format; hint?: boolean }): string {
  if (s.format === 'json') return `"#tvine":${JSON.stringify(`1 sid=${s.sid} rev=${s.rev} page=${s.page}`)}`
  const l1 = `#tvine/1 sid=${s.sid} rev=${s.rev} page=${bare(s.page)}`
  return s.hint ? `${l1}\n${HINT}` : l1
}

type ErrEvent = Extract<Event, { kind: 'err' }>

// message + static recovery hint + what only this Event knows (field, valid actions).
export function errText(e: ErrEvent): string {
  let t = `${e.message} — ${recovery[e.code]}`
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
    case 'ok': return `ok ${cell(e.action)}` + (isEmpty(e.result) ? '' : ` ${cell(e.result)}`)
    case 'err': return `err ${e.code}${e.field ? ` ${cell(e.field)}` : ''} ${quote(errText(e))}`
    case 'goto': return `goto ${cell(e.url)}`
    case 'update': return `update ${e.source}`
    case 'patch': return `patch ${cell(e.changes)}`
    default: throw new Error('status: not a status event')
  }
}

// Drop null/undefined/[] recursively (omit-empty).
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!isEmpty(x)) o[k] = clean(x)
    return o
  }
  return v
}

// Snapshot with shapers applied to node.data and empties removed from it.
export function shape(s: Snapshot, shapers?: Shapers): Snapshot {
  return {
    ...s,
    nodes: s.nodes.map(n => {
      const f = shapers?.[n.type]
      return { ...n, data: clean(f ? f(n.data) : n.data) as Record<string, unknown> }
    }),
  }
}

export function snapshotOf(e: Event): Snapshot | undefined {
  return e.kind === 'snapshot' ? e.snapshot : e.kind === 'err' ? e.snapshot : undefined
}

// head + status? + body. sid/rev come from the first snapshot/update in `events`; `ctx` fills the
// gaps (ok/goto/err carry no sid themselves).
export function render(events: Event[], format: Format, _settings: Settings, shapers?: Shapers, ctx?: Ctx): string {
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
  const h = head({ sid, rev, page: snap?.page ?? ctx?.page ?? '', format, hint: format === 'notation' && !!snap })
  return format === 'json' ? toJson(evs, h) : toNotation(evs, h)
}
