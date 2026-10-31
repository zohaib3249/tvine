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
const active = (ctx: PermissionCtx) => ctx.user.isAuthenticated && ctx.user.isActive !== false
export const isStaff: Permission = (ctx) => active(ctx) && ctx.user.isStaff === true
export const isSuperuser: Permission = (ctx) => active(ctx) && ctx.user.isSuperuser === true

// Django user.has_perms: every codename ('catalog.change_product') granted. A user without hasPerm (anonymous,
// a BYO user that has none) is denied.
export function hasPerm(...perms: string[]): Permission {
  if (!perms.length) throw new Error('hasPerm(): name at least one permission')
  return async (ctx) => {
    if (!active(ctx) || !ctx.user.hasPerm) return false
    for (const p of perms) if (!(await ctx.user.hasPerm(p))) return false
    return true
  }
}

// '<app>.<action>_<model>'; a model named '<app>_x' drops the prefix (auth_user → auth.change_user)
export const permCodename = (app: string, action: string, model: string) =>
  `${app}.${action}_${model.startsWith(`${app}_`) ? model.slice(app.length + 1) : model}`

// DRF DjangoModelPermissions for generic views: the generated action name (the id's last segment) → model
// permissions. Reads need only an authenticated user (DRF maps GET to []); any other action needs `change`
// unless `map` names it. The app is the action id's first segment.
export const MODEL_PERMS: Record<string, string[]> = { list: [], get: [], create: ['add'], update: ['change'], delete: ['delete'] }
export function modelPermissions(model: { name: string }, opts: { map?: Record<string, string[]> } = {}): Permission {
  const map = { ...MODEL_PERMS, ...opts.map }
  return async (ctx) => {
    if (!active(ctx) || !ctx.action) return false
    const parts = ctx.action.split('.'), app = parts[0]!, name = parts.at(-1)!
    const need = (map[name] ?? ['change']).map((a) => permCodename(app, a, model.name))
    for (const p of need) if (!ctx.user.hasPerm || !(await ctx.user.hasPerm(p))) return false
    return true
  }
}

// Token scopes (docs/design/contrib/auth.md §6): '*', 'read' (readOnly actions), '<app>.*', '<app>.<action>'.
export const scopeAllows = (scopes: readonly string[], action: string, readOnly: boolean): boolean =>
  scopes.some((s) => s === '*' || s === action || (s === 'read' && readOnly) || (s.endsWith('.*') && action.startsWith(s.slice(0, -1))))

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
// A token-authenticated user is also held to the token's scopes: checked where dispatch states whether the action
// is readOnly (pctx.readOnly present), i.e. once per command before any app permission.
export async function runPermissions(perms: Permission[], pctx: PermissionCtx): Promise<void> {
  const scopes = pctx.user.scopes
  if (scopes && pctx.action && pctx.readOnly !== undefined && !scopeAllows(scopes, pctx.action, pctx.readOnly)) {
    throw new DomainError('forbidden', `forbidden: not allowed: ${pctx.action}`)
  }
  for (const p of perms) {
    let ok = false
    try { ok = await p(pctx) } catch { /* deny */ }
    if (!ok) throw new DomainError('forbidden', `forbidden: not allowed: ${pctx.action}`)
  }
}
