import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// Django DecimalField(maxDigits, decimalPlaces). JS value: a string with exactly decimalPlaces decimals
// ('12.50'), so no float rounding on postgres NUMERIC / mysql DECIMAL. Input: that string or a number.
// sqlite has no exact decimal: NUMERIC affinity (Django does the same) — exact up to ~15 digits.
const NUM = /^-?\d+(\.\d+)?$/
export class DecimalField extends Field<string, boolean, 'decimal', boolean> {
  readonly kind = 'decimal' as const
  get digits() { return this.opts.maxDigits ?? 12 }
  get places() { return this.opts.decimalPlaces ?? 2 }
  dbType(d: Dialect) {
    const t = `(${this.digits}, ${this.places})`
    return [byDb(d, { sqlite: 'NUMERIC', postgres: `NUMERIC${t}`, mysql: `DECIMAL${t}` })]
  }
  // '1.5' → '1.50'; undefined when not a decimal or over maxDigits / decimalPlaces
  norm(v: unknown): string | undefined {
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : ''
    if (typeof v === 'number' && /e/i.test(s)) return Number(v.toFixed(this.places)) === v ? v.toFixed(this.places) : undefined
    if (!NUM.test(s)) return undefined
    const [int, frac = ''] = s.replace(/^-/, '').split('.')
    if (frac.replace(/0+$/, '').length > this.places) return undefined
    const i = int.replace(/^0+(?=\d)/, '')
    if ((i === '0' ? 0 : i.length) + this.places > this.digits) return undefined
    const out = this.places ? `${i}.${frac.padEnd(this.places, '0').slice(0, this.places)}` : i
    return s.startsWith('-') && /[1-9]/.test(out) ? `-${out}` : out
  }
  zod() {
    return z.union([z.string(), z.number()]).transform((v, ctx) => {
      const n = this.norm(v)
      if (n === undefined) ctx.addIssue({ code: 'custom', message: `expected a decimal with at most ${this.digits} digits and ${this.places} decimal places` })
      return n ?? ''
    })
  }
  toDb(v: unknown) { return [v == null ? null : this.norm(v) ?? v] }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    if (v == null) return null
    return this.norm(typeof v === 'number' ? v.toFixed(this.places) : v) ?? String(v)
  }
}
