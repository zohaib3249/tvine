// One logger for tvine.auth (passwords, views, notify, …). Do not `getLogger('tvine.auth')` again per file.
import { getLogger } from '../../log.js'

export const authLog = getLogger('tvine.auth')
