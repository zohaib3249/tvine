// "With or without await" (orm-queryset.md §await or not). Every public ORM call (Model.create, qs.update, …)
// is tracked by the enclosing scope (atomic(), a request, a job): calls run one after another in call order,
// and the scope waits for all of them before it ends. A failed call nobody awaited fails the scope like a
// throw (the request rolls back). Awaited calls are the caller's business, as before.
import { AsyncLocalStorage } from 'node:async_hooks'
import { getLogger } from '../log.js'

// then() marks the promise as seen: await, .then/.catch/.finally, Promise.all/race all go through it
// (a subclass is never adopted as-is by await). Derived promises are plain ones.
class Tracked<T> extends Promise<T> {
  static override get [Symbol.species]() { return Promise }
  seen = false
  override then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, no?: ((e: any) => B | PromiseLike<B>) | null): Promise<A | B> {
    this.seen = true
    return super.then(ok, no)
  }
}
const wrap = <T>(p: Promise<T>): Tracked<T> => {
  const t = new Tracked<T>((ok, no) => { p.then(ok, no) })
  Promise.prototype.then.call(t, undefined, () => undefined)   // never an unhandled rejection: drain() reports it
  return t
}

interface Scope { ops: { p: Promise<unknown>; t: Tracked<unknown> }[]; tail: Promise<unknown>; done?: true }   // done: drained, the block is over
// undefined: no scope (top level); null: inside an ORM call (its own nested calls run straight, or they would wait on it)
const als = new AsyncLocalStorage<Scope | null>()
let warned = false

export function tracked<R>(run: () => Promise<R>, write: boolean): Promise<R> {
  const s = als.getStore()
  if (s === null) return run()
  const go = () => als.run(null, run)
  if (!s || s.done) {   // top level, or late (a timer after the block ended): nothing waits for it
    if (!write) return go()
    const p = go(), t = wrap(p)
    const check = (e?: unknown) => {
      if (t.seen) return
      if (e !== undefined) getLogger('tvine.db').error(s ? 'unawaited write after its block ended failed' : 'unawaited write outside a transaction failed', { error: (e as Error)?.message ?? String(e) })
      else if (!warned) { warned = true; getLogger('tvine.db').warn('unawaited write outside a transaction (await it, or wrap the code in atomic())') }
    }
    p.then(() => check(), check)
    return t
  }
  const p = s.tail.then(go)   // call order, on the scope's connection
  s.tail = p.catch(() => undefined)
  const t = wrap(p)
  s.ops.push({ p, t })
  return t
}

// fn's un-awaited ORM calls finish before this resolves; the first failed one nobody awaited is thrown.
export function withPending<R>(fn: () => Promise<R>): Promise<R> {
  const s: Scope = { ops: [], tail: Promise.resolve() }
  return als.run(s, async () => {
    let r: R
    try { r = await fn() } catch (e) { await drain(s).catch(() => undefined); s.done = true; throw e }
    try { await drain(s) } finally { s.done = true }
    return r
  })
}

async function drain(s: Scope): Promise<void> {
  let failed: { e: unknown } | undefined
  while (s.ops.length) {   // a finished call may have started more
    const ops = s.ops.splice(0)
    const out = await Promise.allSettled(ops.map(o => o.p))
    out.forEach((r, i) => { if (r.status === 'rejected' && !ops[i].t.seen) failed ??= { e: r.reason } })
  }
  if (failed) throw failed.e
}

// fn's ORM calls belong to no block (outsideAtomic: they must not hold up, or wait on, the caller's block)
export const exitPending = <R>(fn: () => R): R => als.exit(fn)

export function trackMethods(o: Record<string, any>, names: string[], write: boolean): void {
  for (const n of names) {
    const f = o[n]
    o[n] = function (this: unknown, ...a: unknown[]) { return tracked(() => f.apply(this, a), write) }
  }
}
