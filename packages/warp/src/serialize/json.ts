import type { Event } from '../core/types.js'
import { clean, errText, isEmpty, snapshotOf } from './envelope.js'
import type { Shaped } from '../shape/disclose.js'

// Events arrive already shaped + cleaned (envelope.render). One flat object: head, status, snapshot.
// `v2` = the shaped snapshot (settings.agent.shape v2): its body replaces the v1 nodes/links.
export function toJson(events: Event[], head: string, v2?: Shaped): string {
  const o: Record<string, unknown> = {}
  for (const e of events) {
    if (e.kind === 'ok') { o.status = 'ok'; o.action = e.action; const r = clean(e.result); if (!isEmpty(r)) o.result = r }
    else if (e.kind === 'err') { o.status = 'err'; o.code = e.code; if (e.field) o.field = e.field; if (e.errors?.length) o.errors = e.errors; o.message = errText(e) }
    else if (e.kind === 'goto') { o.status = 'goto'; o.url = e.url }
    else if (e.kind === 'update') { o.status = 'update'; o.source = e.source; if (e.action) o.action = e.action; if (e.job) o.job = clean(e.job) }
    else if (e.kind === 'patch') { o.status = 'patch'; o.changes = clean(e.changes) }
  }
  const s = events.map(snapshotOf).find(Boolean)
  if (v2) { const { view: _, ...b } = v2; for (const [k, v] of Object.entries(b)) if (k === 'page' || (v !== '' && !isEmpty(v))) o[k] = v }
  else if (s) {
    o.page = s.page
    if (s.title) o.title = s.title
    if (s.nodes.length) o.nodes = s.nodes.map(n => ({
      id: n.id, type: n.type,
      ...(Object.keys(n.data).length ? { data: n.data } : {}),
      ...(n.actions.length ? { actions: n.actions } : {}),
    }))
    if (s.links.length) o.links = s.links
  }
  const body = JSON.stringify(o)
  return '{' + head + (body.length > 2 ? ',' + body.slice(1) : '}')
}
