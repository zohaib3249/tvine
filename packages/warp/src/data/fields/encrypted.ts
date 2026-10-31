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
// Every value is bound (AES-GCM AAD) to '<model>.<field>' (or `bindAs`, to keep reading after a rename), so a ciphertext
// copied to another column does not decrypt. bindRow: true also binds the row's pk (a copy to another row fails); it
// needs a uuid pk (known before insert) and writes that name the row (create, Model.update, bulkUpdate, filter({pk}).update).
// ponytail: no unique / index / searchable / default (ciphertext is random); a unique blind index is v1.1.
export interface EncryptedOpts extends Opts { of?: 'text' | 'json'; deterministic?: boolean; context?: string; bindAs?: string; bindRow?: boolean }
export interface RowCtx { pk?: unknown }
export class EncryptedField extends Field<unknown, boolean, 'encrypted', boolean> {
  readonly kind = 'encrypted' as const
  declare readonly opts: EncryptedOpts
  constructor(opts: EncryptedOpts = {}) {
    for (const k of ['unique', 'index', 'searchable', 'default'] as const) if (opts[k] !== undefined && opts[k] !== false) throw new Error(`an encrypted field cannot have ${k}`)
    super({ of: 'text', ...opts, hidden: opts.hidden ?? true })
  }
  private site?: string   // '<model>.<field>', set by defineModel (bind)
  private pkCol = 'id'
  bind(model: string, name: string, pk: { name: string; kind: string }): void {
    if (this.opts.bindRow && pk.kind !== 'uuid') throw new Error(`${model}.${name}: bindRow needs a uuid pk (the pk must be known before insert)`)
    this.site = this.opts.bindAs ?? `${model}.${name}`
    this.pkCol = pk.name
  }
  private binding(pk: unknown): string {
    if (!this.site) throw new Error('an encrypted field is used outside defineModel (no model.field binding)')
    if (!this.opts.bindRow) return this.site
    if (pk == null) throw new DomainError('invalid_param', `${this.site}: bindRow — write this field on one row by its pk (create, Model.update, filter({ pk }).update)`)
    return `${this.site}|${String(pk)}`
  }
  private get det() { return !!this.opts.deterministic }
  private plain(v: unknown) { return this.opts.of === 'json' ? JSON.stringify(v) : String(v) }
  columns(name: string) { return this.det ? [name, `${name}Hash`] : [name] }
  dbType(d: Dialect) {
    const t = byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'LONGTEXT' })
    return this.det ? [t, byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(64)' })] : [t]
  }
  zod() { return this.opts.of === 'json' ? z.unknown() : z.string() }
  toDb(v: unknown, _d?: Dialect, row?: RowCtx): unknown[] {
    if (v == null) return this.det ? [null, null] : [null]
    const p = this.plain(v)
    const ct = encrypt(p, this.opts.context, this.binding(row?.pk))
    return this.det ? [ct, blindIndex(p, this.opts.context, this.site)] : [ct]
  }
  fromDb(row: Record<string, unknown>, name: string) {
    const v = row[name]
    if (v == null) return null
    const p = decrypt(String(v), this.opts.context, this.binding(row[this.pkCol]))
    return this.opts.of === 'json' ? JSON.parse(p) : p
  }
  lookup(op: Op, col: Expr, value: unknown, d: Dialect): Expr {
    if (value == null && (op === 'eq' || op === 'ne')) return op === 'eq' ? isNull(col) : isNotNull(col)
    if (!this.det || !['eq', 'ne', 'in'].includes(op) || col.t !== 'col') {
      throw new DomainError('invalid_param', 'an encrypted field can only be filtered by exact match, and only with deterministic: true')
    }
    const h: Expr = { ...col, name: `${col.name}Hash` }
    const hashes = (vs: unknown[]) => vs.filter((x) => x != null).flatMap((x) => blindIndexes(this.plain(x), this.opts.context, this.site)).map((x) => param(x))
    if (op === 'in') { const hs = Array.isArray(value) ? hashes(value) : []; return hs.length ? inList(h, hs) : FALSE }
    const eq = inList(h, hashes([value]))
    return op === 'eq' ? eq : or(isNull(col), not(eq))
  }
}
