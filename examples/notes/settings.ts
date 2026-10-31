// Django settings.py. Everything not named here is a default (docs/design/conventions/settings.md).
import { defineSettings } from '@tvine/warp'

export default defineSettings({
  site: { name: 'Notes', description: 'A tiny notes app built on Tvine.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin'],   // users, background jobs, /admin
})
