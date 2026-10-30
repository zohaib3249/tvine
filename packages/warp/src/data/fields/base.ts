// A Field knows how it behaves in every database: its column(s), per-dialect SQL type, how its
// values travel to the driver (params only, never SQL text), how they come back, and how it is
// filtered. Tables only collect fields. (Django's db_type / get_db_prep_value / from_db_value.)
import type { z } from 'zod'
import { and, bin, fn, FALSE, inList, isNotNull, isNull, like, or, param, type Expr } from '../sql/ast.js'
import type { Dialect } from '../sql/dialect.js'
import type { Op } from '../queryset.js'

export type Kind = 'id' | 'uuid' | 'text' | 'int' | 'float' | 'bool' | 'money' | 'enum' | 'datetime' | 'json' | 'image' | 'fk'
export type DbName = Dialect['name']

export interface Opts {
  optional?: boolean
  default?: unknown
  unique?: boolean
  searchable?: boolean
  index?: boolean
  hidden?: boolean                      // left out of generic views' default serializer output
  readOnly?: boolean                    // generic views: never accepted as create/update input
  writeOnly?: boolean                   // generic views: accepted as input, never output (overrides hidden's write-protect)
  auto?: boolean                        // datetime only: default now
}

export interface Money { value: number; currency: string }
export interface ModelDef { name: string; fields: Fields }
export type Fields = Record<string, Field<any, boolean, Kind, boolean>>

// V = row value type, O = optional (nullable), K = kind, D = has a default. V/O/D are type-only.
export abstract class Field<V = unknown, O extends boolean = boolean, K extends Kind = Kind, D extends boolean = boolean> {
  abstract readonly kind: K
  declare readonly _v?: V
  declare readonly _o?: O
  declare readonly _d?: D
  readonly values?: readonly string[]                       // enum
  readonly target?: () => ModelDef                          // fk
  constructor(readonly opts: Opts = {}) {}

  key(name: string): string { return name }                 // property name on the row object
  columns(name: string): string[] { return [name] }
  abstract dbType(d: Dialect): string[]
  abstract zod(): z.ZodTypeAny                             // non-null schema; nullability added by schema()

  schema(): z.ZodTypeAny { return this.opts.optional ? this.zod().nullable() : this.zod() }
  validate(value: unknown): V { return this.schema().parse(value) as V }

  // type + NOT NULL / UNIQUE / DEFAULT / REFERENCES, one fragment per column
  columnDDL(name: string, d: Dialect): string[] {
    const types = this.dbType(d)
    const defaults = this.opts.default === undefined ? [] : this.toDb(this.opts.default, d)
    return this.columns(name).map((c, i) =>
      `${d.quoteIdent(c)} ${types[i]}${this.opts.optional ? '' : ' NOT NULL'}${this.opts.unique && i === 0 ? ' UNIQUE' : ''}` +
      `${defaults[i] !== undefined ? ` DEFAULT ${ddlLiteral(defaults[i])}` : ''}${i === 0 ? this.references(d) : ''}`)
  }
  references(_d: Dialect): string { return '' }

  toDb(value: unknown, _d: Dialect): unknown[] { return [value ?? null] }
  fromDb(row: Record<string, unknown>, name: string, _d: Dialect): V | null { return (row[name] ?? null) as V | null }

  // Positive form of a filter on this field. exclude() negation is applied by the caller.
  lookup(op: Op, col: Expr, value: unknown, d: Dialect): Expr {
    const p = (v: unknown) => param(this.toDb(v, d)[0])
    switch (op) {
      case 'eq': return value == null ? isNull(col) : bin('=', col, p(value))
      case 'ne': return value == null ? isNotNull(col) : or(isNull(col), bin('<>', col, p(value)))
      case 'gt': return bin('>', col, p(value))
      case 'gte': return bin('>=', col, p(value))
      case 'lt': return bin('<', col, p(value))
      case 'lte': return bin('<=', col, p(value))
      case 'in': return Array.isArray(value) && value.length ? inList(col, value.map(p)) : FALSE
      case 'contains': return and(isNotNull(col), containsExpr(col, String(value)))
    }
  }
}

// case-insensitive substring match; the term is a param with LIKE wildcards escaped
export const containsExpr = (col: Expr, term: string): Expr =>
  like(fn('coalesce', col, param('')), param('%' + term.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'), true)

// DDL cannot take params; defaults are developer constants from models.ts, rendered as checked literals.
export function ddlLiteral(v: unknown): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  throw new Error(`unsupported column default ${String(v)}`)
}

// postgres/mysql entries in every field: untested until Task 20 (docker conformance)
export const byDb = (d: Dialect, t: Record<DbName, string>) => t[d.name]

export const keyOf = (name: string, f: Field<any, boolean, Kind, boolean>) => f.key(name)

export function pkField(def: ModelDef): [string, Field<any, boolean, Kind, boolean>] {
  const e = Object.entries(def.fields).find(([n, f]) => n === 'id' && (f.kind === 'id' || f.kind === 'uuid'))
  if (!e) throw new Error(`model "${def.name}" needs an id field: id: field.id()`)
  return e
}
