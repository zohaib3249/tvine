// Tiny SQL AST. Values only ever appear as Param nodes; identifiers are plain names the dialect
// validates and quotes. Raw holds a fixed set of constants, nothing else.

export type BinOp = '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-'
export const RAW = ['0', '1', '*'] as const

export type Expr =
  | { t: 'col'; name: string }
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

export type Select = { t: 'select'; from: string; cols?: Expr[]; where?: Expr; order?: { e: Expr; dir: 'asc' | 'desc' }[]; limit?: number }
export type Insert = { t: 'insert'; into: string; cols: string[]; values: Expr[]; returning?: boolean }
export type Update = { t: 'update'; table: string; set: [string, Expr][]; where?: Expr }
export type Delete = { t: 'delete'; from: string; where?: Expr }
// DDL: column fragments come from Field.columnDDL (identifiers quoted, defaults as checked literals).
export type CreateTable = { t: 'createTable'; name: string; columns: string[]; ifNotExists?: boolean }
export type AlterTable = {
  t: 'alterTable'; name: string; addColumn?: string; dropColumn?: string; renameTo?: string; renameColumn?: { from: string; to: string }
}
export type DropTable = { t: 'dropTable'; name: string }
export type CreateIndex = { t: 'createIndex'; name: string; table: string; cols: string[]; unique?: boolean }
export type DropIndex = { t: 'dropIndex'; name: string }
// INSERT INTO into (cols, fill cols) SELECT cols, fill values FROM from — the copy step of a table
// rebuild; `fill` backfills new columns (e.g. auto datetime = migration time) as params
export type CopyRows = { t: 'copyRows'; from: string; into: string; cols: string[]; fill?: [string, Expr][] }

export type SqlNode = Expr | Select | Insert | Update | Delete | CreateTable | AlterTable | DropTable | CreateIndex | DropIndex | CopyRows

// ---- builders --------------------------------------------------------------------------------
export const col = (name: string): Expr => ({ t: 'col', name })
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
export const raw = (sql: (typeof RAW)[number]): Expr => ({ t: 'raw', sql })
export const FALSE = raw('0')
