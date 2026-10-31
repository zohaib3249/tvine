// tvine.auth models (docs/design/contrib/auth.md §1). Tables are prefixed auth_; m2m links are join models.
import { defineModel } from '../../data/model.js'
import { field } from '../../data/fields.js'

export const User = defineModel('auth_user', {
  id: field.id(),
  username: field.text({ unique: true, searchable: true }),
  email: field.text({ optional: true, index: true }),
  password: field.text({ hidden: true }),            // encoded hash (hashers.ts); '!…' = unusable
  isActive: field.bool({ default: true }),
  isStaff: field.bool({ default: false }),
  isSuperuser: field.bool({ default: false }),
  lastLogin: field.datetime({ optional: true }),
  dateJoined: field.datetime({ auto: true }),
})

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
  user: field.fk(() => User),
  group: field.fk(() => Group),
}, { indexes: [{ fields: ['user', 'group'], name: 'auth_user_groups_uniq', unique: true }] })

export const UserPermission = defineModel('auth_user_permissions', {
  id: field.id(),
  user: field.fk(() => User),
  permission: field.fk(() => Permission),
}, { indexes: [{ fields: ['user', 'permission'], name: 'auth_user_permissions_uniq', unique: true }] })

export const GroupPermission = defineModel('auth_group_permissions', {
  id: field.id(),
  group: field.fk(() => Group),
  permission: field.fk(() => Permission),
}, { indexes: [{ fields: ['group', 'permission'], name: 'auth_group_permissions_uniq', unique: true }] })

export const Token = defineModel('auth_token', {
  id: field.id(),
  user: field.fk(() => User),
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
  user: field.fk(() => User, { unique: true }),
  secret: field.text({ hidden: true }),               // AES-256-GCM under a key derived from settings.secret
  confirmed: field.bool({ default: false }),
  lastStep: field.int({ default: 0 }),                // replay guard: a code's step must be above this
})

export const RecoveryCode = defineModel('auth_recovery_code', {
  id: field.id(),
  user: field.fk(() => User, { index: true }),
  digest: field.text({ hidden: true }),
  usedAt: field.datetime({ optional: true }),
})

// a signed-in browser / client (auth.sessions): the session holds a random key, this row its sha256 (the id users
// see; never the sid). Deleting the row signs that session out on its next request (memory or redis store alike).
export const UserSession = defineModel('auth_session', {
  id: field.id(),
  user: field.fk(() => User, { index: true, onDelete: 'CASCADE' }),
  key: field.text({ unique: true, hidden: true }),    // sha256 hex of the session's _auth_session_key
  ip: field.text(),
  userAgent: field.text(),                            // first 300 chars
  createdAt: field.datetime({ auto: true }),
  lastSeen: field.datetime(),
})

// devices a user signed in from before (security notifications: "new sign-in"): HMAC of UA + ip /24, never the raw pair
export const KnownDevice = defineModel('auth_known_device', {
  id: field.id(),
  user: field.fk(() => User, { index: true, onDelete: 'CASCADE' }),
  digest: field.text({ hidden: true }),
  lastSeen: field.datetime(),
}, { indexes: [{ fields: ['user', 'digest'], name: 'auth_known_device_uniq', unique: true }] })
