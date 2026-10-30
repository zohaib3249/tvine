// core/middleware — dev extension points (docs/design/conventions/middleware-hooks.md).
// Middleware wraps dispatch after the security steps; hooks observe, never block.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_RE, appModule, importApp } from './actions.js'
import type { Command, ErrCode, Event, Middleware, Sid } from './types.js'

export type { Middleware }

export interface HookEvents {
  // every dispatch, after it settled (an ok only after commit; a middleware short-circuit implies no commit)
  command: { cmd: Command; action: string; status: 'ok' | ErrCode; sid: Sid | undefined; events: Event[]; ms: number }
  error: { cmd: Command; code: ErrCode; message: string }   // additionally, on any err outcome
  session: { sid: Sid; kind: 'created' | 'expired' }
  read: { page: string; via: 'http' | 'mcp'; sid: Sid; rev: number; ms: number }   // an agent read a page snapshot
}
export type HookName = keyof HookEvents
const HOOK_NAMES: HookName[] = ['command', 'error', 'session', 'read']

// ponytail: in-process listener sets, not channel-layer groups; move to the channel layer when hooks must cross processes.
export class Hooks {
  private fns = Object.fromEntries(HOOK_NAMES.map((n) => [n, new Set()])) as { [K in HookName]: Set<(e: HookEvents[K]) => unknown> }
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
    if (!(await stat(join(appsDir, app)).catch(() => null))?.isDirectory()) continue
    const file = appModule(join(appsDir, app), 'middleware')
    if (!file) continue
    if (!APP_RE.test(app)) throw new Error(`${file}: folder name "${app}" must match ${APP_RE}`)
    const list: unknown = (await importApp(file)).default
    if (!Array.isArray(list) || !list.every((f) => typeof f === 'function')) throw new Error(`${file}: default export must be an array of functions`)
    out.set(app, list as Middleware[])
  }
  return out
}

// apps/<app>/hooks.ts: every exported function is a receiver named after its hook (`export function command(e) {…}`),
// registered at boot like Django signal receivers connected in AppConfig.ready().
export async function discoverHooks(appsDir: string): Promise<[HookName, (e: never) => unknown][]> {
  const out: [HookName, (e: never) => unknown][] = []
  for (const app of (await readdir(appsDir)).sort()) {
    if (!(await stat(join(appsDir, app)).catch(() => null))?.isDirectory()) continue
    const file = appModule(join(appsDir, app), 'hooks')
    if (!file) continue
    for (const [name, fn] of Object.entries(await importApp(file))) {
      if (typeof fn !== 'function') continue   // shared constants are fine; an exported function must be a receiver
      if (!HOOK_NAMES.includes(name as HookName)) throw new Error(`${file}: "${name}" is not a hook (${HOOK_NAMES.join(', ')}); export one function per hook name`)
      out.push([name as HookName, fn as (e: never) => unknown])
    }
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
