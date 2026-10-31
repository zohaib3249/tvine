// log — Django LOGGING without a dependency (docs/design/conventions/logging.md).
// getLogger('tvine.request').info('msg', { fields }) → every handler whose level lets it through. Named loggers
// are dotted (Python logging): the most specific `loggers` entry wins ('tvine.db' covers 'tvine.db.slow').
// Every record is redacted (passwords, tokens, cookies, authorization, secrets, + logging.redact) before any handler.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactSecrets } from './core/redact.js'

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'pretty'
export interface LogRecord { t: string; level: Level; logger: string; msg: string; [k: string]: unknown }
export type LogHandler =
  | { type: 'console'; level?: Level; format?: LogFormat; stream?: 'stdout' | 'stderr' }   // default: console[level]
  // rotating file: past maxBytes (or at the first write of a new day with `daily`) the file moves to .1, .2 … keep
  | { type: 'file'; path: string; level?: Level; format?: LogFormat; maxBytes?: number; daily?: boolean; keep?: number }
  | { type: 'custom'; level?: Level; write: (r: LogRecord) => void }
export interface LoggingConfig {
  level: Level
  format: LogFormat
  handlers: LogHandler[]
  loggers: Record<string, Level | 'off'>
  redact: string[]
}
export type LoggingSetting = 'json' | 'pretty' | 'none' | Partial<LoggingConfig>

export interface Logger {
  readonly name: string
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  enabled(level: Level): boolean
  child(fields: Record<string, unknown>): Logger   // bound fields (requestId, userId, sidHash) on every record
}

const RANK: Record<Level | 'off', number> = { debug: 10, info: 20, warn: 30, error: 40, off: 99 }
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const

// The shorthand ('json' | 'pretty' | 'none') or the object form → the full config. 'none' = no handlers.
export function normalizeLogging(s: LoggingSetting | undefined, prod = false): LoggingConfig {
  const fmt: LogFormat = prod ? 'json' : 'pretty'
  if (s === 'none') return { level: 'info', format: fmt, handlers: [], loggers: {}, redact: [] }
  if (s === undefined || typeof s === 'string') return { level: 'info', format: s ?? fmt, handlers: [{ type: 'console' }], loggers: {}, redact: [] }
  return { level: s.level ?? 'info', format: s.format ?? fmt, handlers: s.handlers ?? [{ type: 'console' }], loggers: s.loggers ?? {}, redact: s.redact ?? [] }
}

// one config per process (on globalThis: every copy of warp logs the same way)
const KEY = Symbol.for('tvine.logging')
type State = { cfg: LoggingConfig; extra: Set<string>; files: Map<string, FileState> }
const g = globalThis as { [KEY]?: State }
const state = (): State => (g[KEY] ??= { cfg: normalizeLogging(undefined, process.env.NODE_ENV === 'production'), extra: new Set(), files: new Map() })

export function configureLogging(s: LoggingSetting | undefined, prod = process.env.NODE_ENV === 'production'): LoggingConfig {
  const cfg = normalizeLogging(s, prod)
  g[KEY] = { cfg, extra: new Set(cfg.redact.map((k) => k.toLowerCase())), files: new Map() }
  return cfg
}
export const loggingConfig = (): LoggingConfig => state().cfg

function levelOf(name: string, cfg: LoggingConfig): number {
  let best = -1, lvl: Level | 'off' = cfg.level
  for (const [k, v] of Object.entries(cfg.loggers)) {
    if ((name === k || name.startsWith(`${k}.`)) && k.length > best) { best = k.length; lvl = v }
  }
  return RANK[lvl]
}

const pretty = (r: LogRecord) => {
  const { t, level, logger, msg, ...rest } = r
  const kv = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
  return `${t.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${logger} ${msg}${kv ? ` ${kv}` : ''}`
}
const render = (r: LogRecord, f: LogFormat) => (f === 'json' ? JSON.stringify(r) : pretty(r))

type FileState = { size: number; day: string }
// ponytail: synchronous appends (ordered, never lost on crash); a busy server should log to stdout and let the platform ship it
function writeFile(h: Extract<LogHandler, { type: 'file' }>, line: string, files: Map<string, FileState>): void {
  let st = files.get(h.path)
  const day = new Date().toISOString().slice(0, 10)
  if (!st) {
    mkdirSync(dirname(h.path), { recursive: true })
    let size = 0, d = day
    try { const s = statSync(h.path); size = s.size; d = s.mtime.toISOString().slice(0, 10) } catch { /* new file */ }
    st = { size, day: d }
    files.set(h.path, st)
  }
  const bytes = Buffer.byteLength(line) + 1
  if (st.size > 0 && ((h.maxBytes && st.size + bytes > h.maxBytes) || (h.daily && st.day !== day))) {
    const keep = h.keep ?? 5
    rmSync(`${h.path}.${keep}`, { force: true })
    for (let i = keep - 1; i >= 1; i--) { try { renameSync(`${h.path}.${i}`, `${h.path}.${i + 1}`) } catch { /* gap */ } }
    if (keep > 0) renameSync(h.path, `${h.path}.1`); else rmSync(h.path, { force: true })
    st.size = 0
  }
  appendFileSync(h.path, `${line}\n`)
  st.size += bytes
  st.day = day
}

function emit(name: string, level: Level, msg: string, fields: Record<string, unknown>): void {
  const s = state(), cfg = s.cfg
  if (!cfg.handlers.length || RANK[level] < levelOf(name, cfg)) return
  const r = { t: new Date().toISOString(), level, logger: name, msg, ...(redactSecrets(fields, 0, s.extra) as object) } as LogRecord
  for (const h of cfg.handlers) {
    if (h.level && RANK[level] < RANK[h.level]) continue
    try {
      if (h.type === 'custom') h.write(r)
      else if (h.type === 'file') writeFile(h, render(r, h.format ?? cfg.format), s.files)
      else if (h.stream === 'stdout') console.log(render(r, h.format ?? cfg.format))
      else if (h.stream === 'stderr') console.error(render(r, h.format ?? cfg.format))
      else console[level](render(r, h.format ?? cfg.format))   // default: console.debug/info/warn/error
    } catch { /* a broken handler never breaks the caller */ }
  }
}

export function getLogger(name: string, bound: Record<string, unknown> = {}): Logger {
  const at = (level: Level) => (msg: string, fields?: Record<string, unknown>) => emit(name, level, msg, { ...bound, ...fields })
  return {
    name,
    debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    enabled: (level) => state().cfg.handlers.length > 0 && RANK[level] >= levelOf(name, state().cfg),
    child: (fields) => getLogger(name, { ...bound, ...fields }),
  }
}
