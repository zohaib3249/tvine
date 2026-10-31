// Installed apps (Django INSTALLED_APPS): every apps/<label>/ folder of the project, plus the built-in apps
// settings.installedApps enables. 'tvine.<name>' → <warp>/src|dist/contrib/<name>/, shaped like a project app
// (models, views, rules, serializers, middleware, hooks, migrations/); its app label is <name>. Contrib
// migrations ship with the package: makemigrations never writes them.
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppEntry { label: string; dir: string; contrib: boolean }

export const INSTALLED_RE = /^tvine\.([a-z][a-z0-9_]*)$/

// Replaceable root (tests point it at fixtures, like server.ts appResolver). Plain import.meta.url, no
// `new URL(x, import.meta.url)`: bundlers treat that form as an asset reference.
export const contrib = { root: join(dirname(fileURLToPath(import.meta.url)), '..', 'contrib') }

// settings.installedApps → contrib entries, in the listed order. Unknown or repeated names fail at boot.
export function contribApps(installed: readonly string[] = []): AppEntry[] {
  const seen = new Set<string>()
  return installed.map((name) => {
    const m = INSTALLED_RE.exec(name)
    if (!m) throw new Error(`settings.installedApps: "${name}" is not a built-in app name (tvine.<name>); project apps under apps/ are found without listing them`)
    const label = m[1]!
    const dir = join(contrib.root, label)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`settings.installedApps: unknown built-in app "${name}"`)
    if (seen.has(label)) throw new Error(`settings.installedApps: "${name}" is listed twice`)
    seen.add(label)
    return { label, dir, contrib: true }
  })
}

// Project apps (sorted folder names) first, then the enabled contrib apps. A project folder with a contrib
// app's label is a boot error: ids, tables and migrations would collide.
export function installedApps(appsDir: string, installed: readonly string[] = []): AppEntry[] {
  const builtIn = contribApps(installed)
  const own = readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  for (const c of builtIn) {
    if (own.includes(c.label)) throw new Error(`apps/${c.label} clashes with the built-in app tvine.${c.label} (settings.installedApps): rename the folder`)
  }
  return [...own.map((label) => ({ label, dir: join(appsDir, label), contrib: false })), ...builtIn]
}

export const contribLabels = (installed: readonly string[] = []) => new Set(contribApps(installed).map((a) => a.label))
