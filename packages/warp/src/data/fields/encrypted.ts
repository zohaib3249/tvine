import { z } from 'zod'
import { FALSE, not, inList, isNotNull, isNull, or, param, type Expr } from '../sql/ast.js'
import { byDb, Field, type Opts } from './base.js'
import { DomainError } from '../../core/errors.js'
import { blindIndex, blindIndexes, decrypt, encrypt } from '../../security/encryption.js'
import type { Dialect } from '../sql/dialect.js'
import type { Op } from '../queryset.js'

// Encrypted at rest (security/encryption.ts). `of`: 'text' (a string) or 'json' (any JSON value).
// Not filterable, except eq / ne / in with `deterministic: true`, which adds a `<name>Hash` column (an HMAC
// of the value). Hidden by default (admin forms, generic views, agent output): `hidden: false` shows it.
// ponytail: no unique / index / searchable / default (ciphertext is random); a unique blind index is v1.1.
export interface EncryptedOpts extends Opts { of?: 'text' | 'json'; deterministic?: boolean; context?: string }
export class EncryptedField extends Field<unknown, boolean, 'encrypted', boolean> {
  readonly kind = 'encrypted' as const
  declare readonly opts: EncryptedOpts
  constructor(opts: EncryptedOpts = {}) {
    for (const k of ['unique', 'index', 'searchable', 'default'] as const) if (opts[k] !== undefined && opts[k] !== false) throw new Error(`an encrypted field cannot have ${k}`)
    super({ of: 'text', ...opts, hidden: opts.hidden ?? true })
  }
  private get det() { return !!this.opts.deterministic }
  private plain(v: unknown) { return this.opts.of === 'json' ? JSON.stringify(v) : String(v) }
  columns(name: string) { return this.det ? [name, `${name}Hash`] : [name] }
  dbType(d: Dialect) {
    const t = byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'LONGTEXT' })
    return this.det ? [t, byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(64)' })] : [t]
  }
  zod() { return this.opts.of === 'json' ? z.unknown() : z.string() }
  toDb(v: unknown): unknown[] {
    if (v == null) return this.det ? [null, null] : [null]
    const p = this.plain(v)
    const ct = encrypt(p, this.opts.context)
    return this.det ? [ct, blindIndex(p, this.opts.context)] : [ct]
  }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    if (v == null) return null
    const p = decrypt(String(v), this.opts.context)
    return this.opts.of === 'json' ? JSON.parse(p) : p
  }
  lookup(op: Op, col: Expr, value: unknown, d: Dialect): Expr {
    if (value == null && (op === 'eq' || op === 'ne')) return op === 'eq' ? isNull(col) : isNotNull(col)
    if (!this.det || !['eq', 'ne', 'in'].includes(op) || col.t !== 'col') {
      throw new DomainError('invalid_param', 'an encrypted field can only be filtered by exact match, and only with deterministic: true')
    }
    const h: Expr = { ...col, name: `${col.name}Hash` }
    const hashes = (vs: unknown[]) => vs.filter((x) => x != null).flatMap((x) => blindIndexes(this.plain(x), this.opts.context)).map((x) => param(x))
    if (op === 'in') { const hs = Array.isArray(value) ? hashes(value) : []; return hs.length ? inList(h, hs) : FALSE }
    const eq = inList(h, hashes([value]))
    return op === 'eq' ? eq : or(isNull(col), not(eq))
  }
}
