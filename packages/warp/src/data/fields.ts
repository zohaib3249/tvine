// Field DSL for defineModel. Each `field.x()` returns a Field instance (data/fields/*) that owns
// its columns, per-DB types, value conversion and lookups; this file adds the TS-level row types.
import { z } from 'zod'
import {
  BoolField, DatetimeField, EnumField, FkField, FloatField, IdField, ImageField, IntField, JsonField,
  MoneyField, TextField, UuidField, type Field, type Fields, type Kind, type Money, type Opts,
} from './fields/index.js'

export { keyOf, pkField, type Field, type Fields, type Kind, type ModelDef, type Money, type Opts } from './fields/index.js'

type OptOf<P extends Opts | undefined> = P extends { optional: true } ? true : false
type DefOf<P extends Opts | undefined> = P extends { default: unknown } | { auto: true } ? true : false
type Typed<V, K extends Kind, P extends Opts | undefined> = Field<V, OptOf<P>, K, DefOf<P>>
const mk = <V, K extends Kind>(C: new (opts?: Opts) => Field<any, boolean, K, boolean>) =>
  <const P extends Opts | undefined = undefined>(opts?: P) => new C(opts ?? {}) as unknown as Typed<V, K, P>

export const field = {
  id: () => new IdField() as Field<number, false, 'id', true>,
  uuid: mk<string, 'uuid'>(UuidField),
  text: mk<string, 'text'>(TextField),
  int: mk<number, 'int'>(IntField),
  float: mk<number, 'float'>(FloatField),
  bool: mk<boolean, 'bool'>(BoolField),
  money: mk<Money, 'money'>(MoneyField),
  datetime: mk<Date, 'datetime'>(DatetimeField),
  json: mk<unknown, 'json'>(JsonField),
  image: mk<string, 'image'>(ImageField),
  enum: <const E extends readonly string[], const P extends Opts | undefined = undefined>(values: E, opts?: P) =>
    new EnumField(values, opts ?? {}) as unknown as Typed<E[number], 'enum', P>,
  fk: <M extends { name: string; fields: Fields }, const P extends Opts | undefined = undefined>(target: () => M, opts?: P) =>
    new FkField(target, opts ?? {}) as unknown as Typed<number | string, 'fk', P>,
}

// ---- types -------------------------------------------------------------------------------------
type Val<F> = F extends Field<infer V, infer O, Kind, boolean> ? (O extends true ? V | null : V) : never
type Key<F extends Fields, K extends keyof F> = F[K] extends Field<any, boolean, 'fk', boolean> ? `${K & string}Id` : K
export type Row<F extends Fields> = { [K in keyof F as Key<F, K>]: Val<F[K]> }
type Defaulted<F> = F extends Field<any, infer O, infer K, infer D>
  ? (O extends true ? true : D extends true ? true : K extends 'uuid' ? true : false) : false
export type Create<F extends Fields> =
  { [K in keyof F as Defaulted<F[K]> extends true ? never : Key<F, K>]: Val<F[K]> } &
  { [K in keyof F as Defaulted<F[K]> extends true ? Key<F, K> : never]?: Val<F[K]> }
export type Infer<M> = M extends { schema: z.ZodType<infer T> } ? T : never

// Row schema (what reads return). Keys use the stored property name (`vendorId` for fk).
export function rowSchema(def: { fields: Fields }): z.ZodObject<z.ZodRawShape> {
  return z.object(Object.fromEntries(Object.entries(def.fields).map(([n, f]) => [f.key(n), f.schema()])))
}

// Fields a caller may leave out on create.
export const hasDefault = (f: Field<any, boolean, Kind, boolean>) =>
  f.kind === 'id' || f.kind === 'uuid' || f.opts.optional || f.opts.default !== undefined || f.opts.auto

// SQL-level expression values for QuerySet.update: `col = col - n` / `col = col + n`.
export class Expr { constructor(readonly op: 'inc' | 'dec', readonly n: number) {} }
export const inc = (n: number) => new Expr('inc', n)
export const dec = (n: number) => new Expr('dec', n)
