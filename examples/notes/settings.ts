// All settings, one file. Everything not named here is a default (docs/design/conventions/settings.md).
import { defineSettings } from 'tvine'

export default defineSettings({
  site: { name: 'Notes', description: 'A tiny notes app built on Tvine.' },
  installedApps: ['tvine.auth', 'tvine.tasks', 'tvine.admin', 'notes'],   // users, background jobs, /admin, apps/notes
  mcp: { exclude: ['admin.*'] },   // agents use the admin through its UI; keeps notes_* among the typed MCP tools (BACKLOG #42)
})
