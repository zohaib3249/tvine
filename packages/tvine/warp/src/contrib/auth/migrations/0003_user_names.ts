// tvine.auth 0003 — ships with Tvine: Django AbstractUser's first_name / last_name (user.getFullName())
import { field, migration, ops } from '../../../data/migrations.js'

export default migration({
  dependencies: [['auth', '0002_sessions']],
  operations: [
    ops.addField('auth_user', 'firstName', field.text({ default: '' })),
    ops.addField('auth_user', 'lastName', field.text({ default: '' })),
  ],
})
