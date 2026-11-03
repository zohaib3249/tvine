// Installed apps: exactly what settings.installedApps lists. A plain name 'blog' is the
// project app apps/blog/; 'tvine.<name>' is a built-in app, <warp>/src|dist/contrib/<name>/, shaped like a project
// app (models, views, rules, serializers, middleware, hooks, migrations/); its app label is <name>. Contrib
// migrations ship with the package: makemigrations never writes them. A folder in apps/ that is not listed is
// not loaded (tvine check warns: unlistedApps).
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
  return installed.filter((n) => n.startsWith('tvine.')).map((name) => {
    const m = INSTALLED_RE.exec(name)
    if (!m) throw new Error(`settings.installedApps: "${name}" is not a built-in app name (tvine.<name>)`)
    const label = m[1]!
    const dir = join(contrib.root, label)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`settings.installedApps: unknown built-in app "${name}"`)
    if (seen.has(label)) throw new Error(`settings.installedApps: "${name}" is listed twice`)
    seen.add(label)
    return { label, dir, contrib: true }
  })
}

// Listed project apps (in the listed order) first, then the listed built-in apps. A listed app with no folder,
// a name listed twice, or a project app named like a listed built-in one is a boot error.
export function installedApps(appsDir: string, installed: readonly string[] = []): AppEntry[] {
  const builtIn = contribApps(installed)
  const own = installed.filter((n) => !n.startsWith('tvine.'))
  const seen = new Set<string>()
  for (const label of own) {
    if (seen.has(label)) throw new Error(`settings.installedApps: "${label}" is listed twice`)
    seen.add(label)
    if (builtIn.some((c) => c.label === label)) throw new Error(`apps/${label} clashes with the built-in app tvine.${label} (settings.installedApps): rename the folder`)
    if (!statSync(join(appsDir, label), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`settings.installedApps: "${label}" has no folder ${join(appsDir, label)} (create it with tvine startapp ${label})`)
  }
  return [...own.map((label) => ({ label, dir: join(appsDir, label), contrib: false })), ...builtIn]
}

// apps/<x>/ folders that settings.installedApps does not list (tvine check warns about each)
export function unlistedApps(appsDir: string, installed: readonly string[] = []): string[] {
  if (!statSync(appsDir, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !installed.includes(d.name)).map((d) => d.name).sort()
}

export const contribLabels = (installed: readonly string[] = []) => new Set(contribApps(installed).map((a) => a.label))

// every built-in app label (the folders under contrib/): a project app may not take one of these names
export const builtInLabels = (): string[] =>
  readdirSync(contrib.root, { withFileTypes: true }).filter((d) => d.isDirectory() && INSTALLED_RE.test(`tvine.${d.name}`)).map((d) => d.name).sort()
