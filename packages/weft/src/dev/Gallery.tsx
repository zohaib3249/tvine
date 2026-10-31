'use client'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { isAuto, autoExcluded } from '../jsx/AutoEl.js'
import { describeWidget } from '../runtime/fragment.js'
import { execWatchers, type ExecSeen } from '../runtime/exec.js'
import { getRegistry, type RegistryNode } from '../runtime/registry.client.js'
import { newId, pageTools, withNav } from '../runtime/webmcp.js'
import type { ActionHandle, HeadlessMap, Json, ParamSpec } from '../widget/types.js'
import { signature } from '../widget/vocabulary.js'

// core/widget-gallery.md: "admin can see all widgets". DEV ONLY: WeftRoot imports this module behind a
// `process.env.NODE_ENV !== 'production'` branch, so production bundles never contain it (test/gallery.test.tsx
// bundles WeftRoot with NODE_ENV=production and checks). Two consumers, one tree:
//  - the in-app overlay (Alt+Shift+W): this page's widgets, the built-in catalog, "try it as agent";
//  - the inspector's Widgets tab: when this page is framed (the `tvine inspect` page pane), the tree and the
//    agent commands run here are POSTed to the dev server (/tvine/dev/widgets, loopback + dev only).
// Every value shown is what an agent may see: state through describeWidget (sensitive → {filled}), no bind tokens.

export interface DevControl { name: string; kind: string; sig: string; params?: Record<string, ParamSpec>; headless: string; agentOff?: true }
export interface DevNode {
  id: string; kind: string; label: string
  state?: Json; data?: Record<string, unknown>; sensitive?: true
  auto?: true                    // auto-registered plain HTML (jsx runtime), else declared with useWidget
  agentHidden?: true             // agents don't see it now (behind a modal / disabled auto element)
  hooks?: true                   // has onAgentAction/afterAgentAction hooks
  controls: DevControl[]
  children: DevNode[]
}

// The built-in catalog (@tvine/weft/widgets): component → widget kind.
export const BUILTINS: readonly { name: string; kind: string }[] = [
  ['Input', 'input'], ['Textarea', 'textarea'], ['Select', 'select'], ['Checkbox', 'checkbox'], ['CheckboxGroup', 'checkbox'],
  ['RadioGroup', 'radio'], ['Switch', 'switch'], ['Slider', 'slider'], ['Quantity', 'quantity'], ['Rating', 'rating'],
  ['Dialog', 'dialog'], ['Drawer', 'drawer'], ['Menu', 'menu'], ['ContextMenu', 'context-menu'], ['Popover', 'popover'],
  ['Tooltip', 'tooltip'], ['Toaster', 'toast'], ['Tabs', 'tabs'], ['Accordion', 'accordion'], ['Button', 'button'],
  ['Link', 'link'], ['Pagination', 'pagination'], ['Stepper', 'stepper'], ['Combobox', 'combobox'], ['DatePicker', 'date'],
  ['FileUpload', 'file'], ['Swatch', 'radio'], ['ColorPicker', 'color'], ['Table', 'table'], ['Card', 'card'],
  ['CartBadge', 'cart-badge'], ['Carousel', 'carousel'], ['SortableList', 'list'], ['Tree', 'tree'],
].map(([name, kind]) => ({ name: name!, kind: kind! }))

// Where an agent without the tab gets this control (headless-parity.md); never the bind token.
function headlessOf(h: HeadlessMap | undefined): string {
  if (!h) return 'in-tab only'
  if ('url' in h) return `url ?${h.url}`
  if ('rendered' in h) return 'rendered'
  if ('session' in h) return `session ${h.session}`
  return `action ${(h.params as ActionHandle).id}${h.field ? ` .${h.field}` : ''}`
}

// The live control tree, as the gallery and the inspector show it.
export function devTree(): DevNode[] {
  const node = (n: RegistryNode, parent: string): DevNode => {
    const spec = n.spec!
    const d = describeWidget(n.id, parent, spec)
    const controls = Object.entries(d.ctl ?? {}).map(([name, c]): DevControl => {
      const h = c.h as HeadlessMap | undefined
      const params = c.in as Record<string, ParamSpec> | undefined
      return {
        name, kind: c.kind, sig: signature(name, { kind: c.kind as never, params }), headless: headlessOf(h),
        ...(params && { params }),
        ...(h && 'params' in h && h.params.agent === false && { agentOff: true as const }),
      }
    })
    return {
      id: n.id, kind: n.kind, label: spec.label,
      ...(d.state !== undefined && { state: d.state }),
      ...(d.data && { data: d.data }),
      ...(spec.sensitive && { sensitive: true as const }),
      ...(isAuto(spec) && { auto: true as const }),
      ...((autoExcluded(spec) || n.el?.closest('[inert]')) && { agentHidden: true as const }),
      ...(spec.hooks && { hooks: true as const }),
      controls,
      children: kids(n),
    }
  }
  const kids = (n: RegistryNode): DevNode[] => n.children.filter((c) => c.spec).map((c) => node(c, n.id))
  return kids(getRegistry().tree())
}

// "Try it as agent": exactly the WebMCP `ui` tool's path (settle, executor, hooks/veto, presence, result shape),
// marked via:'inspector', source:'gallery' so app hooks can tell. Stop still blocks it.
const tools = () => pageTools('inspector', undefined, 'gallery')
export function tryIt(cmd: { target: string; control: string; args?: Record<string, unknown>; cmdId?: string }): Promise<unknown> {
  return withNav(() => tools().ui({ ...cmd, cmdId: cmd.cmdId ?? newId() }))
}

// ---- inspector feed: only from a framed page (the inspector's page pane) on a loopback dev server --------------
const DEV_PATH = '/tvine/dev/widgets'
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])
const feedOn = () => {
  const w = globalThis as unknown as Window
  try { return w.top !== w.self && LOCAL.has(w.location.hostname) } catch { return false }
}

// An agent command as one row. Args come pre-masked from the executor (ExecSeen.steps), decided while each widget
// was still mounted.
export function agentRow(e: ExecSeen): Record<string, unknown> {
  return {
    kind: 'agent', via: e.via, ...(e.source && { source: e.source }), ms: e.ms,
    steps: e.steps.slice(0, 20),
    ok: !e.out.error, ...(e.out.error && { code: e.out.error.code, message: e.out.error.message }),
  }
}

function startFeed(): () => void {
  if (!feedOn()) return () => {}
  // stable across reloads of this frame (sessionStorage is per frame), so the inspector's pinned tab survives a reload
  let tab = newId()
  try { const s = globalThis.sessionStorage, k = 'tvine.dev.tab'; tab = s.getItem(k) ?? (s.setItem(k, tab), tab) } catch { /* private mode: per mount */ }
  let dead = false, timer: ReturnType<typeof setTimeout> | undefined
  const post = (row: Record<string, unknown>) => {
    if (dead) return
    const l = globalThis.location
    void fetch(DEV_PATH, {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-tvine-dev': '1' },
      body: JSON.stringify({ ...row, tab, page: l.pathname + l.search }),
    }).then((r) => { if (r.status === 404 || r.status === 403) dead = true }, () => { dead = true })   // not a warp dev server
  }
  const tree = () => { clearTimeout(timer); timer = setTimeout(() => post({ kind: 'widgets', tree: devTree() }), 250) }
  const off = getRegistry().subscribe(tree)
  const seen = (e: ExecSeen) => { post(agentRow(e)); tree() }
  execWatchers.add(seen)
  tree()
  return () => { off(); execWatchers.delete(seen); clearTimeout(timer); dead = true }
}

// ---- overlay ------------------------------------------------------------------------------------------------
let mounted = 0, teardown: (() => void) | undefined
// Called by WeftRoot in dev. Refcounted: nested roots share one listener, one panel, one feed.
export function mountDevtools(): () => void {
  if (!mounted++) {
    let host: HTMLElement | undefined, root: ReturnType<typeof createRoot> | undefined
    const close = () => { root?.unmount(); host?.remove(); root = host = undefined }
    const key = (e: KeyboardEvent) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyW')) return
      e.preventDefault()
      if (host) return close()
      host = document.createElement('tvine-gallery')
      document.documentElement.append(host)
      root = createRoot(host.attachShadow({ mode: 'open' }))
      root.render(<Gallery onClose={close} />)
    }
    globalThis.addEventListener('keydown', key)
    const feed = startFeed()
    teardown = () => { globalThis.removeEventListener('keydown', key); feed(); close() }
  }
  let done = false
  return () => { if (done) return; done = true; if (!--mounted) { teardown?.(); teardown = undefined } }
}

const C = { bg: '#16161a', fg: '#ececf1', mute: '#9a9aa6', line: '#2e2e36', acc: '#7da2ff', hi: '#f5a524', err: '#ff7a6e' }
const S: Record<string, CSSProperties> = {
  panel: { position: 'fixed', top: 12, right: 12, bottom: 12, width: 'min(460px, calc(100vw - 24px))', zIndex: 2147483646, background: C.bg, color: C.fg, font: '12px/1.45 ui-monospace, monospace', border: `1px solid ${C.line}`, borderRadius: 10, display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px #0008' },
  head: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${C.line}` },
  body: { overflow: 'auto', padding: '6px 10px', flex: 1 },
  btn: { font: 'inherit', color: C.fg, background: '#24242b', border: `1px solid ${C.line}`, borderRadius: 6, padding: '2px 8px', cursor: 'pointer' },
  input: { font: 'inherit', color: C.fg, background: '#24242b', border: `1px solid ${C.line}`, borderRadius: 6, padding: '2px 6px', width: '100%' },
  mute: { color: C.mute },
  hl: { position: 'fixed', pointerEvents: 'none', border: `2px dashed ${C.hi}`, borderRadius: 4, zIndex: 2147483645 },
}

function useTree(): DevNode[] {
  const [t, set] = useState(devTree)
  useEffect(() => getRegistry().subscribe(() => set(devTree())), [])
  return t
}

function count(nodes: DevNode[], into = new Map<string, number>()): Map<string, number> {
  for (const n of nodes) { into.set(n.kind, (into.get(n.kind) ?? 0) + 1); count(n.children, into) }
  return into
}

function Gallery({ onClose }: { onClose: () => void }) {
  const tree = useTree()
  const [tab, setTab] = useState<'page' | 'builtins'>('page')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string>()
  const [box, setBox] = useState<DOMRect>()
  const kinds = useMemo(() => count(tree), [tree])
  const hover = (id?: string) => setBox(id ? getRegistry().get(id)?.el?.getBoundingClientRect() : undefined)
  const match = (n: DevNode): boolean => !q || `${n.id} ${n.label}`.toLowerCase().includes(q.toLowerCase()) || n.children.some(match)
  const selected = sel ? find(tree, sel) : undefined

  const row = (n: DevNode, depth: number) => match(n) && (
    <div key={n.id}>
      <div onMouseEnter={() => hover(n.id)} onMouseLeave={() => hover()} onClick={() => setSel(n.id)}
        style={{ paddingLeft: depth * 12, cursor: 'pointer', background: sel === n.id ? '#2a2a33' : undefined, borderRadius: 4 }}>
        <span style={{ color: C.acc }}>{n.kind}</span> {n.id}
        <span style={S.mute}> “{n.label}”{n.auto ? ' auto' : ''}{n.hooks ? ' hooks' : ''}{n.sensitive ? ' sensitive' : ''}{n.agentHidden ? ' hidden-from-agents' : ''}</span>
        {n.state !== undefined && <div style={{ ...S.mute, paddingLeft: 12 }}>state {JSON.stringify(n.state)}</div>}
        {n.controls.map((c) => (
          <div key={c.name} style={{ paddingLeft: 12 }}>
            {c.sig} <span style={S.mute}>· {c.headless}{c.agentOff ? ' · not for agents' : ''}</span>
          </div>
        ))}
      </div>
      {n.children.map((c) => row(c, depth + 1))}
    </div>
  )

  return (
    <>
      {box && <div style={{ ...S.hl, left: box.left - 2, top: box.top - 2, width: box.width + 4, height: box.height + 4 }} />}
      <div style={S.panel} role="dialog" aria-label="Weft widget gallery">
        <div style={S.head}>
          <b>Widgets</b>
          <button style={S.btn} onClick={() => setTab('page')} aria-pressed={tab === 'page'}>This page ({[...kinds.values()].reduce((a, b) => a + b, 0)})</button>
          <button style={S.btn} onClick={() => setTab('builtins')} aria-pressed={tab === 'builtins'}>Built-ins ({BUILTINS.length})</button>
          <span style={{ flex: 1 }} />
          <button style={S.btn} onClick={onClose} aria-label="Close (Alt+Shift+W)">×</button>
        </div>
        {tab === 'page' ? (
          <>
            <div style={{ padding: '6px 10px' }}>
              <input style={S.input} placeholder="search id or label" value={q} onChange={(e) => setQ(e.target.value)} />
              <div style={S.mute}>{[...kinds].map(([k, n]) => `${k} ${n}`).join(' · ') || 'no widgets on this page'}</div>
            </div>
            <div style={S.body}>{tree.map((n) => row(n, 0))}</div>
            {selected && <TryIt key={selected.id} node={selected} />}
          </>
        ) : (
          <div style={S.body}>
            {BUILTINS.map((b) => (
              <div key={b.name}><span style={{ color: C.acc }}>{b.kind}</span> {b.name} <span style={S.mute}>· @tvine/weft/widgets{kinds.get(b.kind) ? ` · ${kinds.get(b.kind)} on page` : ''}</span></div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function find(nodes: DevNode[], id: string): DevNode | undefined {
  for (const n of nodes) { if (n.id === id) return n; const f = find(n.children, id); if (f) return f }
  return undefined
}

// Form values → args by ParamSpec (blank optional fields are left out).
export function argsFrom(params: Record<string, ParamSpec> | undefined, raw: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(params ?? {})) {
    const v = raw[k]
    if (p.type === 'boolean') { out[k] = !!v; continue }
    if (v === undefined || v === '') continue
    const s = String(v)
    out[k] = p.multiple ? s.split(',').map((x) => x.trim()).filter(Boolean)
      : p.type === 'number' ? Number(s)
      : p.type === 'json' ? (() => { try { return JSON.parse(s) } catch { return s } })()
      : s
  }
  return out
}

function TryIt({ node }: { node: DevNode }) {
  const usable = node.controls.filter((c) => !c.agentOff)
  const [control, setControl] = useState(usable[0]?.name ?? '')
  const [raw, setRaw] = useState<Record<string, string | boolean>>({})
  const [out, setOut] = useState<string>()
  const c = usable.find((x) => x.name === control)
  if (!usable.length) return <div style={{ ...S.head, borderTop: `1px solid ${C.line}` }}><span style={S.mute}>{node.id}: no agent controls</span></div>
  const run = async () => {
    setOut('running…')
    try { setOut(JSON.stringify(await tryIt({ target: node.id, control, args: argsFrom(c?.params, raw) }), null, 1)) }
    catch (e) { setOut(String(e)) }
  }
  return (
    <div style={{ borderTop: `1px solid ${C.line}`, padding: '6px 10px', maxHeight: '40%', overflow: 'auto' }}>
      <div><b>Try it as agent</b> <span style={S.mute}>{node.id}</span></div>
      <select style={S.input} value={control} onChange={(e) => { setControl(e.target.value); setRaw({}) }}>
        {usable.map((x) => <option key={x.name} value={x.name}>{x.sig}</option>)}
      </select>
      {Object.entries(c?.params ?? {}).map(([k, p]) => (
        <label key={k} style={{ display: 'block' }}>
          <span style={S.mute}>{k}{p.optional ? '?' : ''}</span>{' '}
          {p.type === 'boolean'
            ? <input type="checkbox" checked={!!raw[k]} onChange={(e) => setRaw({ ...raw, [k]: e.target.checked })} />
            : p.enum && !p.multiple
              ? <select style={S.input} value={String(raw[k] ?? '')} onChange={(e) => setRaw({ ...raw, [k]: e.target.value })}><option value="" />{p.enum.map((v) => <option key={v}>{v}</option>)}</select>
              : <input style={S.input} type={p.secret ? 'password' : p.type === 'number' ? 'number' : 'text'} value={String(raw[k] ?? '')} onChange={(e) => setRaw({ ...raw, [k]: e.target.value })} />}
        </label>
      ))}
      <button style={{ ...S.btn, marginTop: 4 }} onClick={run}>Run</button>
      {out && <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{out}</pre>}
    </div>
  )
}
