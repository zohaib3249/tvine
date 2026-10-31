import type { ActionRef, ErrCode, Event, JobUpdate, Link, Node, Snapshot } from '../core/types.js'
import { RECOVERIES } from '../core/errors.js'
import { snapshotOf, status } from './envelope.js'
import { NUM, MONEY, str, cell, quote, actionLine, notationBody } from '../shape/notation.js'
import type { Shaped } from '../shape/disclose.js'
export { cell, quote, bare } from '../shape/notation.js'

function body(s: Snapshot): string[] {
  const out: string[] = []
  const t = s.title
  if (t) out.push('= ' + (/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(t) && t[0] !== '"' ? t : quote(t)))
  for (let i = 0; i < s.nodes.length;) {
    const type = s.nodes[i].type
    let j = i
    while (j < s.nodes.length && s.nodes[j].type === type) j++
    const run = s.nodes.slice(i, j)
    const cols = [...new Set(run.flatMap(n => Object.keys(n.data)))]
    const hdr = `@${str(type)} @id${cols.map(c => ' ' + str(c)).join('')}`   // @id: the node id (a data `id` col stays `id`)
    run.forEach((n, r) => {
      if (r % 25 === 0) out.push(hdr)   // header repeat: positional recall degrades with distance
      out.push([str(n.id), ...cols.map(c => cell(n.data[c]))].join(' '))
      for (const a of n.actions) {
        out.push(actionLine(a))
      }
    })
    i = j
  }
  for (const l of s.links) out.push(`> ${str(l.id)} ${str(l.href)} ${str(l.label)}${l.params ? ' ' + cell(l.params) : ''}`)
  return out
}

// `head` already holds line 1 (+ hint). Statuses first, then the (single) snapshot body:
// `v2` = the shaped snapshot (settings.agent.shape v2), else the v1 body.
export function toNotation(events: Event[], head: string, v2?: Shaped): string {
  const lines = [head]
  for (const e of events) if (e.kind !== 'snapshot') lines.push(status(e))
  const s = events.map(snapshotOf).find(Boolean)
  if (v2) lines.push(...notationBody(v2))
  else if (s) lines.push(...body(s))
  return lines.join('\n')
}

// ---- parse (inverse; eval harness) ----

function dec(t: string): unknown {
  if (t === '-') return undefined
  if (t === 'true') return true
  if (t === 'false') return false
  if (NUM.test(t)) return Number(t)
  const m = MONEY.exec(t)
  return m ? { value: Number(m[1]), currency: m[3] } : t
}

function scan(line: string): unknown[] {
  const out: unknown[] = []
  const n = line.length
  let i = 0
  while (i < n) {
    if (line[i] === ' ') { i++; continue }
    let j = i
    if (line[i] === '"') {
      for (j++; j < n && line[j] !== '"'; j += line[j] === '\\' ? 2 : 1);
      j++
      out.push(JSON.parse(line.slice(i, j)))
    } else if (line[i] === '{' || line[i] === '[') {
      let d = 0, inStr = false
      for (; j < n; j++) {
        const c = line[j]
        if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false }
        else if (c === '"') inStr = true
        else if (c === '{' || c === '[') d++
        else if (c === '}' || c === ']') { if (--d === 0) { j++; break } }
      }
      out.push(JSON.parse(line.slice(i, j)))
    } else {
      while (j < n && line[j] !== ' ') j++
      out.push(dec(line.slice(i, j)))
    }
    i = j
  }
  return out
}

const TOK = /"(?:[^"\\]|\\.)*"|[^\s"(),:?]+/y
function parseAction(line: string): ActionRef {
  let p = 2
  const bad = () => new Error('parse: bad action line: ' + line)
  const next = () => {
    TOK.lastIndex = p
    const m = TOK.exec(line)
    if (!m) throw bad()
    p = TOK.lastIndex
    return m[0][0] === '"' ? (JSON.parse(m[0]) as string) : m[0]
  }
  const eat = (c: string) => { if (line[p] !== c) throw bad(); p++ }
  const id = next()
  eat('(')
  const params: ActionRef['params'] = []
  while (line[p] !== ')') {
    if (params.length) eat(',')
    const name = next()
    const required = line[p] !== '?'
    if (!required) p++
    eat(':')
    params.push({ name, type: next(), required })
  }
  p++
  if (!line.startsWith(' bind=', p)) throw bad()
  return { id, params, bind: tail(line.slice(p + 6)) }
}

const tail = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s)

export function parseCommandResult(text: string): Event[] {
  const lines = text.split('\n')
  const h = /^#tvine\/1 sid=(\S+) rev=(\d+) page=(.*)$/.exec(lines[0] ?? '')
  if (!h) throw new Error('parse: missing #tvine/1 head')
  const sid = h[1], rev = Number(h[2]), page = tail(h[3])
  const events: Event[] = []
  const snap: Snapshot = { page, title: '', sid, rev, nodes: [], links: [] }
  let hasSnap = false, inBody = false, cols: string[] = [], type = ''
  for (const line of lines.slice(1)) {
    if (!line) continue
    if (line.startsWith('#hint')) { hasSnap = true; continue }
    const st = !inBody && /^(ok|err|goto|update|patch)( |$)/.exec(line)
    if (st) {
      const t = scan(line)
      switch (st[1]) {
        case 'ok': events.push({ kind: 'ok', action: String(t[1]), ...(t[2] !== undefined ? { result: t[2] } : {}) }); break
        case 'err': {
          const code = String(t[1]) as ErrCode
          const full = String(t[t.length - 1])
          const cut = Math.max(...RECOVERIES.map(r => full.lastIndexOf(` \u2014 ${r}`)))
          const e: Extract<Event, { kind: 'err' }> = { kind: 'err', code, message: cut >= 0 ? full.slice(0, cut) : full }
          if (t.length === 4) e.field = String(t[2])
          events.push(e); break
        }
        case 'goto': events.push({ kind: 'goto', url: String(t[1]) }); break
        case 'update': events.push({ kind: 'update', rev, sid, source: t[1] as 'human' | 'agent', ...(t[2] !== undefined ? { job: t[2] as JobUpdate } : {}) }); break
        default: events.push({ kind: 'patch', rev, changes: t[1] })
      }
      continue
    }
    hasSnap = true
    if (line[0] === '=') { inBody = true; snap.title = tail(line.slice(2).trim()) }
    else if (line[0] === '@') {
      inBody = true
      const t = scan(line.slice(1)).map(String)
      type = t[0]; cols = t.slice(2)
    } else if (line[0] === '!') {
      const a = parseAction(line)
      snap.nodes[snap.nodes.length - 1].actions.push(a)
    } else if (line[0] === '>') {
      const t = scan(line.slice(1))
      const l: Link = { id: String(t[0]), href: String(t[1]), label: String(t[2]) }
      if (t[3] !== undefined) l.params = t[3] as string[]
      snap.links.push(l)
    } else {
      const t = scan(line)
      if (t.length !== cols.length + 1) throw new Error(`parse: row arity ${t.length} != ${cols.length + 1}: ${line}`)
      const data: Record<string, unknown> = {}
      cols.forEach((c, i) => { if (t[i + 1] !== undefined) data[c] = t[i + 1] })
      const n: Node = { id: String(t[0]), type, data, actions: [] }
      snap.nodes.push(n)
    }
  }
  if (hasSnap) {
    const e = events.find(x => x.kind === 'err')
    if (e && e.kind === 'err') e.snapshot = snap
    else events.push({ kind: 'snapshot', snapshot: snap })
  }
  return events
}
