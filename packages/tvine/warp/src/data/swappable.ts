// Django AUTH_USER_MODEL: which model is "the user" ('app.Model'), set once from settings.auth.userModel at boot
// (loadSettings) before any model or migration loads. A custom model's table is Django's default db_table:
// '<app>_<model lowercased>' ('accounts.User' → accounts_user). The ORM, the migration graph and tvine.auth read it.
export const DEFAULT_USER_MODEL = 'auth.User'
const LABEL = /^[a-z][a-z0-9_]*\.[A-Za-z]\w*$/
let label = DEFAULT_USER_MODEL

export function setUserModelLabel(l: string = DEFAULT_USER_MODEL): void {
  if (!LABEL.test(l)) throw new Error(`settings.auth.userModel: "${l}" is not 'app.Model' (e.g. 'accounts.User')`)
  label = l
}
export const userModelLabel = () => label
export const userModelApp = () => label.split('.')[0]!
export const userTable = () => label === DEFAULT_USER_MODEL ? 'auth_user' : label.replace('.', '_').toLowerCase()
export const userSwapped = () => label !== DEFAULT_USER_MODEL
