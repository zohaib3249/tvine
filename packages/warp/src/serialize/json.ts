import type { Event } from '../core/types.js'
import { errText, isEmpty, snapshotOf } from './envelope.js'

// Events arrive already shaped + cleaned (envelope.render). One flat object: head, status, snapshot.
export function toJson(events: Event[], head: string): string {
  const o: Record<string, unknown> = {}
  for (const e of events) {
    if (e.kind === 'ok') { o.status = 'ok'; o.action = e.action; if (!isEmpty(e.result)) o.result = e.result }
    else if (e.kind === 'err') { o.status = 'err'; o.code = e.code; if (e.field) o.field = e.field; o.message = errText(e) }
    else if (e.kind === 'goto') { o.status = 'goto'; o.url = e.url }
    else if (e.kind === 'update') { o.status = 'update'; o.source = e.source }
    else if (e.kind === 'patch') { o.status = 'patch'; o.changes = e.changes }
  }
  const s = events.map(snapshotOf).find(Boolean)
  if (s) {
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
