// core/middleware — dev extension points (docs/design/conventions/middleware-hooks.md).
// Middleware wraps dispatch after the security steps; hooks observe, never block.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_RE } from './actions.js'
import type { Command, ErrCode, Event, Middleware, Sid } from './types.js'

export type { Middleware }

export interface HookEvents {
  // every dispatch, after it settled (an ok only after commit; a middleware short-circuit implies no commit)
  command: { cmd: Command; action: string; status: 'ok' | ErrCode; sid: Sid | undefined; events: Event[]; ms: number }
  error: { cmd: Command; code: ErrCode; message: string }   // additionally, on any err outcome
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

  has(name: HookName): boolean { return this.fns[name].size > 0 }

  // Fire-and-forget: a throw or rejection is logged and never reaches the caller (nor does a logger throw).
  emit<K extends HookName>(name: K, e: HookEvents[K]): void {
    const fail = (x: unknown) => { try { this.onError(name, x) } catch { /* logger itself failed */ } }
    for (const fn of this.fns[name]) {
      try { void Promise.resolve(fn(e)).catch(fail) }
      catch (x) { fail(x) }
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

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x) }
  return v
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
