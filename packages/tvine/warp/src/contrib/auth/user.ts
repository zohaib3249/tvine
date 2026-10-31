// Django's user API in one place: permission sets (ModelBackend.get_*_permissions), the instance methods every
// user-model row carries (checkPassword, hasPerm, getFullName…), and authenticate() over settings.auth.backends.
// models.ts imports this module for userMethods, so the models are only reached lazily (import()) from here.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { securityEvent } from '../../core/audit.js'
import { appModule, importApp } from '../../core/actions.js'
import type { ActionCtx, Settings } from '../../core/types.js'
import { MAX_IN, type Where } from '../../data/queryset.js'
import { setUserModelLabel } from '../../data/swappable.js'
import { checkPassword, dummyCheck, isUsable, makePassword, UNUSABLE } from './passwords.js'
import { throttleOf } from './throttle.js'

const M = () => import('./models.js')
type Row = Record<string, any>

// the settings rows' methods use (hashers, objectPermission); set at boot with settings.auth.userModel
let current = {} as Settings
export const authSettings = () => current
export function configureAuth(s: Settings): void {
  setUserModelLabel(s.auth?.userModel)
  current = s
}

// ---- permissions -------------------------------------------------------------------------------------
const inChunks = async <R>(ids: unknown[], fn: (chunk: unknown[]) => Promise<R[]>): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < ids.length; i += MAX_IN) out.push(...(await fn(ids.slice(i, i + MAX_IN))))
  return out
}
const inList = (field: string, value: unknown[]): Where[] => [{ field, op: 'in', value }]

export interface PermUser { id: string | number; isActive: boolean; isSuperuser: boolean }
// Django get_group_permissions / get_all_permissions: codenames; inactive → none; active superuser → every one
export async function permissionsOf(u: PermUser, groupsOnly = false): Promise<Set<string>> {
  const { Permission, UserPermission, UserGroup, GroupPermission } = await M()
  if (!u.isActive) return new Set()
  if (u.isSuperuser) return new Set((await Permission.objects.all()).map((p) => p.codename))
  const userId = Number(u.id)
  const own = groupsOnly ? [] : (await UserPermission.objects.filter({ userId }).all()).map((r) => r.permissionId)
  const gids = (await UserGroup.objects.filter({ userId }).all()).map((r) => r.groupId)
  const viaGroups = (await inChunks(gids, (c) => GroupPermission.objects.filter(inList('groupId', c)).all())).map((r) => r.permissionId)
  const ids = [...new Set([...own, ...viaGroups])]
  return new Set((await inChunks(ids, (c) => Permission.objects.filter(inList('id', c)).all())).map((p) => p.codename))
}

// Django semantics: active superuser → everything; with an object only settings.auth.objectPermission answers
export async function userHasPerm(u: PermUser, perms: () => Promise<Set<string>>, perm: string, obj: unknown, s: Settings): Promise<boolean> {
  if (!u.isActive) return false
  if (obj !== undefined) {
    if (u.isSuperuser) return true
    const f = s.auth?.objectPermission
    return f ? !!(await f(u as never, perm, obj)) : false
  }
  return u.isSuperuser || (await perms()).has(perm)
}

// The methods a user-model row has (models.ts sets this as the rows' prototype) and AuthUser mirrors. Not
// enumerable on the row: JSON, spread and Object.keys see the plain columns.
const permCache = new WeakMap<object, Promise<Set<string>>>()
export const userMethods = {
  get isAuthenticated() { return true },
  get isAnonymous() { return false },
  getUsername(this: Row): string { return String(this[this.USERNAME_FIELD ?? 'username']) },
  getFullName(this: Row): string { return [this.firstName, this.lastName].filter(Boolean).join(' ').trim() },
  getShortName(this: Row): string { return String(this.firstName ?? '') },
  hasUsablePassword(this: Row): boolean { return isUsable(this.password) },
  async checkPassword(this: Row, raw: string): Promise<boolean> {
    const r = await checkPassword(raw, this.password, current)
    if (r.ok && r.upgrade) await this.setPassword(raw)   // Django check_password's setter: rehash on the preferred hasher
    return r.ok
  },
  // hashes, saves, and revokes the user's tokens (every session bound to the old hash is already dead)
  async setPassword(this: Row, raw: string): Promise<void> {
    this.password = await makePassword(raw, current)
    await saved(this)
  },
  async setUnusablePassword(this: Row): Promise<void> {
    this.password = `${UNUSABLE}${crypto.randomUUID()}`
    await saved(this)
  },
  getAllPermissions(this: Row): Promise<Set<string>> {
    let p = permCache.get(this)
    if (!p) permCache.set(this, (p = permissionsOf(this as PermUser)))
    return p
  },
  getGroupPermissions(this: Row): Promise<Set<string>> { return permissionsOf(this as PermUser, true) },
  getUserPermissions(this: Row): Promise<Set<string>> { return this.getAllPermissions() },
  hasPerm(this: Row, perm: string, obj?: unknown): Promise<boolean> { return userHasPerm(this as PermUser, () => this.getAllPermissions(), perm, obj, current) },
  async hasPerms(this: Row, perms: string[], obj?: unknown): Promise<boolean> {
    for (const p of perms) if (!(await this.hasPerm(p, obj))) return false
    return true
  },
  async hasModulePerms(this: Row, app: string): Promise<boolean> {
    if (!this.isActive) return false
    if (this.isSuperuser) return true
    return [...(await this.getAllPermissions())].some((p) => p.startsWith(`${app}.`))
  },
}

async function saved(row: Row): Promise<void> {
  const { getUserModel } = await M()
  const { revokeTokens } = await import('./backend.js')
  await getUserModel().update(row.id, { password: row.password })
  await revokeTokens(row.id)
}

// ---- authentication backends (Django AUTHENTICATION_BACKENDS) ---------------------------------------
export type Credentials = Record<string, unknown> & { password?: string }
export interface AuthBackendClass {
  authenticate(ctx: AuthCtx, credentials: Credentials): Promise<Row | null | undefined> | Row | null | undefined
  getUser?(id: number | string): Promise<Row | null | undefined>
}
export type AuthCtx = Partial<Pick<ActionCtx, 'request' | 'sid'>> & { settings: Settings }

// Django ModelBackend: the user model's usernameField (or `username`) + password. Unknown or inactive users cost
// the same hashing as a real check (timing-safe); a hash on an older hasher is upgraded.
export const ModelBackend: AuthBackendClass = {
  async authenticate(ctx, c) {
    const { getUserModel, userMeta } = await M()
    const uf = userMeta().usernameField
    const ident = c[uf] ?? c.username
    if (typeof ident !== 'string' || typeof c.password !== 'string') return null
    return check(ctx, await getUserModel().objects.filter({ [uf]: ident.normalize('NFKC') }).first(), c.password)
  },
  async getUser(id) { const { getUserModel } = await M(); return (await getUserModel().get(id)) ?? null },
}

// login by email (case-insensitive, Django email__iexact); two accounts on one address → no match
export const EmailBackend: AuthBackendClass = {
  async authenticate(ctx, c) {
    const { getUserModel, userMeta } = await M()
    const ef = userMeta().emailField
    if (!ef || typeof c.email !== 'string' || typeof c.password !== 'string') return null
    const want = c.email.normalize('NFKC').trim().toLowerCase()
    const rows = want ? (await getUserModel().objects.filter([{ field: ef, op: 'contains', value: want }]).all(10))
      .filter((r) => String((r as Row)[ef] ?? '').normalize('NFKC').trim().toLowerCase() === want) : []
    return check(ctx, rows.length === 1 ? rows[0] : undefined, c.password)
  },
  getUser: ModelBackend.getUser,
}

async function check(ctx: AuthCtx, row: Row | undefined, password: string): Promise<Row | null> {
  if (!row?.isActive) { await dummyCheck(password, ctx.settings); return null }
  const { ok, upgrade } = await checkPassword(password, row.password, ctx.settings)
  if (!ok) return null
  if (upgrade) {
    const { getUserModel } = await M()
    return getUserModel().update(row.id, { password: await makePassword(password, ctx.settings) })
  }
  return row
}

const BUILT_IN: Record<string, AuthBackendClass> = { 'tvine.auth.ModelBackend': ModelBackend, 'tvine.auth.EmailBackend': EmailBackend }

// settings.auth.backends entry → backend: a built-in name, a dotted path ('accounts.backends.EmailBackend' = the
// EmailBackend export of apps/accounts/backends.ts, or <cwd>/accounts/backends.ts), or the object / class itself
export async function resolveBackend(e: unknown, i: number, root = process.cwd()): Promise<AuthBackendClass> {
  let b = e
  if (typeof e === 'string') {
    b = BUILT_IN[e]
    if (!b) {
      const m = /^([\w-]+(?:\.[\w-]+)*)\.(\w+)$/.exec(e)
      const rel = m?.[1]!.replace(/\./g, '/')
      const file = rel && [join(root, 'apps', rel), join(root, rel)].map((p) => appModule(p.slice(0, p.lastIndexOf('/')), p.slice(p.lastIndexOf('/') + 1))).find(Boolean)
      if (!m || !file || !existsSync(file)) throw new Error(`settings.auth.backends[${i}]: "${e}" not found: expected apps/${rel ?? '<app>/<module>'}.ts exporting ${m?.[2] ?? 'the backend'}`)
      b = (await importApp(file))[m[2]!]
      if (!b) throw new Error(`settings.auth.backends[${i}]: ${file} has no export ${m[2]}`)
    }
  }
  if (typeof b === 'function') b = new (b as new () => AuthBackendClass)()
  if (!b || typeof (b as AuthBackendClass).authenticate !== 'function') throw new Error(`settings.auth.backends[${i}]: needs authenticate(ctx, credentials)`)
  return b as AuthBackendClass
}
export const backendsOf = (s: Settings): AuthBackendClass[] => (s.auth?.backends as AuthBackendClass[] | undefined) ?? [ModelBackend]

// Django authenticate(): each backend in order; the first user wins. Bad credentials → null, never a throw (a
// locked account / ip still throws `locked`). Throttled per (identifier, ip) like the login action.
export async function authenticate(ctx: AuthCtx, credentials: Credentials): Promise<Row | null> {
  const s = ctx.settings, t = throttleOf(s), ip = ctx.request?.ip ?? ''
  const ident = String(credentials.username ?? credentials.email ?? Object.entries(credentials).find(([k]) => k !== 'password')?.[1] ?? '').slice(0, 254)
  if (await t.locked(ident, ip)) {
    securityEvent('lockout', { username: ident.slice(0, 150) }, { settings: s, request: ctx.request, sid: ctx.sid })
    const { DomainError } = await import('../../core/errors.js')
    throw new DomainError('locked', 'too many failed attempts; try again later')
  }
  for (const b of backendsOf(s)) {
    const u = await b.authenticate(ctx, credentials)
    if (u) { await t.succeed(ident, ip); return u }
  }
  await t.fail(ident, ip)
  securityEvent('login_failed', { username: ident.slice(0, 150), why: 'password' }, { settings: s, request: ctx.request, sid: ctx.sid })
  return null
}
