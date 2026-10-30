import type { Permission, PermissionCtx } from '../core/types.js'

export type { Permission, PermissionCtx }

export const allowAny: Permission = () => true
export const denyAgents: Permission = (ctx) => !ctx.agent?.is
export const humanOnly: Permission = denyAgents
export const isAuthenticated: Permission = (ctx) => ctx.user.isAuthenticated

// Sequential on purpose: short-circuits so later guards never run after a decision.
export const allOf = (...p: Permission[]): Permission => async (ctx) => {
  for (const f of p) if (!(await f(ctx))) return false
  return true
}
export const anyOf = (...p: Permission[]): Permission => async (ctx) => {
  for (const f of p) if (await f(ctx)) return true
  return false
}
