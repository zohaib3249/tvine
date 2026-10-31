// Tiny SQL AST. Values only ever appear as Param nodes; identifiers are plain names the dialect
// validates and quotes. Raw holds a fixed set of constants, nothing else.

export type BinOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/'
export const RAW = ['0', '1', '*'] as const

export type Expr =
  | { t: 'col'; name: string; table?: string }            // table: a qualifier (table name or alias)
  | { t: 'param'; value: unknown }
  | { t: 'fn'; name: string; args: Expr[] }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { t: 'not'; e: Expr }
  | { t: 'and'; es: Expr[] }
  | { t: 'or'; es: Expr[] }
  | { t: 'isNull'; e: Expr; negated?: boolean }
  | { t: 'in'; e: Expr; list: Expr[] }
  | { t: 'like'; e: Expr; pattern: Expr; ci?: boolean }   // ci: dialect lowers `e` (Unicode-aware); pattern is already lowered
  | { t: 'raw'; sql: (typeof RAW)[number] }
  | { t: 'castText'; e: Expr }                               // CAST(e AS TEXT): contains/search on any column kind
  // ---- advanced ORM (orm-advanced.md) ----
  | { t: 'func'; fn: Func; args: Expr[] }                    // dialect-mapped function (lower → tv_lower on sqlite, length → char_length …)
  | { t: 'case'; whens: [Expr, Expr][]; else?: Expr }
  | { t: 'cast'; e: Expr; to: CastTo }
  | { t: 'agg'; fn: AggFn; e?: Expr; distinct?: boolean }   // e absent = COUNT(*)
  | { t: 'trunc'; unit: TruncUnit; e: Expr }                 // UTC truncation of a datetime column, per dialect
  | { t: 'extract'; part: DatePart; e: Expr; src: 'date' | 'datetime' }   // __year / __month / __day (int) / __date ('YYYY-MM-DD'), UTC
  | { t: 'sub'; q: Select }                                  // scalar subquery
  | { t: 'exists'; q: Select }
  | { t: 'inSub'; e: Expr; q: Select }
  | { t: 'star'; table?: string }
  | { t: 'as'; e: Expr; alias: string }                      // select-list only
  | { t: 'ordinal'; n: number }                              // GROUP BY 1, 2 (params in grouped expressions stay one expression on pg)

export type Func = 'lower' | 'upper' | 'length' | 'coalesce' | 'abs'
export type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max'
export type TruncUnit = 'year' | 'month' | 'day'
export type DatePart = 'year' | 'month' | 'day' | 'date'
// a fixed portable type, or (postgres only) a column type from Field.dbType — never user text
export type CastTo = 'int' | 'float' | 'text' | { db: string }
export type Nulls = 'first' | 'last'
export type OrderTerm = { e: Expr; dir: 'asc' | 'desc'; nulls?: Nulls }   // nulls absent = nulls sort smallest (all dialects)
export type Join = { table: string; alias: string; on: Expr; inner?: boolean }
export type ForUpdate = { nowait?: boolean; skipLocked?: boolean; of?: string[] }
export type Select = {
  t: 'select'; from: string | Select; as?: string; cols?: Expr[]; joins?: Join[]; where?: Expr
  groupBy?: Expr[]; having?: Expr; order?: OrderTerm[]; limit?: number; offset?: number
  distinct?: boolean; distinctOn?: Expr[]; forUpdate?: ForUpdate
}
// rows: multi-row VALUES (bulkCreate); values: one row. ignoreConflicts: ON CONFLICT DO NOTHING (pg / sqlite)
export type Insert = { t: 'insert'; into: string; cols: string[]; values: Expr[]; rows?: Expr[][]; returning?: boolean; ignoreConflicts?: boolean }
export type Update = { t: 'update'; table: string; set: [string, Expr][]; where?: Expr }
export type Delete = { t: 'delete'; from: string; where?: Expr }
// DDL: column fragments come from Field.columnDDL (identifiers quoted, defaults as checked literals).
export type CreateTable = { t: 'createTable'; name: string; columns: string[]; ifNotExists?: boolean }
// alterColumn.action is a fragment built from field DDL (types / checked default literals), like addColumn
export type AlterTable = {
  t: 'alterTable'; name: string; addColumn?: string; dropColumn?: string; renameTo?: string; renameColumn?: { from: string; to: string }
  alterColumn?: { name: string; action: string }; addUnique?: { constraint: string; col: string }; dropConstraint?: string
}
export type DropTable = { t: 'dropTable'; name: string }
export type CreateIndex = { t: 'createIndex'; name: string; table: string; cols: string[]; unique?: boolean; where?: Expr }   // where: partial index (inline literals)
export type DropIndex = { t: 'dropIndex'; name: string; table?: string }   // table: mysql's DROP INDEX … ON
// INSERT INTO into (cols, fill cols) SELECT cols, fill values FROM from — the copy step of a table
// rebuild; `fill` backfills new columns (e.g. auto datetime = migration time) as params
export type CopyRows = { t: 'copyRows'; from: string; into: string; cols: string[]; fill?: [string, Expr][] }

export type SqlNode = Expr | Select | Insert | Update | Delete | CreateTable | AlterTable | DropTable | CreateIndex | DropIndex | CopyRows

// ---- builders --------------------------------------------------------------------------------
export const col = (name: string): Expr => ({ t: 'col', name })
export const qcol = (name: string, table?: string): Expr => (table ? { t: 'col', name, table } : { t: 'col', name })
export const param = (value: unknown): Expr => ({ t: 'param', value })
export const fn = (name: string, ...args: Expr[]): Expr => ({ t: 'fn', name, args })
export const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ t: 'bin', op, l, r })
export const not = (e: Expr): Expr => ({ t: 'not', e })
export const and = (...es: Expr[]): Expr => (es.length === 1 ? es[0] : { t: 'and', es })
export const or = (...es: Expr[]): Expr => (es.length === 1 ? es[0] : { t: 'or', es })
export const isNull = (e: Expr): Expr => ({ t: 'isNull', e })
export const isNotNull = (e: Expr): Expr => ({ t: 'isNull', e, negated: true })
export const inList = (e: Expr, list: Expr[]): Expr => ({ t: 'in', e, list })
export const like = (e: Expr, pattern: Expr, ci = false): Expr => ({ t: 'like', e, pattern, ci })
export const castText = (e: Expr): Expr => ({ t: 'castText', e })
export const raw = (sql: (typeof RAW)[number]): Expr => ({ t: 'raw', sql })
export const FALSE = raw('0')
export const func = (f: Func, ...args: Expr[]): Expr => ({ t: 'func', fn: f, args })
export const agg = (f: AggFn, e?: Expr, distinct?: boolean): Expr => ({ t: 'agg', fn: f, ...(e ? { e } : {}), ...(distinct ? { distinct } : {}) })
export const as = (e: Expr, alias: string): Expr => ({ t: 'as', e, alias })
