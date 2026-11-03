// Server-side helpers (createUser / createSuperuser, setPassword, group + permission
// grants). Validators run unless `validate: false` (fixtures, tests). `settings` picks the hashers/validators;
// without it the defaults apply.
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, Settings } from '../../core/types.js'
import { getUserModel, Group, GroupPermission, Permission, UserGroup, userMeta, UserPermission } from './models.js'
import { makePassword, UNUSABLE, validateNewPassword, validatePassword } from './passwords.js'
import { revokeTokens, SESSION_USER, updateSessionAuthHash, type UserRow } from './backend.js'
import { dropOtherSessions } from './sessions.js'
import { securityNotice } from './notify.js'

const NO_SETTINGS = {} as Settings
// the usernameField (`username` on the built-in model) and requiredFields of the configured user model, plus any of its fields
export type NewUser = { username?: string; email?: string | null; password?: string | null; isStaff?: boolean; isSuperuser?: boolean; isActive?: boolean } & Record<string, unknown>

// createUser on getUserModel()
export async function createUser(u: NewUser, o: { settings?: Settings; validate?: boolean } = {}): Promise<UserRow> {
  const s = o.settings ?? NO_SETTINGS, { usernameField: uf, emailField: ef } = userMeta()
  const { password: raw, ...rest } = u
  const name = String(rest[uf] ?? '').normalize('NFKC').trim()   // normalize the username
  if (!name) throw new DomainError('invalid_param', `a ${uf} is required`, uf)
  rest[uf] = name
  if (ef && typeof rest[ef] === 'string') rest[ef] = (rest[ef] as string).trim() || null
  if (raw != null && o.validate !== false) {
    const problems = validatePassword(raw, s, { ...rest, username: name, email: (ef && rest[ef]) || '' })
    if (problems.length) throw new DomainError('invalid_param', problems.join(' '), 'password')
  }
  // no password → unusable: the account can only get one through a reset
  const password = raw == null ? `${UNUSABLE}${crypto.randomUUID()}` : await makePassword(raw, s)
  return getUserModel().create({ ...rest, password, isStaff: !!u.isStaff, isSuperuser: !!u.isSuperuser, isActive: u.isActive ?? true } as never)
}

export const createSuperuser = (u: Omit<NewUser, 'isStaff' | 'isSuperuser'>, o?: { settings?: Settings; validate?: boolean }) =>
  createUser({ ...u, isStaff: true, isSuperuser: true }, o)

// A new password: the user's API tokens are revoked and every other session dies (bound to the old hash); `ctx` =
// the request doing it, whose own session stays signed in when it is that user's.
export async function setPassword(userId: number, raw: string, o: { settings?: Settings; validate?: boolean; ctx?: Pick<ActionCtx, 'session' | 'settings'> } = {}): Promise<void> {
  const s = o.settings ?? o.ctx?.settings ?? NO_SETTINGS
  const row = await getUserModel().get(userId)
  if (!row) throw new DomainError('not_found', 'no such user')
  if (o.validate !== false) {
    const problems = await validateNewPassword(raw, s, row)
    if (problems.length) throw new DomainError('invalid_param', problems.join(' '), 'password')
  }
  await passwordChanged(await getUserModel().update(userId, { password: await makePassword(raw, s) }), o.ctx)
}
// the side effects of any password write (setPassword, the admin's change form)
export async function passwordChanged(row: { id: number; password: string }, ctx?: Pick<ActionCtx, 'session' | 'settings'>): Promise<void> {
  await revokeTokens(row.id)
  if (ctx) {
    updateSessionAuthHash(ctx, row)
    await dropOtherSessions(row.id, ctx.session?.data.get(SESSION_USER) === String(row.id) ? ctx.session : undefined)
    const u = await getUserModel().get(row.id)
    if (u) securityNotice(ctx.settings, 'passwordChanged', u)
  }
}

async function permId(codename: string): Promise<number> {
  const p = await Permission.objects.filter({ codename }).first()
  if (!p) throw new DomainError('not_found', `no permission ${codename} (run tvine migrate)`)
  return p.id
}
export async function groupNamed(name: string): Promise<number> {
  return ((await Group.objects.filter({ name }).first()) ?? (await Group.create({ name }))).id
}
export async function addToGroup(userId: number, group: string): Promise<void> {
  const groupId = await groupNamed(group)
  if (!(await UserGroup.objects.filter({ userId, groupId }).first())) await UserGroup.create({ userId, groupId })
}
export async function grant(to: { user: number } | { group: string }, codename: string): Promise<void> {
  const permissionId = await permId(codename)
  if ('user' in to) {
    if (!(await UserPermission.objects.filter({ userId: to.user, permissionId }).first())) await UserPermission.create({ userId: to.user, permissionId })
  } else {
    const groupId = await groupNamed(to.group)
    if (!(await GroupPermission.objects.filter({ groupId, permissionId }).first())) await GroupPermission.create({ groupId, permissionId })
  }
}
