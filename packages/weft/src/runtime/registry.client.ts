import type { AgentState, Json, WidgetHooks, WidgetSpec } from '../widget/types.js'

// registry-client.md: the in-tab control tree. Plain mutable maps, no React state: writes
// happen only in layout effects, nothing re-renders because of them.

export interface Entry {
  id: string; parent: string; kind: string
  spec: WidgetSpec                 // latest committed spec
  el: HTMLElement | null
  token: symbol                    // which mount owns this entry
  order: number                    // mount sequence (dup resolution only)
  agent?(a: AgentState): void      // executor/presence marks the widget as targeted (re-renders that widget only)
}
export interface RegistryNode { id: string; kind: string; spec?: WidgetSpec; children: RegistryNode[] }

const dev = () => process.env.NODE_ENV !== 'production'

export function shallowChanged(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return false
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return true
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length !== kb.length || ka.some((k) => (a as Record<string, Json>)[k] !== (b as Record<string, Json>)[k])
}

export class Registry {
  rev = 0                                  // uiRev: bumps on mount, unmount, and any state shallow-change
  readonly roots = new Set<{ hooks?: WidgetHooks }>()   // mounted <WeftRoot>s, innermost first (mount order)
  private live = new Map<string, Entry>()
  private dups = new Map<string, Entry[]>()   // same id mounted later: not addressable until the winner leaves
  private subs = new Set<() => void>()
  private warned = new Set<string>()
  private seq = 0

  register(e: Entry): () => void {
    e.order = ++this.seq
    const cur = this.live.get(e.id)
    if (!cur) this.live.set(e.id, e)
    else {
      this.dups.set(e.id, [...(this.dups.get(e.id) ?? []), e])
      // Same entity in two places (grid + "recently viewed") is normal dedupe, not a clash.
      if (e.spec.entity === e.id && cur.spec.entity === cur.id) return this.mounted(e)
      const msg = `tvine: duplicate widget id "${e.id}": ${cur.kind} "${cur.spec.label}" (mount #${cur.order}) and ${e.kind} "${e.spec.label}" (mount #${e.order}). The first stays addressable; give one a distinct name.`
      if (dev()) console.error(msg)
      else if (!this.warned.has(e.id)) { this.warned.add(e.id); console.warn(msg) }
    }
    return this.mounted(e)
  }

  private mounted(e: Entry): () => void {
    this.rev++
    this.changed()
    return () => this.unregister(e.id, e.token)
  }

  addRoot(root: { hooks?: WidgetHooks }): () => void {
    this.roots.add(root)
    return () => { this.roots.delete(root) }
  }

  private unregister(id: string, token: symbol): void {
    if (this.live.get(id)?.token === token) {
      const next = this.dups.get(id)?.shift()
      if (next) this.live.set(id, next)
      else this.live.delete(id)
    } else {
      const q = this.dups.get(id)
      const i = q?.findIndex((d) => d.token === token) ?? -1
      if (i < 0) return                      // stale cleanup: a newer mount owns this id
      q!.splice(i, 1)
    }
    if (!this.dups.get(id)?.length) this.dups.delete(id)
    this.rev++
    this.changed()
  }

  update(id: string, token: symbol, spec: WidgetSpec): void {
    const e = this.live.get(id)?.token === token ? this.live.get(id) : this.dups.get(id)?.find((d) => d.token === token)
    if (!e) return
    const bump = shallowChanged(e.spec.state, spec.state)
    e.spec = spec
    if (bump) { this.rev++; this.changed() }
  }

  get(id: string): Entry | undefined { return this.live.get(id) }

  children(id: string): Entry[] { return [...this.live.values()].filter((e) => e.parent === id) }

  // O(n). With no root, entries whose parent is not registered (RSC-only containers) hang off the page.
  tree(root = ''): RegistryNode {
    const by = new Map<string, Entry[]>()
    for (const e of this.live.values()) {
      const p = !root && !this.live.has(e.parent) ? '' : e.parent
      const list = by.get(p)
      if (list) list.push(e)
      else by.set(p, [e])
    }
    const node = (e: Entry): RegistryNode => ({ id: e.id, kind: e.kind, spec: e.spec, children: (by.get(e.id) ?? []).map(node) })
    const r = this.live.get(root)
    return r ? node(r) : { id: root, kind: 'page', children: (by.get(root) ?? []).map(node) }
  }

  // Only gallery / inspector / presence subscribe; app components never do.
  subscribe(fn: () => void): () => void {
    this.subs.add(fn)
    return () => { this.subs.delete(fn) }
  }

  private changed(): void { if (this.subs.size) for (const f of this.subs) f() }
}

const KEY = Symbol.for('tvine.weft.registry')
// One per tab, shared by HMR copies and duplicated bundles.
export function getRegistry(): Registry {
  const g = globalThis as { [KEY]?: Registry }
  return (g[KEY] ??= new Registry())
}
