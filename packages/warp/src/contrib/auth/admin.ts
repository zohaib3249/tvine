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
import { passwordChanged, setPassword } from './users.js'

type UserRow = typeof User extends { create(d: never): Promise<infer R> } ? R : never

export class UserAdmin extends ModelAdmin<UserRow> {
  agents: boolean | 'confirm' = 'confirm'   // an agent's change to accounts needs the user (secreview-3 M3); app: agents = true
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
    const row = await super.saveModel(ctx, obj, values)
    if (obj && typeof values.password === 'string') await passwordChanged(row as never, ctx)   // tokens revoked, own session kept
    return row
  }

  getUrls() {
    return [path('<int:id>/password/', this.view(this.userChangePassword, { permission: 'change', title: 'Change password' }), { name: 'password_change' })]
  }
  // Django user_change_password: validators run, the hasher encodes
  async userChangePassword(params: Record<string, unknown>, ctx: Ctx) {
    const id = Number(params.id), pw = params.password
    if (!Number.isInteger(id) || typeof pw !== 'string' || !pw) throw new DomainError('invalid_param', 'password: This field is required.', 'password')
    const u = await this.getObject(ctx, id)
    if (!u) throw new DomainError('not_found', 'user not found')
    await setPassword(id, pw, { ctx })
    await logAction(ctx, this.key(), id, this.str(u as never), CHANGE, [{ changed: { fields: ['Password'] } }])
    return { ok: true }
  }
}

export class GroupAdmin extends ModelAdmin {
  agents: boolean | 'confirm' = 'confirm'
  searchFields = ['name']
  ordering = ['name']
}

site.register(User, UserAdmin)
site.register(Group, GroupAdmin)
