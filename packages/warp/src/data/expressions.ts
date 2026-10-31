// Query expressions (Django's F / Q / Value / Case / Func / Aggregate / Subquery). Pure data: they
// hold names and values, never SQL. sql/compile.ts resolves every name against the model and turns
// every value into a Param. Spec: docs/design/conventions/orm-advanced.md §1–2.
import type { ModelDef } from './fields/index.js'
import type { QuerySpec } from './queryset.js'
import type { AggFn, Func as FuncName, Nulls, TruncUnit } from './sql/ast.js'

// A queryset used as a subquery (QuerySet implements it)
export interface QueryLike { __query(): { def: ModelDef; spec: QuerySpec } }

export type ExprKind = 'F' | 'value' | 'combined' | 'func' | 'case' | 'cast' | 'trunc' | 'agg' | 'outer' | 'subquery' | 'exists'
export type CastName = 'int' | 'float' | 'text'

export abstract class Expression {
  abstract readonly kind: ExprKind
  add(x: unknown): Expression { return new Combined('+', this, wrap(x)) }
  sub(x: unknown): Expression { return new Combined('-', this, wrap(x)) }
  mul(x: unknown): Expression { return new Combined('*', this, wrap(x)) }
  div(x: unknown): Expression { return new Combined('/', this, wrap(x)) }
  asc(o: { nulls?: Nulls } = {}): OrderBy { return new OrderBy(this, 'asc', o.nulls) }
  desc(o: { nulls?: Nulls } = {}): OrderBy { return new OrderBy(this, 'desc', o.nulls) }
}

export class FExpr extends Expression { readonly kind = 'F' as const; constructor(readonly name: string) { super() } }
export class ValueExpr extends Expression { readonly kind = 'value' as const; constructor(readonly value: unknown) { super() } }
export class Combined extends Expression {
  readonly kind = 'combined' as const
  constructor(readonly op: '+' | '-' | '*' | '/', readonly l: Expression, readonly r: Expression) { super() }
}
export class FuncExpr extends Expression { readonly kind = 'func' as const; constructor(readonly fn: FuncName, readonly args: Expression[]) { super() } }
export class CastExpr extends Expression { readonly kind = 'cast' as const; constructor(readonly e: Expression, readonly to: CastName) { super() } }
export class TruncExpr extends Expression { readonly kind = 'trunc' as const; constructor(readonly unit: TruncUnit, readonly e: Expression) { super() } }
export class WhenNode { constructor(readonly cond: QNode, readonly then: Expression) {} }
export class CaseExpr extends Expression {
  readonly kind = 'case' as const
  constructor(readonly whens: WhenNode[], readonly otherwise?: Expression) { super() }
}
export class Aggregate extends Expression {
  readonly kind = 'agg' as const
  constructor(readonly fn: AggFn, readonly e: Expression | undefined, readonly distinct: boolean, readonly filter?: QNode) { super() }
}
export class OuterRefExpr extends Expression { readonly kind = 'outer' as const; constructor(readonly name: string) { super() } }
export class SubqueryExpr extends Expression { readonly kind = 'subquery' as const; constructor(readonly qs: QueryLike) { super() } }
export class ExistsExpr extends Expression { readonly kind = 'exists' as const; constructor(readonly qs: QueryLike) { super() } }

export class OrderBy {
  constructor(readonly e: Expression, readonly dir: 'asc' | 'desc', readonly nulls?: Nulls) {}
}

// A QNode node: lookups ANDed / ORed, optionally negated. Children: QNode, [lookup, value], or a boolean
// expression (Exists). TS has no operator overloading: .and / .or / .not are Django's & | ~.
export type QChild = QNode | [string, unknown] | Expression
export class QNode {
  constructor(readonly conn: 'and' | 'or', readonly children: QChild[], readonly negated = false) {}
  and(...qs: (QNode | Lookups | Expression)[]): QNode { return combine('and', this, qs) }
  or(...qs: (QNode | Lookups | Expression)[]): QNode { return combine('or', this, qs) }
  not(): QNode { return new QNode(this.conn, this.children, !this.negated) }
}
export type Lookups = Record<string, unknown>

function combine(conn: 'and' | 'or', a: QNode, qs: (QNode | Lookups | Expression)[]): QNode {
  const all = [a, ...qs.map(toQ)]
  // flatten same-connector, non-negated nodes: QNode(a).and(b).and(c) = (a AND b AND c)
  return new QNode(conn, all.flatMap(q => (q.conn === conn && !q.negated ? q.children : [q])))
}

export function toQ(x: QNode | Lookups | Expression): QNode {
  if (x instanceof QNode) return x
  if (x instanceof Expression) return new QNode('and', [x])
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new TypeError('QNode() takes a lookup object, a QNode, or a boolean expression')
  return new QNode('and', Object.entries(x).map(([k, v]): [string, unknown] => [k, v]))
}

export const wrap = (x: unknown): Expression => (x instanceof Expression ? x : new ValueExpr(x))
const ref = (x: string | Expression): Expression => (typeof x === 'string' ? new FExpr(x) : x)

// ---- builders (Django names) ----------------------------------------------------------------------
export const F = (name: string) => new FExpr(name)
export function Q(x: Lookups | Expression = {}): QNode { return toQ(x) }
export const Value = (v: unknown) => new ValueExpr(v)
export const Coalesce = (...xs: (string | Expression)[]) => new FuncExpr('coalesce', xs.map(ref))
export const Lower = (x: string | Expression) => new FuncExpr('lower', [ref(x)])
export const Upper = (x: string | Expression) => new FuncExpr('upper', [ref(x)])
export const Length = (x: string | Expression) => new FuncExpr('length', [ref(x)])
export const Abs = (x: string | Expression) => new FuncExpr('abs', [ref(x)])
export const Cast = (x: string | Expression, to: CastName) => new CastExpr(ref(x), to)
export const TruncDay = (x: string | Expression) => new TruncExpr('day', ref(x))
export const TruncMonth = (x: string | Expression) => new TruncExpr('month', ref(x))
export const TruncYear = (x: string | Expression) => new TruncExpr('year', ref(x))
export const When = (cond: QNode | Lookups | Expression, then: unknown) => new WhenNode(toQ(cond), wrap(then))
export const Case = (...args: (WhenNode | { default: unknown })[]) => {
  const whens = args.filter((a): a is WhenNode => a instanceof WhenNode)
  const d = args.find((a): a is { default: unknown } => !(a instanceof WhenNode))
  if (!whens.length) throw new TypeError('Case() needs at least one WhenNode()')
  return new CaseExpr(whens, d ? wrap(d.default) : undefined)
}
type AggOpts = { distinct?: boolean; filter?: QNode | Lookups }
const mkAgg = (fn: AggFn) => (x: string | Expression, o: AggOpts = {}) =>
  new Aggregate(fn, ref(x), !!o.distinct, o.filter ? toQ(o.filter) : undefined)
export const Sum = mkAgg('sum')
export const Avg = mkAgg('avg')
export const Min = mkAgg('min')
export const Max = mkAgg('max')
export const Count = (x: string | Expression = '*', o: AggOpts = {}) =>
  new Aggregate('count', x === '*' ? undefined : ref(x), !!o.distinct, o.filter ? toQ(o.filter) : undefined)
export const OuterRef = (name: string) => new OuterRefExpr(name)
export const Subquery = (qs: QueryLike) => new SubqueryExpr(qs)
export const Exists = (qs: QueryLike) => new ExistsExpr(qs)

// Prefetch('tags', Tag.objects.filter(...)) — prefetchRelated with a custom queryset
export class Prefetch {
  constructor(readonly path: string, readonly queryset?: QueryLike & object) {}
}

// ---- Meta constraints ------------------------------------------------------------------------------
// QData: a QNode as plain data, so a CHECK lives in migration files and in the replayed state.
// Leaf values are plain JSON or { $F: name }; anything else is refused (DDL takes literals only).
export type QData = { conn: 'and' | 'or'; not?: true; items: (QData | [string, unknown])[] }

export function qToData(q: QNode): QData {
  const items = q.children.map(c => {
    if (c instanceof QNode) return qToData(c)
    if (c instanceof Expression) throw new TypeError('a CHECK constraint takes lookups only (no Exists / expressions)')
    const [k, v] = c
    if (v instanceof FExpr) return [k, { $F: v.name }] as [string, unknown]
    if (v instanceof Expression) throw new TypeError(`CHECK lookup ${k}: only plain values or F() are allowed`)
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) {
      throw new TypeError(`CHECK lookup ${k}: plain values only`)
    }
    return [k, v] as [string, unknown]
  })
  return { conn: q.conn, ...(q.negated ? { not: true as const } : {}), items }
}

export function qFromData(d: QData): QNode {
  return new QNode(d.conn, d.items.map(i => {
    if (!Array.isArray(i)) return qFromData(i)
    const [k, v] = i
    const f = v && typeof v === 'object' && '$F' in v ? F(String((v as { $F: unknown }).$F)) : v
    return [k, f] as [string, unknown]
  }), !!d.not)
}

export interface CheckSpec { kind: 'check'; name: string; check: QData }
export interface UniqueSpec { kind: 'unique'; name: string; fields: string[]; condition?: QData }
export type ConstraintSpec = CheckSpec | UniqueSpec

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const named = (n: string) => {
  if (!NAME.test(n)) throw new TypeError(`constraint name ${JSON.stringify(n)} must be an identifier of at most 63 characters`)
  return n
}
export const CheckConstraint = (o: { name: string; check: QNode | Lookups }): CheckSpec =>
  ({ kind: 'check', name: named(o.name), check: qToData(toQ(o.check)) })
export const UniqueConstraint = (o: { name: string; fields: string[]; condition?: QNode | Lookups }): UniqueSpec => {
  if (!o.fields?.length) throw new TypeError('UniqueConstraint needs fields')
  return { kind: 'unique', name: named(o.name), fields: [...o.fields], ...(o.condition ? { condition: qToData(toQ(o.condition)) } : {}) }
}
