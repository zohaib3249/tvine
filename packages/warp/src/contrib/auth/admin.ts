// tvine.auth in tvine.admin (Django UserAdmin / GroupAdmin). Loaded by the admin's autodiscover only when
// 'tvine.admin' is installed. The password is hashed by the admin's save (any model's password field goes through
// tvine.auth's hasher) and never read back
// (a hidden field: never in admin values); the change form sets a new one, or the set-password view.
import { DomainError } from '../../core/errors.js'
import { path } from '../../urls.js'
import { ModelAdmin, type Ctx } from '../admin/options.js'
import { site } from '../admin/sites.js'
import { logAction } from '../admin/views.js'
import { CHANGE } from '../admin/models.js'
import { Group, User } from './models.js'
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

export class UserAdmin extends ModelAdmin<UserRow> {
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
  agents = false
  str(u: Record<string, unknown>) { return String(u.username) }

  async saveModel(ctx: Ctx, obj: UserRow | undefined, values: Record<string, unknown>): Promise<UserRow> {
    if (!obj && typeof values.password !== 'string') throw new DomainError('invalid_param', 'password: This field is required.', 'password')
    // Django ReadOnlyPasswordHashField: an existing user's password changes only through the password view (setPassword)
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
    await setPassword(id, pw, { settings: ctx.settings })
    await logAction(ctx, this.key(), id, this.str(u as never), CHANGE, [{ changed: { fields: ['Password'] } }])
    return { ok: true }
  }
}

export class GroupAdmin extends ModelAdmin {
  agents = false
  searchFields = ['name']
  ordering = ['name']
}

site.register(User, UserAdmin)
site.register(Group, GroupAdmin)
