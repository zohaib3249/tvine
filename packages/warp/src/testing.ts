// @tvine/warp/testing — Django-TestClient-style helpers (docs/design/conventions/testing.md).
// agentClient speaks real HTTP bytes to server.server over an in-memory socket pair: no port, the
// same parser, handler chain and envelope a real agent gets.
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { duplexPair } from 'node:stream'
import type { ActionId, Event, Session, Sid, Snapshot } from './core/types.js'
import { createAgentServer, type AgentServer, type AgentServerOptions } from './server.js'

export interface AgentClient {
  get(route: string): Promise<{ status: number; snapshot: Snapshot | undefined; sid: Sid; raw: string }>
  // sid: default = the last one seen; cmdId: default = a fresh one; node: which node's action ref
  // to copy the bind from when the action sits on several nodes with different binds
  do(route: string, action: ActionId, params?: object, opts?: { sid?: Sid; cmdId?: string; node?: string }):
    Promise<{ status: number; events: Event[]; sid: Sid; raw: string }>
  session(sid: Sid): Session | undefined   // white-box assertion access
}

export function agentClient(server: AgentServer): AgentClient {
  const pages = new Map<string, Snapshot>()   // route → last snapshot (binds come from here)
  let sid = ''
  const headers = { [server.ctx.settings.header]: '1', accept: 'application/tvine+json' }

  async function send(method: string, route: string, body?: string) {
    const r = await call(server, method, route, body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, body)
    const d = decode(r.raw)
    if (d.sid) sid = d.sid
    const snap = d.events.map((e) => (e.kind === 'snapshot' ? e.snapshot : e.kind === 'err' ? e.snapshot : undefined)).find(Boolean)
    if (snap) pages.set(route, snap)
    return { ...r, ...d, snapshot: snap }
  }

  return {
    async get(route) {
      const { status, snapshot, sid, raw } = await send('GET', route)
      return { status, snapshot, sid, raw }
    },
    async do(route, action, params = {}, opts = {}) {
      const nodes = (pages.get(route)?.nodes ?? []).filter((n) => opts.node === undefined || n.id === opts.node)
      const refs = nodes.flatMap((n) => n.actions.filter((a) => a.id === action).map((a) => ({ node: n.id, bind: a.bind })))
      if (new Set(refs.map((r) => r.bind)).size > 1) {
        throw new Error(`${action} is on several nodes (${refs.map((r) => r.node).join(', ')}): pass opts.node`)
      }
      const bind = refs[0]?.bind || undefined
      const s = opts.sid ?? (sid || undefined)
      const { status, events, sid: got, raw } = await send('POST', route, JSON.stringify({ action, params, sid: s, bind, cmdId: opts.cmdId ?? randomUUID() }))
      return { status, events, sid: got, raw }
    },
    session: (s) => server.ctx.sessions.peek({ sid: s }),
  }
}

// One request over an in-memory socket pair handed to the (possibly non-listening) node server.
function call(server: AgentServer, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; raw: string }> {
  return new Promise((ok, bad) => {
    const [client, peer] = duplexPair()
    server.server.emit('connection', peer)
    const req = request({ method, path, headers: { ...headers, connection: 'close' }, createConnection: () => client }, async (res) => {
      let raw = ''
      for await (const c of res) raw += c
      ok({ status: res.statusCode!, raw })
    })
    req.on('error', bad)
    req.end(body)
  })
}

// The JSON envelope (serialize/json.ts) back into events: status event + snapshot (inside err, as dispatch emits it).
function decode(raw: string): { sid: Sid; events: Event[] } {
  let o: Record<string, any>
  try { o = JSON.parse(raw) } catch { return { sid: '', events: [] } }   // 304 / 308: no body
  const [, sid = '', rev = '0'] = /sid=(\S*) rev=(\d+)/.exec(String(o['#tvine'])) ?? []
  const snapshot: Snapshot | undefined = 'page' in o ? {
    page: o.page, title: o.title ?? '', sid, rev: Number(rev),
    nodes: (o.nodes ?? []).map((n: any) => ({ id: n.id, type: n.type ?? n.kind, data: n.data ?? {}, actions: n.actions ?? [] })),
    links: o.links ?? [],
  } : undefined
  const events: Event[] = []
  if (o.status === 'ok') events.push({ kind: 'ok', action: o.action, ...('result' in o && { result: o.result }) })
  if (o.status === 'goto') events.push({ kind: 'goto', url: o.url })
  if (o.status === 'err') events.push({ kind: 'err', code: o.code, message: o.message, ...(o.field && { field: o.field }), ...(snapshot && { snapshot }) })
  else if (snapshot) events.push({ kind: 'snapshot', snapshot })
  return { sid, events }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const scrub = (v: unknown): unknown =>
  typeof v === 'string' ? (ISO.test(v) ? '<timestamp>' : v)
  : Array.isArray(v) ? v.map(scrub)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
  : v

// sid, rev, signed binds and ISO timestamps in node data → fixed placeholders; the agent surface stays.
export function normalize(s: Snapshot): Snapshot {
  return {
    ...s, sid: '<sid>', rev: 0,
    nodes: s.nodes.map((n) => ({ ...n, data: scrub(n.data) as Record<string, unknown>, actions: n.actions.map((a) => ({ ...a, bind: a.bind && '<bind>' })) })),
  }
}

// For CI snapshot regression: expect(await snapshotOf('/product/1', { server })).toMatchSnapshot().
// Without `server`, boots one from the remaining options (listening only when a frontend must render) and closes it.
export async function snapshotOf(route: string, opts: { server?: AgentServer } & AgentServerOptions = {}): Promise<Snapshot> {
  const { server, ...o } = opts
  const s = server ?? (await createAgentServer(o))
  try {
    if (!server && o.frontend && !o.frontend.origin) await s.listen(0)
    const r = await agentClient(s).get(route)
    if (!r.snapshot) throw new Error(`no snapshot for ${route} (status ${r.status}): ${r.raw}`)
    return normalize(r.snapshot)
  } finally {
    if (!server) await s.close()
  }
}
