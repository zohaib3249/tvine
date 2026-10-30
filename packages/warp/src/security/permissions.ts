import { DomainError } from '../core/errors.js'
import { ANONYMOUS, type ActionCtx, type ActionId, type Permission, type PermissionCtx } from '../core/types.js'

export type { Permission, PermissionCtx }

export const allowAny: Permission = () => true
// Static tag (security.md invariant 4): weft's bindAction reads it to set ActionHandle.agent=false so
// widgets bound to the action list no control to agents. Only a UX layer: dispatch still runs the function.
export const AGENTS_DENIED = Symbol.for('tvine.denyAgents')
const tag = (p: Permission): Permission => Object.assign(p, { [AGENTS_DENIED]: true })
export const deniesAgents = (p: Permission): boolean => !!(p as { [AGENTS_DENIED]?: true })[AGENTS_DENIED]

export const denyAgents: Permission = tag((ctx) => !ctx.agent?.is)
export const humanOnly: Permission = denyAgents
export const isAuthenticated: Permission = (ctx) => ctx.user.isAuthenticated

// Sequential on purpose: short-circuits so later guards never run after a decision.
export const allOf = (...p: Permission[]): Permission => {
  const all: Permission = async (ctx) => {
    for (const f of p) if (!(await f(ctx))) return false
    return true
  }
  return p.some(deniesAgents) ? tag(all) : all     // any member denies agents → so does the whole
}
export const anyOf = (...p: Permission[]): Permission => {
  const any: Permission = async (ctx) => {
    for (const f of p) if (await f(ctx)) return true
    return false
  }
  return p.length > 0 && p.every(deniesAgents) ? tag(any) : any
}

// PermissionCtx from an ActionCtx: agent identity comes from request.agent (denyAgents reads it).
export function permissionCtx(ctx: Pick<ActionCtx, 'sid' | 'session' | 'request'>, action: ActionId): PermissionCtx {
  const r = ctx.request
  return { sid: ctx.sid, session: ctx.session, action, route: r?.route ?? '', user: r?.user ?? ANONYMOUS, agent: r?.agent, ip: r?.ip ?? '' }
}

// First deny wins. A permission that throws is a deny (fail closed), never an internal error.
export async function runPermissions(perms: Permission[], pctx: PermissionCtx): Promise<void> {
  for (const p of perms) {
    let ok = false
    try { ok = await p(pctx) } catch { /* deny */ }
    if (!ok) throw new DomainError('forbidden', `forbidden: not allowed: ${pctx.action}`)
  }
}
