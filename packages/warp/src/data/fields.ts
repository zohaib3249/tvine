// Field kinds for defineModel. One definition drives the column layout, the zod schema and the TS type.
// Storage choices: datetime = integer ms (surfaces as Date); money = int cents + currency columns
// (surfaces as {value,currency}); image = text key; fk = `<name>Id` int/text column.
import { z } from 'zod'

export type Kind = 'id' | 'uuid' | 'text' | 'int' | 'float' | 'bool' | 'money' | 'enum' | 'datetime' | 'json' | 'image' | 'fk'

export interface Opts {
  optional?: boolean
  default?: unknown
  unique?: boolean
  searchable?: boolean
  index?: boolean
  auto?: boolean                        // datetime only: default now
}

export interface Money { value: number; currency: string }

// V = row value type, O = optional (nullable), K = kind (fk renames the key to `<name>Id`).
export interface Field<V = unknown, O extends boolean = boolean, K extends Kind = Kind, D extends boolean = boolean> {
  readonly kind: K
  readonly opts: Opts
  readonly values?: readonly string[]            // enum
  readonly target?: () => { name: string; fields: Fields }     // fk
  readonly _v?: V
  readonly _o?: O
  readonly _d?: D
}
export type Fields = Record<string, Field<any, boolean, Kind, boolean>>
export interface ModelDef { name: string; fields: Fields }

type OptOf<P extends Opts | undefined> = P extends { optional: true } ? true : false
type DefOf<P extends Opts | undefined> = P extends { default: unknown } | { auto: true } ? true : false
const mk = <V, K extends Kind>(kind: K) =>
  <const P extends Opts | undefined = undefined>(opts?: P): Field<V, OptOf<P>, K, DefOf<P>> => ({ kind, opts: opts ?? {} })

export const field = {
  id: () => ({ kind: 'id', opts: {} }) as Field<number, false, 'id', true>,
  uuid: mk<string, 'uuid'>('uuid'),
  text: mk<string, 'text'>('text'),
  int: mk<number, 'int'>('int'),
  float: mk<number, 'float'>('float'),
  bool: mk<boolean, 'bool'>('bool'),
  money: mk<Money, 'money'>('money'),
  datetime: mk<Date, 'datetime'>('datetime'),
  json: mk<unknown, 'json'>('json'),
  image: mk<string, 'image'>('image'),
  enum: <const E extends readonly string[], const P extends Opts | undefined = undefined>(values: E, opts?: P) =>
    ({ kind: 'enum', opts: opts ?? {}, values }) as Field<E[number], OptOf<P>, 'enum', DefOf<P>>,
  fk: <M extends { name: string; fields: Fields }, const P extends Opts | undefined = undefined>(target: () => M, opts?: P) =>
    ({ kind: 'fk', opts: opts ?? {}, target }) as Field<number | string, OptOf<P>, 'fk', DefOf<P>>,
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

// ---- derived helpers (shared by engine, model, migrate) --------------------------------------
export const keyOf = (name: string, f: Field<any, boolean, Kind, boolean>) => (f.kind === 'fk' ? `${name}Id` : name)

export function pkField(def: ModelDef): [string, Field<any, boolean, Kind, boolean>] {
  const e = Object.entries(def.fields).find(([n, f]) => n === 'id' && (f.kind === 'id' || f.kind === 'uuid'))
  if (!e) throw new Error(`model "${def.name}" needs an id field: id: field.id()`)
  return e
}

export function fieldZod(f: Field<any, boolean, Kind, boolean>): z.ZodTypeAny {
  let t: z.ZodTypeAny
  switch (f.kind) {
    case 'id': t = z.number().int(); break
    case 'uuid': case 'text': case 'image': t = z.string(); break
    case 'int': t = z.number().int(); break
    case 'float': t = z.number(); break
    case 'bool': t = z.boolean(); break
    case 'money': t = z.object({ value: z.number().int(), currency: z.string().min(1) }); break
    case 'enum': t = z.enum(f.values as [string, ...string[]]); break
    case 'datetime': t = z.date(); break
    case 'json': t = z.unknown(); break
    case 'fk': t = z.union([z.number(), z.string()]); break
  }
  return f.opts.optional ? t.nullable() : t
}

// Row schema (what reads return). Keys use the stored property name (`vendorId` for fk).
export function rowSchema(def: ModelDef): z.ZodObject<z.ZodRawShape> {
  return z.object(Object.fromEntries(Object.entries(def.fields).map(([n, f]) => [keyOf(n, f), fieldZod(f)])))
}

// Fields a caller may leave out on create.
export const hasDefault = (f: Field<any, boolean, Kind, boolean>) =>
  f.kind === 'id' || f.kind === 'uuid' || f.opts.optional || f.opts.default !== undefined || f.opts.auto

// SQL-level expression values for QuerySet.update: `col = col - n` / `col = col + n`.
export class Expr { constructor(readonly op: 'inc' | 'dec', readonly n: number) {} }
export const inc = (n: number) => new Expr('inc', n)
export const dec = (n: number) => new Expr('dec', n)
