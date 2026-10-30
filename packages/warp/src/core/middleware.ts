// core/middleware — dev extension points (docs/design/conventions/middleware-hooks.md).
// Middleware wraps dispatch after the security steps; hooks observe, never block.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_RE } from './actions.js'
import type { Command, ErrCode, Event, Middleware, Sid } from './types.js'

export type { Middleware }

export interface HookEvents {
  command: { cmd: Command; events: Event[]; ms: number }   // a committed (ok) command
  error: { cmd: Command; code: ErrCode; message: string }   // any err outcome (nothing committed)
  session: { sid: Sid; kind: 'created' | 'expired' }
}
export type HookName = keyof HookEvents

// ponytail: in-process listener sets, not channel-layer groups; move to the channel layer when hooks must cross processes.
export class Hooks {
  private fns: { [K in HookName]: Set<(e: HookEvents[K]) => unknown> } = { command: new Set(), error: new Set(), session: new Set() }
  constructor(private onError: (hook: HookName, e: unknown) => void) {}

  on<K extends HookName>(name: K, fn: (e: HookEvents[K]) => unknown): () => void {
    this.fns[name].add(fn)
    return () => { this.fns[name].delete(fn) }
  }

  // Fire-and-forget: a throw or rejection is logged and never reaches the caller.
  emit<K extends HookName>(name: K, e: HookEvents[K]): void {
    for (const fn of this.fns[name]) {
      try { void Promise.resolve(fn(e)).catch((x: unknown) => this.onError(name, x)) }
      catch (x) { this.onError(name, x) }
    }
  }
}

// apps/<app>/middleware.ts `export default [...]`, keyed by app, apps in sorted order.
export async function discoverMiddleware(appsDir: string): Promise<Map<string, Middleware[]>> {
  const out = new Map<string, Middleware[]>()
  for (const app of (await readdir(appsDir)).sort()) {
    const file = join(appsDir, app, 'middleware.ts')
    if (!(await stat(file).catch(() => null))?.isFile()) continue
    if (!APP_RE.test(app)) throw new Error(`${file}: folder name "${app}" must match ${APP_RE}`)
    const list: unknown = (await import(pathToFileURL(file).href)).default
    if (!Array.isArray(list) || !list.every((f) => typeof f === 'function')) throw new Error(`${file}: default export must be an array of functions`)
    out.set(app, list as Middleware[])
  }
  return out
}

// Global then app middleware, outermost first, around `inner`. next() runs at most once.
export function compose(chain: Middleware[], cmd: Parameters<Middleware>[0], ctx: Parameters<Middleware>[1],
  inner: () => AsyncIterable<Event>): AsyncIterable<Event> {
  const at = (i: number): AsyncIterable<Event> => {
    if (i === chain.length) return inner()
    let called = false
    return chain[i]!(cmd, ctx, () => {
      if (called) throw new Error('middleware called next() twice')
      called = true
      return at(i + 1)
    })
  }
  return at(0)
}
