// tvine.auth lifecycle: ready() installs request.user resolution; postMigrate() creates permission rows
// (on postMigrate): add/change/delete/view for every model of every installed app.
import { setAuthBackend } from '../../core/auth.js'
import type { ServerCtx } from '../../core/dispatch.js'
import type { PostMigrate } from '../../data/migrate.js'
import { permCodename } from '../../security/permissions.js'
import { backendFor } from './backend.js'
import { Permission } from './models.js'

export function ready(server: ServerCtx): void {
  setAuthBackend(server.settings, backendFor(server.settings))
}

const ACTIONS = ['add', 'change', 'delete', 'view'] as const
export async function postMigrate(e: PostMigrate): Promise<void> {
  const want = new Map<string, { app: string; model: string; name: string }>()
  for (const [app, models] of Object.entries(e.models)) {
    for (const m of models) for (const a of ACTIONS) want.set(permCodename(app, a, m.name), { app, model: m.name, name: `Can ${a} ${m.name}` })
  }
  const have = new Set((await Permission.objects.all()).map((p) => p.codename))
  for (const [codename, p] of want) if (!have.has(codename)) await Permission.create({ codename, ...p })
}
