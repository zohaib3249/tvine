// email / url / slug: validated text, VARCHAR(maxLength) where
// the engine enforces lengths (sqlite: TEXT, the length is checked by the schema).
import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

abstract class CharField<K extends 'email' | 'url' | 'slug'> extends Field<string, boolean, K, boolean> {
  abstract readonly maxDefault: number
  get max() { return this.opts.maxLength ?? this.maxDefault }
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: `VARCHAR(${this.max})`, mysql: `VARCHAR(${this.max})` })] }
  protected abstract check(s: z.ZodString): z.ZodTypeAny
  zod() { return this.check(z.string().max(this.max)) }
}

export class EmailField extends CharField<'email'> {
  readonly kind = 'email' as const
  readonly maxDefault = 254
  protected check(s: z.ZodString) { return s.email() }
}

// http(s) / ftp(s) schemes only: never javascript: / data: links
const SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:'])
export class UrlField extends CharField<'url'> {
  readonly kind = 'url' as const
  readonly maxDefault = 200
  protected check(s: z.ZodString) { return s.url().refine(u => { try { return SCHEMES.has(new URL(u).protocol) } catch { return false } }, 'url must be http(s) or ftp(s)') }
}

export class SlugField extends CharField<'slug'> {
  readonly kind = 'slug' as const
  readonly maxDefault = 50
  protected check(s: z.ZodString) { return s.regex(/^[-a-zA-Z0-9_]+$/, 'letters, numbers, underscores or hyphens only') }
}
