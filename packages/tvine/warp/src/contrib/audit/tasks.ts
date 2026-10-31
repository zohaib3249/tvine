// tvine.audit beat schedule (only when tvine.tasks is installed and a beat runs): prune daily at 03:00.
import { defineTask } from '../tasks/task.js'
import { pruneAudit } from './prune.js'

export const prune = defineTask('prune', async () => ({ deleted: await pruneAudit() }), { schedule: { cron: '0 3 * * *' } })
