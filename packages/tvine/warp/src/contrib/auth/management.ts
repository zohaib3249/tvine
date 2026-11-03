// tvine createsuperuser / changepassword. The CLI configures the database and
// passes a prompt; nothing here prints a password.
import type { Settings } from '../../core/types.js'
import { getUserModel, userMeta } from './models.js'
import { validatePassword } from './passwords.js'
import { createSuperuser, setPassword } from './users.js'

export type Prompt = (question: string, o?: { hidden?: boolean }) => Promise<string>
interface Out { out(s: string): void; err(s: string): void }

async function askPassword(prompt: Prompt, io: Out, s: Settings, user: Record<string, unknown>): Promise<string> {
  for (;;) {
    const a = await prompt('Password: ', { hidden: true })
    const b = await prompt('Password (again): ', { hidden: true })
    if (a !== b) { io.err("Error: Your passwords didn't match."); continue }
    const problems = validatePassword(a, s, user)
    if (!problems.length) return a
    io.err(problems.join('\n'))
  }
}

// createsuperuser on getUserModel(): its usernameField, then each of its requiredFields, then the password.
// --noinput reads TVINE_SUPERUSER_<FIELD> (USERNAME for the usernameField, EMAIL, PHONE…) and TVINE_SUPERUSER_PASSWORD;
// --username / --email flags win.
const envName = (f: string) => `TVINE_SUPERUSER_${f.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
const label = (f: string) => { const s = f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(); return s[0]!.toUpperCase() + s.slice(1) }
export async function createsuperuser(o: { username?: string; email?: string; noinput: boolean; settings: Settings; prompt?: Prompt; env?: NodeJS.ProcessEnv }, io: Out): Promise<number> {
  // intentional CLI exception to the env.ts allowlist: --noinput reads TVINE_SUPERUSER_* from the process env (or o.env in tests)
  const env = o.env ?? process.env, User = getUserModel(), { usernameField: uf, requiredFields } = userMeta()
  const taken = async (v: string) => !!(await User.objects.filter({ [uf]: v }).first())
  const given = (f: string): string | undefined =>
    (f === uf ? o.username : f === 'email' ? o.email : undefined) ?? (o.noinput ? env[f === uf ? 'TVINE_SUPERUSER_USERNAME' : envName(f)] : undefined)
  const values: Record<string, unknown> = {}
  let password: string | undefined
  if (o.noinput) {
    password = env.TVINE_SUPERUSER_PASSWORD
    if (!given(uf)) { io.err(`createsuperuser --noinput: set --username or TVINE_SUPERUSER_USERNAME (the ${uf})`); return 1 }
    for (const f of [uf, ...requiredFields]) {
      const v = given(f)
      if (v === undefined && f !== 'email') { io.err(`createsuperuser --noinput: set ${envName(f)}`); return 1 }
      if (v !== undefined) values[f] = v
    }
    if (!password) { io.err('createsuperuser --noinput: set TVINE_SUPERUSER_PASSWORD'); return 1 }
  } else {
    if (!o.prompt) { io.err('createsuperuser: no terminal; use --noinput'); return 1 }
    let name = given(uf)
    while (!name) {
      name = (await o.prompt(`${label(uf)}: `)).trim()
      if (name && (await taken(name))) { io.err(`Error: That ${label(uf).toLowerCase()} is already taken.`); name = undefined }
    }
    values[uf] = name
    for (const f of requiredFields) {
      let v = given(f)
      // email is in the built-in REQUIRED_FIELDS but may be blank
      while (v === undefined) { v = (await o.prompt(`${label(f)}${f === 'email' ? ' address' : ''}: `)).trim(); if (!v && f === 'email') break; if (!v) v = undefined }
      if (v) values[f] = v
    }
    password = await askPassword(o.prompt, io, o.settings, { ...values, username: name, email: values.email ?? '' })
  }
  if (await taken(String(values[uf]))) { io.err(`Error: That ${label(uf).toLowerCase()} is already taken.`); return 1 }
  try {
    await createSuperuser({ ...values, password }, { settings: o.settings })
  } catch (e) { io.err(`Error: ${(e as Error).message}`); return 1 }
  io.out('Superuser created successfully.')
  return 0
}

export async function changepassword(o: { username: string; settings: Settings; prompt?: Prompt }, io: Out): Promise<number> {
  const row = await getUserModel().objects.filter({ [userMeta().usernameField]: o.username }).first()
  if (!row) { io.err(`Error: user '${o.username}' does not exist`); return 1 }
  if (!o.prompt) { io.err('changepassword: needs a terminal'); return 1 }
  io.out(`Changing password for user '${o.username}'`)
  const pw = await askPassword(o.prompt, io, o.settings, row)
  await setPassword(row.id, pw, { settings: o.settings, validate: false })   // validated above
  io.out(`Password changed successfully for user '${o.username}'`)
  return 0
}
