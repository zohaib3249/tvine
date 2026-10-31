// tvine.auth in tvine.admin (Django UserAdmin / GroupAdmin). Loaded by the admin's autodiscover only when
// 'tvine.admin' is installed. The password is hashed by the admin's save (any model's password field goes through
// tvine.auth's hasher) and never read back
// (a hidden field: never in admin values); the add form sets the first one, the set-password view every later one.
import { DomainError } from '../../core/errors.js'
import { path } from '../../urls.js'
import { ModelAdmin, TabularInline, type Ctx } from '../admin/options.js'
import { site } from '../admin/sites.js'
import { logAction } from '../admin/views.js'
import { CHANGE } from '../admin/models.js'
import { Group, User, UserSession } from './models.js'
import { setPassword } from './users.js'
import { AuthUser, recentlyAuthenticated } from './backend.js'

type UserRow = typeof User extends { create(d: never): Promise<infer R> } ? R : never

// secreview M1, sudo mode (Laravel password.confirm): staff/superuser flags and passwords change only from a session
// that typed its password in the last RECENT_MS, never from a token. A project's own settings.auth.user has no
// password here to confirm: its own auth decides.
const SENSITIVE = ['password', 'isStaff', 'isSuperuser'] as const
function sudo(ctx: Ctx): void {
  const u = ctx.request.user
  if (!(u instanceof AuthUser)) return
  if (u.via !== 'session') throw new DomainError('forbidden', 'forbidden: sign in with a password for this')
  if (!recentlyAuthenticated(ctx)) throw new DomainError('reauth_required', 'sign in again to change passwords or staff/superuser flags (sudo mode: 10 minutes)')
}

// the user's signed-in sessions, read-only; deleting a row signs that session out (staff with auth.delete_usersession)
export class SessionInline extends TabularInline {
  model = UserSession
  fields = ['ip', 'userAgent', 'createdAt', 'lastSeen']
  readonlyFields = ['ip', 'userAgent', 'createdAt', 'lastSeen']
  extra = 0
  verboseNamePlural = 'Sessions'
  hasAddPermission() { return false }
  hasChangePermission() { return false }
}

export class UserAdmin extends ModelAdmin<UserRow> {
  inlines = [SessionInline]
  // secreview-1 M1 (owner brief): no agents at all on accounts, stricter than secreview-3 M3's 'confirm'.
  // An app may opt in with agents = 'confirm' (an agent's change then needs the user) or true.
  agents: boolean | 'confirm' = false
  listDisplay = ['username', 'email', 'isStaff', 'isActive']
  listFilter = ['isStaff', 'isSuperuser', 'isActive']
  searchFields = ['username', 'email']
  ordering = ['username']
  readonlyFields = ['lastLogin', 'dateJoined']
  fieldsets: ModelAdmin['fieldsets'] = [
    [null, { fields: ['username', 'password'] }],
    ['Personal info', { fields: ['email'] }],
    ['Permissions', { fields: ['isActive', 'isStaff', 'isSuperuser'] }],
    ['Important dates', { fields: ['lastLogin', 'dateJoined'] }],
  ]
  str(u: Record<string, unknown>) { return String(u.username) }

  async saveModel(ctx: Ctx, obj: UserRow | undefined, values: Record<string, unknown>): Promise<UserRow> {
    if (!obj && typeof values.password !== 'string') throw new DomainError('invalid_param', 'password: This field is required.', 'password')
    // Django ReadOnlyPasswordHashField: an existing user's password changes only through the password view, so every
    // admin password change runs setPassword once (validators + passwordChanged: tokens revoked, own session kept)
    if (obj && 'password' in values) throw new DomainError('invalid_param', 'password: use the Change password form', 'password')
    if (SENSITIVE.some((k) => k in values && (!obj || values[k] !== (obj as Record<string, unknown>)[k]))) sudo(ctx)
    return super.saveModel(ctx, obj, values)
  }

  getUrls() {
    return [path('<int:id>/password/', this.view(this.userChangePassword, { permission: 'change', title: 'Change password' }), { name: 'password_change' })]
  }
  // Django user_change_password: validators run, the hasher encodes
  async userChangePassword(params: Record<string, unknown>, ctx: Ctx) {
    const id = Number(params.id), pw = params.password
    if (!Number.isInteger(id) || typeof pw !== 'string' || !pw) throw new DomainError('invalid_param', 'password: This field is required.', 'password')
    sudo(ctx)
    const u = await this.getObject(ctx, id)
    if (!u) throw new DomainError('not_found', 'user not found')
    await setPassword(id, pw, { ctx })
    await logAction(ctx, this.key(), id, this.str(u as never), CHANGE, [{ changed: { fields: ['Password'] } }])
    return { ok: true }
  }
}

export class GroupAdmin extends ModelAdmin {
  agents: boolean | 'confirm' = false   // as UserAdmin
  searchFields = ['name']
  ordering = ['name']
}

site.register(User, UserAdmin)
site.register(Group, GroupAdmin)
