// tvine.tasks' own tasks (discovered like an app's tasks.ts): `tasks.sendMail` carries sendMail(..., { background: true }).
import { EmailMessage, type MailJSON } from '../../mail/index.js'
import { defineTask } from './task.js'

// args hold addresses and bodies (a reset link): never logged
export const sendMail = defineTask('sendMail', async (m) => EmailMessage.fromJSON(m as MailJSON).send(), { maxRetries: 3, retryBackoff: { baseMs: 30_000 }, logArgs: false })
