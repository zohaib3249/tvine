// tvine createsuperuser / changepassword (Django management commands). The CLI configures the database and
// passes a prompt; nothing here prints a password.
import type { Settings } from '../../core/types.js'
import { User } from './models.js'
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

// --noinput: TVINE_SUPERUSER_USERNAME / _EMAIL / _PASSWORD (flags win for username/email)
export async function createsuperuser(o: { username?: string; email?: string; noinput: boolean; settings: Settings; prompt?: Prompt; env?: NodeJS.ProcessEnv }, io: Out): Promise<number> {
  const env = o.env ?? process.env
  let username = o.username ?? (o.noinput ? env.TVINE_SUPERUSER_USERNAME : undefined)
  let email = o.email ?? (o.noinput ? env.TVINE_SUPERUSER_EMAIL : undefined)
  let password: string | undefined
  if (o.noinput) {
    password = env.TVINE_SUPERUSER_PASSWORD
    if (!username) { io.err('createsuperuser --noinput: set --username or TVINE_SUPERUSER_USERNAME'); return 1 }
    if (!password) { io.err('createsuperuser --noinput: set TVINE_SUPERUSER_PASSWORD'); return 1 }
  } else {
    if (!o.prompt) { io.err('createsuperuser: no terminal; use --noinput'); return 1 }
    while (!username) {
      username = (await o.prompt('Username: ')).trim()
      if (username && (await User.objects.filter({ username }).first())) { io.err('Error: That username is already taken.'); username = undefined }
    }
    email ??= (await o.prompt('Email address: ')).trim() || undefined
    password = await askPassword(o.prompt, io, o.settings, { username, email: email ?? '' })
  }
  if (await User.objects.filter({ username }).first()) { io.err('Error: That username is already taken.'); return 1 }
  try {
    await createSuperuser({ username, email: email ?? null, password }, { settings: o.settings })
  } catch (e) { io.err(`Error: ${(e as Error).message}`); return 1 }
  io.out('Superuser created successfully.')
  return 0
}

export async function changepassword(o: { username: string; settings: Settings; prompt?: Prompt }, io: Out): Promise<number> {
  const row = await User.objects.filter({ username: o.username }).first()
  if (!row) { io.err(`Error: user '${o.username}' does not exist`); return 1 }
  if (!o.prompt) { io.err('changepassword: needs a terminal'); return 1 }
  io.out(`Changing password for user '${row.username}'`)
  const pw = await askPassword(o.prompt, io, o.settings, row)
  await setPassword(row.id, pw, { settings: o.settings, validate: false })   // validated above
  io.out(`Password changed successfully for user '${row.username}'`)
  return 0
}
