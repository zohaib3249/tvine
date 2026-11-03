// env — typed environment variables and .env loading (docs/design/conventions/env.md).
// With settings.ts, the only warp module that reads process.env; everything else reads settings.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

// Every variable the framework itself reads (docs/design/conventions/env.md has the table). `tvine check` prints
// which are set — names only, never values.
export const FRAMEWORK_ENV = [
  'NODE_ENV', 'TVINE_SECRET', 'DATABASE_URL', 'REDIS_URL', 'TVINE_ALLOWED_HOSTS', 'TVINE_DEV_ALLOWED_HOSTS', 'TVINE_DEBUG', 'TVINE_TRUST_PROXY',
  'TVINE_SESSION_SECURE', 'TVINE_LOAD_DOTENV', 'TVINE_ENV_FILES', 'PORT', 'HOST', 'TVINE_API_URL', 'TVINE_COOKIE_NAME', 'TVINE_SESSION_TTL_S', 'TVINE_SUPERUSER_USERNAME',
  'TVINE_SUPERUSER_EMAIL', 'TVINE_SUPERUSER_PASSWORD', 'WEB_CONCURRENCY', 'TVINE_WORKER', 'NODE_APP_INSTANCE', 'pm_id',
] as const

class EnvError extends Error {}
const raw = (name: string): string | undefined => {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}
// a missing variable with no default is a boot error naming it (never its value)
const need = <T>(name: string, v: T | undefined, d: T | undefined): T => {
  if (v !== undefined) return v
  if (d !== undefined) return d
  throw new EnvError(`environment variable ${name} is not set`)
}
const bad = (name: string, what: string) => new EnvError(`environment variable ${name} is not ${what}`)

const base = {
  str: (name: string, d?: string): string => need(name, raw(name), d),
  int(name: string, d?: number): number {
    const v = raw(name)
    if (v === undefined) return need(name, undefined, d)
    if (!/^-?\d+$/.test(v.trim())) throw bad(name, 'an integer')
    return Number(v)
  },
  bool(name: string, d?: boolean): boolean {
    const v = raw(name)?.trim().toLowerCase()
    if (v === undefined) return need(name, undefined, d)
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
    throw bad(name, 'a boolean (1/0, true/false, yes/no, on/off)')
  },
  list(name: string, d?: string[]): string[] {
    const v = raw(name)
    return v === undefined ? need(name, undefined, d) : v.split(',').map((s) => s.trim()).filter(Boolean)
  },
  url(name: string, d?: string): URL {
    const v = raw(name) ?? d
    if (v === undefined) return need<URL>(name, undefined, undefined)
    try { return new URL(v) } catch { throw bad(name, 'a URL') }
  },
  json<T = unknown>(name: string, d?: T): T {
    const v = raw(name)
    if (v === undefined) return need(name, undefined, d)
    try { return JSON.parse(v) as T } catch { throw bad(name, 'valid JSON') }
  },
  required: (name: string): string => need(name, raw(name), undefined),
  has: (name: string): boolean => raw(name) !== undefined,
}
// the same readers under get* names
export const env = { ...base, get: base.str, getInt: base.int, getBool: base.bool, getList: base.list, getUrl: base.url, getJson: base.json }

export const nodeEnv = (): string => process.env.NODE_ENV ?? ''
export const isProduction = (): boolean => process.env.NODE_ENV === 'production'
export const underTest = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.VITEST
// tvine start defaults NODE_ENV to production; `NODE_ENV=` (empty) counts as unset
export const defaultNodeEnv = (v: string): void => { process.env.NODE_ENV ||= v }
// for the CLI only: `tvine dev` turns debug on unless TVINE_DEBUG says otherwise
export const defaultEnv = (name: string, v: string): void => { process.env[name] ??= v }

// Names a .env file supplied (not the real environment): production refuses TVINE_DEBUG from one
export const fromDotenv = new Set<string>()

// .env files: loaded when present, never overriding a variable already set by the real
// environment. First found wins per variable: .env.<NODE_ENV>.local, .env.local, .env.<NODE_ENV>, .env.
// (.env.local is skipped under NODE_ENV=test, like Next.) Production: never, unless TVINE_LOAD_DOTENV=1 (a real
// env var: settings.ts is read after the files, so it cannot switch them on). Returns the files loaded.
// TVINE_ENV_FILES=.env,.env.shared (a real env var) names extra files read after those, like loadEnv (later file wins).
export function loadDotenv(dir = process.cwd()): string[] {
  const ne = process.env.NODE_ENV
  if (dotenvOff()) return []
  const extra = process.env.TVINE_ENV_FILES?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  const before = new Set(Object.keys(process.env))
  const names = [ne && `.env.${ne}.local`, ne !== 'test' && '.env.local', ne && `.env.${ne}`, '.env'].filter((f): f is string => !!f)
  const out: string[] = []
  for (const f of names) {
    const p = resolve(dir, f)
    if (existsSync(p)) { process.loadEnvFile(p); out.push(f) }
  }
  for (const k of Object.keys(process.env)) if (!before.has(k)) fromDotenv.add(k)
  return [...out, ...applyFiles(extra, dir, false)]
}

const dotenvOff = () => process.env.NODE_ENV === 'production' && !/^(1|true|yes|on)$/i.test(process.env.TVINE_LOAD_DOTENV ?? '')

// Load .env files in order: a later file beats an earlier one and beats the automatic loadDotenv files; a variable
// set by the real environment is never overridden. Missing files are skipped (required: an error naming the file).
// Production: off unless TVINE_LOAD_DOTENV=1, like loadDotenv. Returns the files loaded.
export function loadEnv(files: string[], o: { dir?: string; required?: boolean } = {}): string[] {
  return dotenvOff() ? [] : applyFiles(files, o.dir ?? process.cwd(), !!o.required)
}

function applyFiles(files: string[], dir: string, required: boolean): string[] {
  const out: string[] = []
  for (const f of files) {
    const p = resolve(dir, f)
    if (!existsSync(p)) {
      if (required) throw new EnvError(`env file ${f} not found (looked in ${dir})`)
      continue
    }
    for (const [k, v] of Object.entries(parseEnv(readFileSync(p, 'utf8')))) {
      if (process.env[k] !== undefined && !fromDotenv.has(k)) continue   // the real environment wins
      process.env[k] = v
      fromDotenv.add(k)
    }
    out.push(f)
  }
  return out
}

// names only (never values) of the framework variables, and any other TVINE_* ones, that are set
export const envReport = (): { name: string; set: boolean }[] => {
  const names = new Set<string>([...FRAMEWORK_ENV, ...Object.keys(process.env).filter((k) => k.startsWith('TVINE_'))])
  return [...names].map((name) => ({ name, set: raw(name) !== undefined }))
}
