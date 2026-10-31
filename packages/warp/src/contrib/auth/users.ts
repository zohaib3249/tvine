// Server-side helpers (Django UserManager.create_user / create_superuser, set_password, group + permission
// grants). Validators run unless `validate: false` (fixtures, tests). `settings` picks the hashers/validators;
// without it the defaults apply.
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, Settings } from '../../core/types.js'
import { Group, GroupPermission, Permission, User, UserGroup, UserPermission } from './models.js'
import { makePassword, UNUSABLE, validatePassword } from './passwords.js'
import { revokeTokens, updateSessionAuthHash, type UserRow } from './backend.js'

const NO_SETTINGS = {} as Settings
export interface NewUser { username: string; email?: string | null; password?: string | null; isStaff?: boolean; isSuperuser?: boolean; isActive?: boolean }

export async function createUser(u: NewUser, o: { settings?: Settings; validate?: boolean } = {}): Promise<UserRow> {
  const s = o.settings ?? NO_SETTINGS
  const username = u.username.normalize('NFKC').trim()   // Django normalize_username
  if (!username) throw new DomainError('invalid_param', 'a username is required', 'username')
  if (u.password != null && o.validate !== false) {
    const problems = validatePassword(u.password, s, { username, email: u.email ?? '' })
    if (problems.length) throw new DomainError('invalid_param', problems.join(' '), 'password')
  }
  // no password → unusable (Django set_unusable_password): the account can only get one through a reset
  const password = u.password == null ? `${UNUSABLE}${crypto.randomUUID()}` : await makePassword(u.password, s)
  return User.create({ username, email: u.email ?? null, password, isStaff: !!u.isStaff, isSuperuser: !!u.isSuperuser, isActive: u.isActive ?? true })
}

export const createSuperuser = (u: Omit<NewUser, 'isStaff' | 'isSuperuser'>, o?: { settings?: Settings; validate?: boolean }) =>
  createUser({ ...u, isStaff: true, isSuperuser: true }, o)

// A new password: the user's API tokens are revoked and every other session dies (bound to the old hash); `ctx` =
// the request doing it, whose own session stays signed in when it is that user's (Django update_session_auth_hash).
export async function setPassword(userId: number, raw: string, o: { settings?: Settings; validate?: boolean; ctx?: Pick<ActionCtx, 'session' | 'settings'> } = {}): Promise<void> {
  const s = o.settings ?? o.ctx?.settings ?? NO_SETTINGS
  const row = await User.get(userId)
  if (!row) throw new DomainError('not_found', 'no such user')
  if (o.validate !== false) {
    const problems = validatePassword(raw, s, row)
    if (problems.length) throw new DomainError('invalid_param', problems.join(' '), 'password')
  }
  await passwordChanged(await User.update(userId, { password: await makePassword(raw, s) }), o.ctx)
}
// the side effects of any password write (setPassword, the admin's change form)
export async function passwordChanged(row: { id: number; password: string }, ctx?: Pick<ActionCtx, 'session' | 'settings'>): Promise<void> {
  await revokeTokens(row.id)
  if (ctx) updateSessionAuthHash(ctx, row)
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
