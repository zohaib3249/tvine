// tvine.auth 0002 — sessions list (auth.sessions) and known devices (security notifications). Hand-written like 0001.
import { field, migration, ops } from '../../../data/migrations.js'

export default migration({
  dependencies: [['auth', '0001_initial']],
  operations: [
    ops.createModel('auth_session', {
      id: field.id(),
      user: field.fk('auth_user', { index: true, onDelete: 'CASCADE' }),
      key: field.text({ unique: true }),
      ip: field.text(),
      userAgent: field.text(),
      createdAt: field.datetime({ auto: true }),
      lastSeen: field.datetime(),
    }),
    ops.createModel('auth_known_device', {
      id: field.id(),
      user: field.fk('auth_user', { index: true, onDelete: 'CASCADE' }),
      digest: field.text(),
      lastSeen: field.datetime(),
    }),
    ops.addIndex('auth_known_device', 'auth_known_device_uniq', ['user', 'digest'], { unique: true }),
  ],
})
