// tvine.auth models (docs/design/contrib/auth.md §1). Tables are prefixed auth_; m2m links are join models.
import { defineModel, type Model } from '../../data/model.js'
import { field, type Fields, type ModelMeta } from '../../data/fields.js'
import { modelNamed } from '../../data/registry.js'
import { setRowProto } from '../../data/table.js'
import { userModelLabel, userSwapped, userTable } from '../../data/swappable.js'
import { userMethods } from './user.js'

// Django AbstractBaseUser + PermissionsMixin: what every user model has (defineUserModel adds the missing ones)
const BASE_USER = {
  id: field.id(),
  password: field.text({ hidden: true }),            // encoded hash (hashers.ts); '!…' = unusable
  isActive: field.bool({ default: true }),
  isStaff: field.bool({ default: false }),
  isSuperuser: field.bool({ default: false }),
  lastLogin: field.datetime({ optional: true }),
}
// Django AbstractUser: the built-in auth.User's fields (extendUser starts from these)
export const USER_FIELDS = {
  ...BASE_USER,
  username: field.text({ unique: true, searchable: true }),
  email: field.text({ optional: true, index: true }),
  firstName: field.text({ default: '' }),
  lastName: field.text({ default: '' }),
  dateJoined: field.datetime({ auto: true }),
}

// Django USERNAME_FIELD / REQUIRED_FIELDS / EMAIL_FIELD, per user model
export interface UserOptions { name?: string; usernameField?: string; requiredFields?: string[]; emailField?: string | null; meta?: ModelMeta }
export interface UserMeta { usernameField: string; requiredFields: string[]; emailField: string | null }
const metas = new WeakMap<object, UserMeta>()
export const userMeta = (m: object = getUserModel()): UserMeta => metas.get(m) ?? { usernameField: 'username', requiredFields: ['email'], emailField: 'email' }

// Django AbstractBaseUser: a fully custom user model. `fields` + the base ones (id, password, isActive, isStaff,
// isSuperuser, lastLogin). Its table is the configured settings.auth.userModel's ('accounts.User' → accounts_user).
export function defineUserModel<const F extends Fields>(fields: F, o: UserOptions = {}) {
  const name = o.name ?? (userSwapped() ? userTable() : undefined)
  if (!name) throw new Error("defineUserModel: set settings.auth.userModel (e.g. 'accounts.User') first, or pass { name }")
  const all = { ...BASE_USER, ...fields }
  const usernameField = o.usernameField ?? 'username'
  const uf = (all as Fields)[usernameField]
  if (!uf) throw new Error(`${name}: usernameField "${usernameField}" is not a field`)
  if (!uf.opts.unique) throw new Error(`${name}: usernameField "${usernameField}" must be unique: true`)
  const requiredFields = o.requiredFields ?? []
  if (requiredFields.includes(usernameField)) throw new Error(`${name}: requiredFields must not contain the usernameField "${usernameField}"`)
  for (const r of requiredFields) if (!(all as Fields)[r]) throw new Error(`${name}: requiredFields: no field "${r}"`)
  const emailField = o.emailField === undefined ? ('email' in all ? 'email' : null) : o.emailField
  const model = defineModel(name, all as typeof BASE_USER & F, o.meta)
  metas.set(model, { usernameField, requiredFields, emailField })
  setRowProto(model.fields, Object.create(userMethods, { USERNAME_FIELD: { value: usernameField } }))   // Django's class attribute
  return model
}

// Django AbstractUser subclass: every built-in field (username, email, names, flags, dates) plus `extra`
export const extendUser = <const F extends Fields>(extra: F, o: UserOptions = {}) =>
  defineUserModel({ ...USER_FIELDS, ...extra } as typeof USER_FIELDS & F, { usernameField: 'username', requiredFields: ['email'], ...o })

export const User = defineUserModel(USER_FIELDS, { name: 'auth_user', usernameField: 'username', requiredFields: ['email'] })

// Django get_user_model(): settings.auth.userModel's model (the built-in User by default). A custom one must be
// loaded (its app's models.ts imported) first; boot and every management command do that.
export function getUserModel(): Model<typeof USER_FIELDS> {
  if (!userSwapped()) return User
  const m = modelNamed<Model<typeof USER_FIELDS>>(userTable())
  if (!m) throw new Error(`settings.auth.userModel is '${userModelLabel()}' but no model ${userTable()} is loaded: export it from apps/${userModelLabel().split('.')[0]}/models.ts (extendUser / defineUserModel)`)
  return m
}
const theUser = () => getUserModel()

export const Group = defineModel('auth_group', {
  id: field.id(),
  name: field.text({ unique: true }),
})

export const Permission = defineModel('auth_permission', {
  id: field.id(),
  codename: field.text({ unique: true }),             // '<app>.<action>_<model>'
  app: field.text(),
  model: field.text(),
  name: field.text(),
})

export const UserGroup = defineModel('auth_user_groups', {
  id: field.id(),
  user: field.fk(theUser),
  group: field.fk(() => Group),
}, { indexes: [{ fields: ['user', 'group'], name: 'auth_user_groups_uniq', unique: true }] })

export const UserPermission = defineModel('auth_user_permissions', {
  id: field.id(),
  user: field.fk(theUser),
  permission: field.fk(() => Permission),
}, { indexes: [{ fields: ['user', 'permission'], name: 'auth_user_permissions_uniq', unique: true }] })

export const GroupPermission = defineModel('auth_group_permissions', {
  id: field.id(),
  group: field.fk(() => Group),
  permission: field.fk(() => Permission),
}, { indexes: [{ fields: ['group', 'permission'], name: 'auth_group_permissions_uniq', unique: true }] })

export const Token = defineModel('auth_token', {
  id: field.id(),
  user: field.fk(theUser),
  name: field.text(),
  key: field.text({ unique: true }),                  // public lookup id (the token's second part)
  digest: field.text({ hidden: true }),               // sha256 hex of the whole token
  scopes: field.json(),
  createdAt: field.datetime({ auto: true }),
  expiresAt: field.datetime({ optional: true }),
  lastUsed: field.datetime({ optional: true }),
  revoked: field.bool({ default: false }),
})

export const Totp = defineModel('auth_totp', {
  id: field.id(),
  user: field.fk(theUser, { unique: true }),
  secret: field.text({ hidden: true }),               // AES-256-GCM under a key derived from settings.secret
  confirmed: field.bool({ default: false }),
  lastStep: field.int({ default: 0 }),                // replay guard: a code's step must be above this
})

export const RecoveryCode = defineModel('auth_recovery_code', {
  id: field.id(),
  user: field.fk(theUser, { index: true }),
  digest: field.text({ hidden: true }),
  usedAt: field.datetime({ optional: true }),
})

// a signed-in browser / client (auth.sessions): the session holds a random key, this row its sha256 (the id users
// see; never the sid). Deleting the row signs that session out on its next request (memory or redis store alike).
export const UserSession = defineModel('auth_session', {
  id: field.id(),
  user: field.fk(theUser, { index: true, onDelete: 'CASCADE' }),
  key: field.text({ unique: true, hidden: true }),    // sha256 hex of the session's _auth_session_key
  ip: field.text(),
  userAgent: field.text(),                            // first 300 chars
  createdAt: field.datetime({ auto: true }),
  lastSeen: field.datetime(),
})

// devices a user signed in from before (security notifications: "new sign-in"): HMAC of UA + ip /24, never the raw pair
export const KnownDevice = defineModel('auth_known_device', {
  id: field.id(),
  user: field.fk(theUser, { index: true, onDelete: 'CASCADE' }),
  digest: field.text({ hidden: true }),
  lastSeen: field.datetime(),
}, { indexes: [{ fields: ['user', 'digest'], name: 'auth_known_device_uniq', unique: true }] })
