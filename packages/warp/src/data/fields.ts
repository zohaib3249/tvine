// Field DSL for defineModel. Each `field.x()` returns a Field instance (data/fields/*) that owns
// its columns, per-DB types, value conversion and lookups; this file adds the TS-level row types.
import { z } from 'zod'
import {
  BoolField, DateField, DatetimeField, DecimalField, DurationField, EmailField, EnumField, FileField, FkField, FloatField, IdField,
  ImageField, IntField, JsonField, ColorField, PhoneField, IpField, CountryField, MarkdownField, CodeField, RichTextField, PercentField, TagsField,
  AddressField, DateRangeField, type Address, type DateRange, M2MField, MoneyField, SlugField, TextField, TimeField, UrlField, UuidField, concrete, isAuto, type Field, type Fields, type Kind, type ModelDef, type Money, type Opts,
} from './fields/index.js'

export { concrete, isAuto, keyOf, pkField, type Field, type Fields, type Kind, type ModelDef, type ModelMeta, type Money, type OnDelete, type Opts } from './fields/index.js'

type OptOf<P extends Opts | undefined> = P extends { optional: true } ? true : false
type DefOf<P extends Opts | undefined> = P extends { default: unknown } | { auto: true } | { autoNow: true } | { autoNowAdd: true } ? true : false
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
  // Django DateField / TimeField / DurationField / DecimalField / EmailField / URLField / SlugField / FileField
  date: mk<string, 'date'>(DateField),             // 'YYYY-MM-DD'
  time: mk<string, 'time'>(TimeField),             // 'HH:MM:SS[.ffffff]'
  duration: mk<number, 'duration'>(DurationField), // milliseconds
  decimal: mk<string, 'decimal'>(DecimalField),    // '12.50' (maxDigits / decimalPlaces)
  email: mk<string, 'email'>(EmailField),
  url: mk<string, 'url'>(UrlField),
  slug: mk<string, 'slug'>(SlugField),
  file: mk<string, 'file'>(FileField),             // storage key; upload with defineUpload({ uploadTo })
  // inputs pack (forms.md): each maps to its own admin widget
  color: mk<string, 'color'>(ColorField),          // '#1a2b3c' (stored lowercase)
  phone: mk<string, 'phone'>(PhoneField),          // E.164 '+15551234567'
  tags: mk<string[], 'tags'>(TagsField),           // JSON array of strings (maxItems, choices)
  ip: mk<string, 'ip'>(IpField),                   // IPv4 / IPv6 (Django GenericIPAddressField)
  country: mk<string, 'country'>(CountryField),    // ISO 3166-1 alpha-2 'IS'
  markdown: mk<string, 'markdown'>(MarkdownField),
  richText: mk<string, 'richText'>(RichTextField), // sanitized HTML (shape/rich.ts allowlist) on every save
  code: mk<string, 'code'>(CodeField),             // opts.language
  address: mk<Address, 'address'>(AddressField),   // JSON {line1, line2?, city, region?, postal?, country}
  percent: mk<number, 'percent'>(PercentField),    // 0–100
  dateRange: mk<DateRange, 'dateRange'>(DateRangeField), // JSON {start, end} 'YYYY-MM-DD', inclusive
  enum: <const E extends readonly string[], const P extends Opts | undefined = undefined>(values: E, opts?: P) =>
    new EnumField(values, opts ?? {}) as unknown as Typed<E[number], 'enum', P>,
  fk: <M extends { name: string; fields: Fields }, const P extends Opts | undefined = undefined>(target: () => M, opts?: P) =>
    new FkField(target, opts ?? {}) as unknown as Typed<number | string, 'fk', P>,
  // many-to-many: no column; `through` names a custom through model (orm-advanced.md §4)
  m2m: <M extends { name: string; fields: Fields }>(target: () => M, opts?: { through?: () => ModelDef; relatedName?: string }) =>
    new M2MField(target, opts ?? {}) as Field<never, true, 'm2m', true>,
}

// ---- types -------------------------------------------------------------------------------------
type Val<F> = F extends Field<infer V, infer O, Kind, boolean> ? (O extends true ? V | null : V) : never
type Key<F extends Fields, K extends keyof F> = F[K] extends Field<any, boolean, 'm2m', boolean> ? never
  : F[K] extends Field<any, boolean, 'fk', boolean> ? `${K & string}Id` : K
export type Row<F extends Fields> = { [K in keyof F as Key<F, K>]: Val<F[K]> }
type Defaulted<F> = F extends Field<any, infer O, infer K, infer D>
  ? (O extends true ? true : D extends true ? true : K extends 'uuid' ? true : false) : false
export type Create<F extends Fields> =
  { [K in keyof F as Defaulted<F[K]> extends true ? never : Key<F, K>]: Val<F[K]> } &
  { [K in keyof F as Defaulted<F[K]> extends true ? Key<F, K> : never]?: Val<F[K]> }
export type Infer<M> = M extends { schema: z.ZodType<infer T> } ? T : never

// Row schema (what reads return). Keys use the stored property name (`vendorId` for fk).
export function rowSchema(def: { fields: Fields }): z.ZodObject<z.ZodRawShape> {
  return z.object(Object.fromEntries(concrete(def.fields).map(([n, f]) => [f.key(n), f.schema()])))
}

// Fields a caller may leave out on create.
export const hasDefault = (f: Field<any, boolean, Kind, boolean>) =>
  f.kind === 'id' || f.kind === 'uuid' || f.opts.optional || f.opts.default !== undefined || isAuto(f.opts)

// SQL-level expression values for QuerySet.update: `col = col - n` / `col = col + n` (F('x').sub(n) is the general form).
export class Expr { constructor(readonly op: 'inc' | 'dec', readonly n: number) {} }
export const inc = (n: number) => new Expr('inc', n)
export const dec = (n: number) => new Expr('dec', n)
