// Input-shaped fields (forms.md "inputs pack"): each is plain text / number / JSON in the database with its own
// validation, so the admin can pick the matching widget from the kind. Text-like ones are VARCHAR where the
// engine enforces lengths (sqlite: TEXT, the schema checks the length).
import { z } from 'zod'
import { fn, param, type Expr } from '../sql/ast.js'
import { byDb, Field, type Kind } from './base.js'
import type { Dialect } from '../sql/dialect.js'
import { E164, isCountry, isIp } from '../../shape/countries.js'
import { sanitizeHtml } from '../../shape/rich.js'

const varchar = (d: Dialect, n: number) => byDb(d, { sqlite: 'TEXT', postgres: `VARCHAR(${n})`, mysql: `VARCHAR(${n})` })
const longText = (d: Dialect) => byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'LONGTEXT' })
const max = (o: { maxLength?: number }, s: z.ZodString) => (o.maxLength ? s.max(o.maxLength) : s)

export class ColorField extends Field<string, boolean, 'color', boolean> {
  readonly kind = 'color' as const
  dbType(d: Dialect) { return [varchar(d, 7)] }
  zod() { return z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Enter a hex color like #1a2b3c.').transform((s) => s.toLowerCase()) }
}

export class PhoneField extends Field<string, boolean, 'phone', boolean> {
  readonly kind = 'phone' as const
  dbType(d: Dialect) { return [varchar(d, 16)] }
  zod() { return z.string().regex(E164, 'Enter a valid phone number in international format (+15551234567).') }
}

export class IpField extends Field<string, boolean, 'ip', boolean> {   // Django GenericIPAddressField
  readonly kind = 'ip' as const
  dbType(d: Dialect) { return [varchar(d, 45)] }
  zod() { return z.string().refine((s) => isIp(s), 'Enter a valid IPv4 or IPv6 address.').transform((s) => s.toLowerCase()) }
}

export class CountryField extends Field<string, boolean, 'country', boolean> {   // ISO 3166-1 alpha-2
  readonly kind = 'country' as const
  dbType(d: Dialect) { return [varchar(d, 2)] }
  zod() { return z.string().refine(isCountry, 'Select a valid country.') }
}

export class MarkdownField extends Field<string, boolean, 'markdown', boolean> {
  readonly kind = 'markdown' as const
  dbType(d: Dialect) { return [longText(d)] }
  zod() { return max(this.opts, z.string()) }
}

export class CodeField extends Field<string, boolean, 'code', boolean> {   // opts.language: json | js | sql | html | css
  readonly kind = 'code' as const
  dbType(d: Dialect) { return [longText(d)] }
  zod() {
    const s = max(this.opts, z.string())
    return this.opts.language === 'json' ? s.refine((v) => { if (!v.trim()) return true; try { JSON.parse(v); return true } catch { return false } }, 'Enter a valid JSON.') : s
  }
}

// Sanitized on EVERY save path (not only the admin): the stored HTML is always the allowlist output.
export class RichTextField extends Field<string, boolean, 'richText', boolean> {
  readonly kind = 'richText' as const
  dbType(d: Dialect) { return [longText(d)] }
  zod() { return z.string().transform((s) => sanitizeHtml(s)).pipe(max(this.opts, z.string())) }
}

export class PercentField extends Field<number, boolean, 'percent', boolean> {   // 12.5 = 12.5 %
  readonly kind = 'percent' as const
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'REAL', postgres: 'DOUBLE PRECISION', mysql: 'DOUBLE' })] }
  zod() { return z.number().min(0, 'Ensure this value is greater than or equal to 0.').max(100, 'Ensure this value is less than or equal to 100.') }
}

// JSON-stored values (same column/param handling as JsonField).
abstract class JsonStored<V, K extends Kind> extends Field<V, boolean, K, boolean> {
  dbType(d: Dialect) { return [byDb(d, { sqlite: 'TEXT', postgres: 'JSONB', mysql: 'JSON' })] }
  toDb(v: unknown) { return [v == null ? null : JSON.stringify(v)] }
  fromDb(row: Record<string, unknown>, name: string, d: Dialect) {
    const v = row[name]
    return (v == null ? null : typeof v === 'string' && d.name !== 'postgres' ? JSON.parse(v) : v) as V | null
  }
  protected toParam(v: unknown, d: Dialect): Expr {
    return d.name === 'mysql' ? fn('JSON_EXTRACT', param(this.toDb(v)[0]), param('$')) : super.toParam(v, d)
  }
}

// opts.maxItems caps the count; opts.choices restricts the values (else free text). Trimmed, deduped.
export class TagsField extends JsonStored<string[], 'tags'> {
  readonly kind = 'tags' as const
  zod() {
    const { maxItems, choices } = this.opts
    const base = z.string().trim().min(1).max(this.opts.maxLength ?? 50)
    const tag: z.ZodTypeAny = choices?.length ? base.refine((t) => choices.includes(t), (t) => ({ message: `Select a valid choice. ${t} is not one of the available choices.` })) : base
    const list = z.array(tag).transform((a: string[]) => [...new Set(a)])
    return maxItems ? list.refine((a) => a.length <= maxItems, `Ensure this list has at most ${maxItems} items.`) : list
  }
}

const part = z.string().trim().max(200)
export interface Address { line1: string; line2?: string; city: string; region?: string; postal?: string; country: string }
export class AddressField extends JsonStored<Address, 'address'> {
  readonly kind = 'address' as const
  zod() {
    return z.object({
      line1: part.min(1, 'Enter the street address.'), line2: part.optional(), city: part.min(1, 'Enter the city.'),
      region: part.optional(), postal: z.string().trim().max(20).optional(), country: z.string().refine(isCountry, 'Select a valid country.'),
    }).strict()
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = z.string().regex(DAY, 'Enter a valid date.').refine((s) => !isNaN(+new Date(`${s}T00:00:00Z`)), 'Enter a valid date.')
export interface DateRange { start: string; end: string }
export class DateRangeField extends JsonStored<DateRange, 'dateRange'> {   // Django DateRangeField (inclusive)
  readonly kind = 'dateRange' as const
  zod() { return z.object({ start: day, end: day }).strict().refine((r) => r.start <= r.end, 'The end date must be on or after the start date.') }
}
