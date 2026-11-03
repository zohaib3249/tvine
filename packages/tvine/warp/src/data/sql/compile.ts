// QuerySpec + table → AST. Each plain clause is the FIELD's own lookup; this file adds the parts that
// are about the query, not the field: null-inclusive exclude(), search OR, keyset cursor, order — and
// (orm-advanced.md) the Scope compiler: names / relation paths / annotations → columns, joins and
// IN-subqueries; Q trees; expressions; aggregation with GROUP BY / HAVING; subqueries.
// Values only ever become Param nodes; every name resolves to a model field (or a validated alias).
import { DomainError } from '../../core/errors.js'
import { decodeCursor, MAX_IN, type Order, type QuerySpec, type Where } from '../queryset.js'
import {
  concrete, DateField, DatetimeField, FloatField, IntField, MoneyField, pkField, TextField, BoolField, type Field, type Fields, type Kind, type ModelDef,
} from '../fields/index.js'
import {
  and, bin, col, fn, FALSE, inList, isNotNull, isNull, like, not, or, param, qcol, raw, as, agg as aggNode, castText,
  type BinOp, type Expr, type Join, type OrderTerm, type Select,
} from './ast.js'
import { containsExpr } from '../fields/base.js'
import type { Dialect } from './dialect.js'
import { Expression, QNode, type QueryLike } from '../expressions.js'
import { pkCol, relationOf, type Relation } from '../registry.js'

type F = Field<any, boolean, Kind, boolean>
export interface TableDef { name: string; fields: Fields; meta?: ModelDef['meta'] }

const invalid = (msg: string, field?: string) => new DomainError('invalid_param', msg, field)

// field name as written by the caller (`vendor` or `vendorId`) → field + its first column
export function resolve(t: TableDef, name: string, table?: string): { f: F; field: string; col: Expr } {
  for (const [n, f] of Object.entries(t.fields)) {
    if (n === name || f.key(n) === name) {
      if (f.kind === 'm2m') throw invalid(`${t.name}.${n} is a many-to-many relation: filter through it (${n}__…) or use related()`, name)
      return { f, field: n, col: qcol(f.columns(n)[0], table) }
    }
  }
  throw invalid(`unknown field "${name}" on ${t.name}`, name)
}

// ---- compiled expressions -------------------------------------------------------------------------
// f: output field (its fromDb converts the value back); cur: the currency expression of a money output;
// agg: contains an aggregate (→ HAVING / GROUP BY); round: Avg of money (cents → whole cents)
// curGuard: the currency is only known at run time (two money operands whose currencies may differ):
// reads see NULL currency → refused at hydration; update() refuses it outright
export interface Compiled { e: Expr; f?: F; cur?: Expr; agg: boolean; round?: boolean; curGuard?: boolean }
const isMoney = (c: Compiled) => c.f?.kind === 'money'
// a money output must know its currency: a bare amount (Value(7), Coalesce(price, 0)) is refused
const needCur = (c: Compiled, what: string): Expr => {
  if (!c.cur) throw invalid(`${what}: a money value needs its currency — Value({ value, currency }) or a money field`)
  return c.cur
}
const sameExpr = (a?: Expr, b?: Expr) => JSON.stringify(a) === JSON.stringify(b)

const OUT = { int: new IntField(), float: new FloatField(), text: new TextField(), bool: new BoolField(), datetime: new DatetimeField(), date: new DateField() }
// date transforms: `createdAt__year: 2024`, `createdAt__date__gte: '2024-01-01'` (UTC)
const TRANSFORMS = new Set(['year', 'month', 'day', 'date'])
const NUMERIC = new Set<Kind>(['int', 'float', 'money', 'id'])
const LOOKUPS = new Set(['eq', 'exact', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'icontains', 'isnull',
  'startswith', 'istartswith', 'endswith', 'iendswith', 'iexact', 'range'])
type LeafOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'isnull' | 'startswith' | 'endswith' | 'iexact' | 'range'
const CMP: Partial<Record<LeafOp, BinOp>> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
const escLike = (s: string) => s.toLowerCase().replace(/[\\%_]/g, '\\$&')

type Mode = 'select' | 'write' | 'ddl'
interface ScopeOpts { alias?: string; qualify?: boolean; outer?: Scope; counter?: { n: number }; mode?: Mode }

export class Scope {
  readonly joins: Join[] = []
  readonly joinAt = new Map<string, { alias: string; def: ModelDef }>()
  readonly ann = new Map<string, Compiled>()
  readonly counter: { n: number }
  sawAgg = false
  constructor(readonly t: TableDef, readonly d: Dialect, readonly o: ScopeOpts = {}) { this.counter = o.counter ?? { n: 0 } }
  get alias() { return this.o.alias ?? this.t.name }
  get mode(): Mode { return this.o.mode ?? 'select' }
  private q8(c: string, force = false): Expr { return qcol(c, this.o.qualify || force ? this.alias : undefined) }
  column(c: string): Expr { return this.q8(c) }
  private next(p: string) { return `${p}${++this.counter.n}` }

  child(def: ModelDef): Scope {
    if (this.mode === 'ddl') throw invalid('relation paths are not allowed in constraints')
    return new Scope(def as TableDef, this.d, { alias: this.next('u'), qualify: true, outer: this, counter: this.counter, mode: this.mode })
  }

  field(name: string, force = false): { f: F; field: string; col: Expr } {
    const r = resolve(this.t, name)
    return { ...r, col: this.q8(r.f.columns(r.field)[0], force) }
  }

  // ---- references: field / annotation / relation path (joins: SELECT only) ------------------------
  ref(path: string, force = false): Compiled {
    const a = this.ann.get(path)
    if (a) return a
    const parts = path.split('__')
    let def: TableDef = this.t, alias: string | undefined
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], last = i === parts.length - 1
      const rel = relationOf(def as ModelDef, p)
      if (rel && (!last || rel.kind !== 'fk')) {
        if (this.mode !== 'select') throw invalid(`related path "${path}" is only allowed in queries (not in update() / constraints)`, path)
        const j = this.join(parts.slice(0, i + 1).join('__'), rel, alias, def)
        def = j.def as TableDef; alias = j.alias
        if (last) return this.colOut(def, pkCol(j.def), alias)
        continue
      }
      if (!last) {
        // `price__currency`: a money field's currency column
        const m = def.fields[p]
        if (m?.kind === 'money' && i === parts.length - 2 && parts[i + 1] === 'currency') {
          const c = m.columns(p)[1]
          return { e: alias ? qcol(c, alias) : this.q8(c, force), f: OUT.text, agg: false }
        }
        throw invalid(`unknown relation "${p}" on ${def.name} (in "${path}")`, path)
      }
      const r = resolve(def, p)
      return this.colOut(def, r.field, alias, force)
    }
    throw invalid(`empty path`)
  }
  private colOut(def: TableDef, field: string, alias: string | undefined, force = false): Compiled {
    const f = def.fields[field]
    const [c, cur] = f.columns(field)
    const mk = (x: string) => (alias ? qcol(x, alias) : this.q8(x, force))
    return { e: mk(c), f, agg: false, ...(f.kind === 'money' ? { cur: mk(cur) } : {}) }
  }

  // LEFT JOIN for one relation hop (fk: one row; reverse / m2m: many)
  private join(key: string, rel: Relation, parentAlias: string | undefined, parent: TableDef): { alias: string; def: ModelDef } {
    const hit = this.joinAt.get(key)
    if (hit) return hit
    const pc = (c: string) => (parentAlias ? qcol(c, parentAlias) : this.q8(c, true))
    let out: { alias: string; def: ModelDef }
    if (rel.kind === 'fk') {
      const alias = this.next('j')
      this.joins.push({ table: rel.target.name, alias, on: bin('=', qcol(pkCol(rel.target), alias), pc(rel.col)) })
      out = { alias, def: rel.target }
    } else if (rel.kind === 'reverse') {
      const alias = this.next('j')
      this.joins.push({ table: rel.source.name, alias, on: bin('=', qcol(rel.col, alias), pc(pkCol(parent as ModelDef))) })
      out = { alias, def: rel.source }
    } else {
      const ta = this.next('j'), alias = this.next('j')
      this.joins.push({ table: rel.through.def.name, alias: ta, on: bin('=', qcol(rel.srcCol, ta), pc(pkCol(parent as ModelDef))) })
      this.joins.push({ table: rel.target.name, alias, on: bin('=', qcol(pkCol(rel.target), alias), qcol(rel.dstCol, ta)) })
      out = { alias, def: rel.target }
    }
    this.joinAt.set(key, out)
    return out
  }

  // ---- expressions --------------------------------------------------------------------------------
  expr(x: unknown, hint?: F): Compiled {
    if (!(x instanceof Expression)) {
      if (!hint) return { e: param(x), agg: false }
      const v = named(hint, () => hint.toDb(x, this.d))
      // money: {value, currency} carries its currency; a bare number is an amount only
      return { e: param(v[0]), f: hint, agg: false, ...(hint.kind === 'money' && v[1] != null ? { cur: param(v[1]) } : {}) }
    }
    switch (x.kind) {
      case 'F': return this.ref((x as any).name)
      case 'value': return this.expr((x as any).value, hint)
      case 'outer': {
        if (!this.o.outer) throw invalid('OuterRef() is only valid inside Subquery() / Exists()')
        return this.o.outer.ref((x as any).name, true)
      }
      case 'combined': {
        const { op, l, r } = x as any as { op: '+' | '-' | '*' | '/'; l: Expression; r: Expression }
        const a = this.expr(l)
        const b = this.expr(r, op === '+' || op === '-' ? a.f : undefined)
        for (const s of [a, b]) if (s.f && !NUMERIC.has(s.f.kind)) throw invalid(`arithmetic needs numeric fields (got ${s.f.kind})`)
        const f = a.f ?? b.f
        const base = { e: bin(op, a.e, b.e), f: f?.kind === 'id' ? OUT.int : f, agg: a.agg || b.agg }
        if (!isMoney(a) && !isMoney(b)) return base
        // money: + / - another amount in the SAME currency; * / by a plain number only
        if (op === '*' || op === '/') {
          if (!isMoney(a) || isMoney(b)) throw invalid(`money can only be ${op === '*' ? 'multiplied' : 'divided'} by a plain number (money on the left)`)
          return { ...base, f: a.f, cur: needCur(a, 'money arithmetic'), curGuard: a.curGuard }
        }
        const other = isMoney(a) ? b : a
        if (other.f && !isMoney(other)) throw invalid(`cannot add / subtract a ${other.f.kind} field to money (use an amount, or a money field)`)
        const m = isMoney(a) ? a : b
        const ca = needCur(m, 'money arithmetic')
        if (!other.cur || sameExpr(ca, other.cur)) return { ...base, f: m.f, cur: ca, curGuard: m.curGuard || other.curGuard }
        // two currencies: equal at run time, or NULL (a read refuses it; update() refuses the expression)
        return { ...base, f: m.f, cur: { t: 'case', whens: [[bin('=', ca, other.cur), ca]] }, curGuard: true }
      }
      case 'func': {
        const { fn: name, args } = x as any as { fn: 'lower' | 'upper' | 'length' | 'coalesce' | 'abs'; args: Expression[] }
        const cs: Compiled[] = []
        for (const a of args) cs.push(this.expr(a, cs[0]?.f))
        const f = name === 'length' ? OUT.int : name === 'lower' || name === 'upper' ? OUT.text : cs[0]?.f
        const out: Compiled = { e: { t: 'func', fn: name, args: cs.map(c => c.e) }, f, agg: cs.some(c => c.agg) }
        if (f?.kind === 'money' && name === 'coalesce') {
          // the currency of the first non-null amount
          out.cur = { t: 'func', fn: 'coalesce', args: cs.map(c => ({ t: 'case' as const, whens: [[isNotNull(c.e), needCur(c, 'Coalesce')] as [Expr, Expr]] })) }
          out.curGuard = cs.some(c => c.curGuard)
        } else if (f?.kind === 'money' && name === 'abs') { out.cur = needCur(cs[0], 'Abs'); out.curGuard = cs[0].curGuard }
        return out
      }
      case 'cast': {
        const { e, to } = x as any as { e: Expression; to: 'int' | 'float' | 'text' }
        const c = this.expr(e)
        return { e: { t: 'cast', e: c.e, to }, f: OUT[to], agg: c.agg }
      }
      case 'trunc': {
        const { unit, e } = x as any as { unit: 'year' | 'month' | 'day'; e: Expression }
        const c = this.expr(e)
        if (c.f?.kind !== 'datetime') throw invalid(`Trunc needs a datetime field`)
        return { e: { t: 'trunc', unit, e: c.e }, f: c.f, agg: c.agg }
      }
      case 'case': {
        const { whens, otherwise } = x as any as { whens: { cond: QNode; then: Expression }[]; otherwise?: Expression }
        const thens: Compiled[] = []
        let hintF: F | undefined
        for (const w of whens) if (w.then instanceof Expression && w.then.kind !== 'value') hintF ??= this.expr(w.then).f
        const ws = whens.map(w => { const t = this.expr(w.then, hintF); thens.push(t); return [this.q(w.cond), t.e] as [Expr, Expr] })
        const el = otherwise === undefined ? undefined : this.expr(otherwise, hintF)
        const out: Compiled = { e: { t: 'case', whens: ws, ...(el ? { else: el.e } : {}) }, f: hintF, agg: thens.some(t => t.agg) || !!el?.agg }
        if (hintF?.kind === 'money') {   // each branch's currency, picked by the same conditions
          out.cur = { t: 'case', whens: ws.map(([c], i) => [c, needCur(thens[i], 'Case')] as [Expr, Expr]), ...(el ? { else: needCur(el, 'Case') } : {}) }
          out.curGuard = thens.some(t => t.curGuard) || !!el?.curGuard
        }
        return out
      }
      case 'agg': {
        const { fn: name, e, distinct, filter } = x as any as { fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; e?: Expression; distinct: boolean; filter?: QNode }
        const a = e ? this.expr(e) : undefined
        if (a?.agg) throw invalid('aggregates cannot be nested')
        const cond = filter ? this.q(filter) : undefined
        const gate = (v: Expr): Expr => (cond ? { t: 'case', whens: [[cond, v]] } : v)
        const arg = a ? gate(a.e) : cond ? gate(raw('1')) : undefined
        const money = a?.f?.kind === 'money'
        if (money && name !== 'count') {
          // a money aggregate is only meaningful in one currency: CASE WHEN MIN(cur) = MAX(cur) THEN MIN(cur) END
          const cur = gate(a!.cur!)
          const curE: Expr = { t: 'case', whens: [[bin('=', aggNode('min', cur), aggNode('max', cur)), aggNode('min', cur)]] }
          return { e: aggNode(name, arg, distinct), f: a!.f, cur: curE, agg: true, ...(name === 'avg' ? { round: true } : {}) }
        }
        if (a?.f && (name === 'sum' || name === 'avg') && !NUMERIC.has(a.f.kind)) throw invalid(`${name.toUpperCase()} needs a numeric field (got ${a.f.kind})`)
        const f = name === 'count' ? OUT.int : name === 'avg' ? OUT.float : a?.f?.kind === 'id' ? OUT.int : a?.f
        return { e: aggNode(name, arg, distinct), f, agg: true }
      }
      case 'subquery': {
        const { select, out } = this.sub((x as any).qs, 'scalar')
        return { e: { t: 'sub', q: select }, f: out, agg: false }
      }
      case 'exists': return { e: { t: 'exists', q: this.sub((x as any).qs, 'exists').select }, f: OUT.bool, agg: false }
    }
    throw invalid(`unsupported expression ${(x as Expression).kind}`)
  }

  // a queryset compiled as a correlated subquery of this scope
  sub(qs: QueryLike, kind: 'scalar' | 'exists' | 'in'): { select: Select; out?: F } {
    if (this.mode === 'ddl') throw invalid('subqueries are not allowed in constraints')
    const { def, spec } = qs.__query()
    const inner = new Scope(def as TableDef, this.d, { alias: this.next('u'), qualify: true, outer: this, counter: this.counter, mode: this.mode })
    const b = buildSelect(inner, def, { ...spec, cursor: undefined, related: undefined }, kind === 'scalar' ? 1 : undefined)
    if (kind === 'exists') {
      // a grouped / distinct subquery keeps its own columns (GROUP BY ordinals): EXISTS over it as a derived table
      if (b.select.groupBy || b.select.distinct || b.select.distinctOn || b.select.having) {
        return { select: { t: 'select', from: { ...b.select, order: undefined, ...(b.select.cols ? {} : { cols: [raw('1')] }) }, as: this.next('g'), cols: [raw('1')] } }
      }
      return { select: { ...b.select, cols: [raw('1')], order: undefined } }
    }
    let cols = b.select.cols, out: F | undefined
    if (spec.values) {
      if (b.plan.outs.length !== 1) throw invalid('a subquery must select exactly one value: .values(\'field\')')
      out = b.plan.outs[0].f
      cols = [b.firstCol!]
    } else {
      cols = [inner.field(pkCol(def)).col]
      out = pkField(def)[1]
    }
    return { select: { ...b.select, cols, ...(kind === 'in' ? { order: undefined } : {}) }, out }
  }

  // ---- conditions -------------------------------------------------------------------------------------
  q(node: QNode, safe = false): Expr {
    const inner = safe || node.negated
    // inside one filter() / one AND node, lookups through the SAME to-many relation must hold
    // for ONE related row — they share one subquery (chained filter() calls stay separate)
    const groups = new Map<string, [string, unknown][]>()
    if (node.conn === 'and') {
      for (const c of node.children) {
        if (c instanceof QNode || c instanceof Expression) continue
        const head = c[0].split('__')[0], rel = relationOf(this.t as ModelDef, head)
        if ((rel?.kind === 'reverse' || rel?.kind === 'm2m') && !/__isnull$/.test(c[0])) groups.set(head, [...(groups.get(head) ?? []), c])
      }
    }
    for (const [k, v] of [...groups]) if (v.length < 2) groups.delete(k)
    const done = new Set<string>()
    const parts = node.children.flatMap(c => {
      if (c instanceof QNode) return [this.q(c, inner)]
      if (c instanceof Expression) return [this.expr(c).e]
      const head = c[0].split('__')[0], g = groups.get(head)
      if (!g) return [this.leaf(c[0], c[1], inner)]
      if (done.has(head)) return []
      done.add(head)
      const rel = relationOf(this.t as ModelDef, head)!
      const restKey = (k: string) => {
        const rest = k.split('__').slice(1)
        return rest.length && !LOOKUPS.has(rest[0]) ? rest.join('__') : [pkCol(rel.target), ...rest].join('__')
      }
      return [this.relIn(rel, s => s.q(new QNode('and', g.map(([k, v]) => [restKey(k), v] as [string, unknown]))))]
    })
    const e = parts.length ? (node.conn === 'and' ? and(...parts) : or(...parts)) : raw('1')
    return node.negated ? not(e) : e
  }

  // one `path__op: value` lookup. safe (under a NOT): two-valued form `(leaf AND subject IS NOT NULL)`,
  // so the negation is null-inclusive like exclude()
  leaf(key: string, value: unknown, safe = false): Expr {
    const parts = key.split('__')
    let op: LeafOp = 'eq'
    if (parts.length > 1 && LOOKUPS.has(parts[parts.length - 1])) {
      const o = parts.pop()!
      op = (o === 'exact' ? 'eq' : o === 'icontains' ? 'contains' : o === 'istartswith' ? 'startswith' : o === 'iendswith' ? 'endswith' : o) as LeafOp
    }
    const r = this.leafExpr(parts, op, value, key)
    return safe && r.subject && !r.nullAware ? and(r.e, isNotNull(r.subject)) : r.e
  }

  private leafExpr(parts: string[], op: LeafOp, value: unknown, key: string): { e: Expr; subject?: Expr; nullAware?: boolean } {
    const name = parts[0]
    if (op === 'in' && Array.isArray(value) && value.length > MAX_IN) throw invalid(`too many values in IN filter (max ${MAX_IN})`, key)
    const ann = parts.length === 1 ? this.ann.get(name) : undefined
    if (ann) {
      if (ann.agg) this.sawAgg = true
      return this.compare(ann.e, ann.f, op, value, key)
    }
    const rel = relationOf(this.t as ModelDef, name)
    if (rel && (parts.length > 1 || rel.kind !== 'fk')) {
      if (op === 'isnull' && parts.length === 1) {
        if (rel.kind === 'fk') return { e: value ? isNull(this.field(name).col) : isNotNull(this.field(name).col), nullAware: true }
        const has = this.relIn(rel)
        return { e: value ? not(has) : has, nullAware: true }
      }
      const rest = parts.length > 1 ? parts.slice(1) : [pkCol(rel.target)]
      const restKey = [...rest, ...(op === 'eq' ? [] : [op])].join('__')
      const e = this.relIn(rel, s => s.leaf(restKey, value))
      // `rel__x__isnull=True` also matches rows with no related row at all (LEFT JOIN semantics)
      if (rel.kind === 'fk' && op === 'isnull' && value) return { e: or(isNull(this.field(name).col), e), nullAware: true }
      return { e, subject: rel.kind === 'fk' ? this.field(name).col : undefined }
    }
    if (parts.length === 2 && parts[1] === 'currency' && this.t.fields[name]?.kind === 'money') {
      return this.compare(this.q8(this.t.fields[name].columns(name)[1]), OUT.text, op, value, key)
    }
    const tf = this.t.fields[name]
    if (parts.length === 2 && TRANSFORMS.has(parts[1]) && (tf?.kind === 'date' || tf?.kind === 'datetime')) {
      const part = parts[1] as 'year' | 'month' | 'day' | 'date'
      const e: Expr = { t: 'extract', part, e: this.field(name).col, src: tf.kind }
      return this.compare(e, part === 'date' ? OUT.date : OUT.int, op, value, key)
    }
    if (parts.length > 1) {
      if (this.t.fields[name] || Object.entries(this.t.fields).some(([n, f]) => f.key(n) === name)) throw invalid(`unsupported lookup "${parts.slice(1).join('__')}" on ${this.t.name}.${name}`, key)
      throw invalid(`unknown relation "${name}" on ${this.t.name}`, key)
    }
    const { f, col: c } = this.field(name)
    return this.compare(c, f, op, value, key)
  }

  // `local IN (SELECT …)` through one relation hop; `cond` is the lookup inside, on the related table's
  // scope (absent: just "has a related row" — reverse / m2m __isnull)
  private relIn(rel: Relation, cond?: (s: Scope) => Expr): Expr {
    const inner = this.child(rel.kind === 'm2m' ? rel.through.def : rel.kind === 'reverse' ? rel.source : rel.target)
    const any = !cond
    const local = (c: string) => this.q8(c)
    if (rel.kind === 'fk') {
      const w = any ? undefined : cond(inner)
      return { t: 'inSub', e: local(rel.col), q: this.wrapW({ t: 'select', from: rel.target.name, as: inner.alias, cols: [inner.field(pkCol(rel.target)).col], where: w }) }
    }
    if (rel.kind === 'reverse') {
      const c = inner.field(rel.field).col
      const w = any ? isNotNull(c) : and(cond(inner), isNotNull(c))
      return { t: 'inSub', e: local(pkCol(this.t as ModelDef)), q: this.wrapW({ t: 'select', from: rel.source.name, as: inner.alias, cols: [c], where: w }) }
    }
    // m2m: pk IN (SELECT src FROM through WHERE dst IN (SELECT pk FROM target WHERE …))
    const tgt = inner.child(rel.target)
    const dst = qcol(rel.dstCol, inner.alias)
    const w = any ? undefined
      : { t: 'inSub' as const, e: dst, q: { t: 'select' as const, from: rel.target.name, as: tgt.alias, cols: [tgt.field(pkCol(rel.target)).col], where: cond(tgt) } }
    return { t: 'inSub', e: local(pkCol(this.t as ModelDef)), q: this.wrapW({ t: 'select', from: rel.through.def.name, as: inner.alias, cols: [qcol(rel.srcCol, inner.alias)], where: w }) }
  }

  // mysql refuses a subquery on the UPDATE / DELETE target table: one derived-table level hides it
  private wrapW(s: Select): Select {
    if (this.mode !== 'write' || this.d.name !== 'mysql') return s
    const a = this.next('w')
    return { t: 'select', from: { ...s, cols: [as(s.cols![0], 'v')] }, as: a, cols: [qcol('v', a)] }
  }

  // lhs (column or expression) `op` value — the field's own lookup for plain values
  private compare(lhs: Expr, f: F | undefined, op: LeafOp, value: unknown, key: string): { e: Expr; subject?: Expr; nullAware?: boolean } {
    if (op === 'isnull') return { e: value ? isNull(lhs) : isNotNull(lhs), nullAware: true }
    if (value instanceof Expression) {
      if (op === 'in') {
        if (value.kind !== 'subquery') throw invalid(`${key}: __in takes a list or a Subquery()`, key)
        return { e: { t: 'inSub', e: lhs, q: this.sub((value as any).qs, 'in').select }, subject: lhs }
      }
      const rhs = this.expr(value, f)
      if (rhs.agg) this.sawAgg = true
      const b = CMP[op]
      if (!b) throw invalid(`${key}: ${op} cannot compare to an expression`, key)
      return { e: bin(b, lhs, rhs.e), subject: lhs }
    }
    if (op === 'range') {   // __range: inclusive BETWEEN, each bound through the field
      if (!Array.isArray(value) || value.length !== 2 || value.some(v => v == null)) throw invalid(`${key}: __range takes [low, high]`, key)
      const lk = f ?? OUT.float
      return { e: named2(key, () => and(lk.lookup('gte', lhs, value[0], this.d), lk.lookup('lte', lhs, value[1], this.d))), subject: lhs }
    }
    if (op === 'iexact') {  // __iexact: case-insensitive equality (LIKE with every wildcard escaped)
      if (value == null) return { e: isNull(lhs), nullAware: true }
      if (typeof value !== 'string') throw invalid(`${key}: iexact needs a string`, key)
      if (f?.kind === 'money') throw invalid(`money does not support iexact`, key)
      return { e: and(isNotNull(lhs), like(castText(lhs), param(escLike(value)), true)), subject: lhs }
    }
    if (op === 'startswith' || op === 'endswith') {
      if (typeof value !== 'string') throw invalid(`${key}: ${op} needs a string`, key)
      if (f?.kind === 'money') throw invalid(`money does not support ${op}`, key)
      const pat = op === 'startswith' ? `${escLike(value)}%` : `%${escLike(value)}`
      return { e: and(isNotNull(lhs), like(fn('coalesce', castText(lhs), param('')), param(pat), true)), subject: lhs }
    }
    const lk = f ?? OUT.float
    const e = named2(key, () => (f ? lk.lookup(op, lhs, value, this.d) : plainLookup(op, lhs, value)))
    return { e, subject: lhs, nullAware: op === 'ne' || (op === 'eq' && value == null) }
  }

  // a Where (the flat filter form views send): the original null-inclusive exclude semantics
  where(w: Where): Expr {
    if (w.field.includes('__') || this.ann.has(w.field)) {
      const k = w.op === 'eq' ? w.field : `${w.field}__${w.op}`
      return w.not ? not(this.leaf(k, w.value, true)) : this.leaf(k, w.value)
    }
    const { f, col: c } = this.field(w.field)
    try {
      if (!w.not) return f.lookup(w.op, c, w.value, this.d)
      // null-inclusive negation (orm-queryset.md): missing values match exclude() — except when the
      // value itself is null: exclude(eq null) = IS NOT NULL, exclude(ne x) = eq x (incl. IS NULL)
      if (w.op === 'ne') return f.lookup('eq', c, w.value, this.d)
      if (w.op === 'eq' && w.value == null) return f.lookup('ne', c, null, this.d)
      return or(isNull(c), not(f.lookup(w.op, c, w.value, this.d)))
    } catch (e) {   // a field's own value error (money amount) names the filtered field
      if (e instanceof DomainError && e.code === 'invalid_param' && !e.field) e.field = w.field
      throw e
    }
  }

  // every filter of a spec, split by whether it touches an aggregate (→ HAVING)
  filters(spec: Pick<QuerySpec, 'where' | 'q' | 'search'>): { where?: Expr; having?: Expr } {
    const w: Expr[] = [], h: Expr[] = []
    const put = (fn: () => Expr) => { this.sawAgg = false; const e = fn(); (this.sawAgg ? h : w).push(e) }
    for (const x of spec.where) put(() => this.where(x))
    for (const x of spec.q ?? []) put(() => this.q(x))
    if (spec.search?.term) {
      w.push(or(...spec.search.fields.map(n => {
        const { f, col: c } = this.field(n)
        if (f.kind === 'money') throw invalid(`money field "${n}" cannot be searched`, n)
        return containsExpr(c, spec.search!.term)
      })))
    }
    return { where: w.length ? and(...w) : undefined, having: h.length ? and(...h) : undefined }
  }
}

const plainLookup = (op: LeafOp, lhs: Expr, v: unknown): Expr => {
  if (op === 'in') return Array.isArray(v) && v.length ? inList(lhs, v.map(param)) : FALSE
  if (op === 'contains') return and(isNotNull(lhs), containsExpr(lhs, String(v)))
  if (v == null) return op === 'ne' ? isNotNull(lhs) : isNull(lhs)
  return bin(CMP[op]!, lhs, param(v))
}

function named<R>(f: F, fn: () => R): R {
  try { return fn() } catch (e) { if (e instanceof DomainError) throw e; throw invalid(String((e as Error).message)) }
}
function named2<R>(key: string, fn: () => R): R {
  try { return fn() } catch (e) {
    if (e instanceof DomainError && e.code === 'invalid_param' && !e.field) e.field = key
    throw e
  }
}

// ---- the flat entry points (unchanged SQL for plain specs) -------------------------------------------
export function cond(t: TableDef, w: Where, d: Dialect): Expr { return new Scope(t, d).where(w) }

export function whereOf(t: TableDef, ws: Where[], d: Dialect, search?: QuerySpec['search'], q?: QuerySpec['q'], mode: Mode = 'select'): Expr | undefined {
  const s = new Scope(t, d, { mode })
  const r = s.filters({ where: ws, q, search })
  if (r.having) throw invalid('a filter on an aggregate needs annotate() in a query')
  return r.where
}

// Keyset WHERE: rows strictly after the cursor row under `order`. Default nulls are the smallest value
// (asc goes past them, desc ends with them); an explicit nulls placement flips that per key.
// keys: e = sort expression, f = the field whose toDb converts the cursor value (absent: raw DB value)
export interface Key { e: Expr; f?: F; dir: 'asc' | 'desc'; nulls?: 'first' | 'last' }
export function keysetOf(keys: Key[], cv: unknown[], d: Dialect): Expr {
  let vals: unknown[]
  try { vals = cv.map((v, i) => (keys[i].f ? keys[i].f!.toDb(v, d)[0] : v)) } catch (e) {     // tampered cursor (e.g. a bad money amount)
    if (e instanceof DomainError) throw new DomainError('invalid_param', 'invalid cursor', 'cursor')
    throw e
  }
  const nullsFirst = (k: Key) => (k.nulls ? k.nulls === 'first' : k.dir === 'asc')
  const same = (i: number) => (vals[i] == null ? isNull(keys[i].e) : bin('=', keys[i].e, param(vals[i])))
  const beyond = (i: number): Expr => {
    const k = keys[i], nf = nullsFirst(k)
    if (vals[i] == null) return nf ? isNotNull(k.e) : FALSE
    const past = bin(k.dir === 'asc' ? '>' : '<', k.e, param(vals[i]))
    return nf ? past : or(past, isNull(k.e))
  }
  return or(...keys.map((_, i) => and(...Array.from({ length: i }, (_, j) => same(j)), beyond(i))))
}

export function keyset(t: TableDef, order: Order[], cv: unknown[], d: Dialect): Expr {
  const s = new Scope(t, d)
  return keysetOf(order.map(o => { const r = s.field(o.field); return { e: r.col, f: r.f, dir: o.dir, nulls: o.nulls } }), cv, d)
}

// ---- SELECT -----------------------------------------------------------------------------------------
export interface Out { key: string; alias: string; f?: F; round?: boolean }
export interface RelPlan { path: string[]; def: ModelDef; cols: Record<string, string> }   // column → select alias
export interface Plan {
  mode: 'model' | 'values'
  def: ModelDef
  outs: Out[]                          // values mode: every output; model mode: annotations
  related: RelPlan[]
  cursor: ({ key: string } | { alias: string })[]   // per order key: a row property, or a raw selected column
  simple: boolean                      // SELECT * of the model, no extra columns
}

const checkAlias = (name: string, t: TableDef) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.includes('__')) throw invalid(`annotation name "${name}" must be an identifier without "__"`, name)
  for (const [n, f] of Object.entries(t.fields)) {
    if (n === name || f.key(n) === name || f.columns(n).includes(name)) throw invalid(`annotation "${name}" conflicts with a field on ${t.name}`, name)
  }
}

// the full select for a spec in `s` (main query or subquery)
function buildSelect(s: Scope, def: ModelDef, spec: QuerySpec, limit?: number): { select: Select; plan: Plan; firstCol?: Expr; grouped: boolean; base: { where?: Expr; having?: Expr } } {
  for (const [name, x] of spec.annotate ?? []) { checkAlias(name, s.t); s.ann.set(name, s.expr(x)) }
  const { where, having } = s.filters(spec)
  const cols: Expr[] = []
  const outs: Out[] = [], related: RelPlan[] = [], cursor: Plan['cursor'] = []
  const aggs: boolean[] = []          // per select column: is it an aggregate?
  const push = (e: Expr, alias: string | undefined, isAgg: boolean) => { cols.push(alias ? as(e, alias) : e); aggs.push(isAgg) }
  const outCols = (c: Compiled, alias: string) => {
    if (c.f && c.f.kind !== 'm2m') {
      const names = c.f.columns(alias)
      push(c.e, names[0], c.agg)
      if (names[1]) push(needCur(c, alias), names[1], c.agg)
    } else push(c.e, alias, c.agg)
  }
  let firstCol: Expr | undefined
  const values = spec.values
  if (values) {
    const names = values.length ? values : [...concrete(def.fields).map(([n]) => n), ...(spec.annotate ?? []).map(([n]) => n)]
    names.forEach((name, i) => {
      const c = s.ref(name)
      const alias = s.ann.has(name) ? name : `x__v${i}`
      if (i === 0) firstCol = c.e
      outs.push({ key: name, alias, f: c.f, round: c.round })
      outCols(c, alias)
    })
  } else {
    for (const [n, f] of concrete(def.fields)) for (const c of f.columns(n)) push(s.column(c), undefined, false)
    for (const [name] of spec.annotate ?? []) {
      const c = s.ann.get(name)!
      outs.push({ key: name, alias: name, f: c.f, round: c.round })
      outCols(c, name)
    }
    // selectRelated('a__b') selects a too
    const paths = [...new Set((spec.related ?? []).flatMap(p => p.split('__').map((_, i, xs) => xs.slice(0, i + 1).join('__'))))]
    for (const path of paths) related.push(selectRelated(s, def, path, related.length, push))
  }
  const grouped = !!having || aggs.some(Boolean)
  // order: annotation names, fields, relation paths; aggregates in a grouped query order by alias
  const order: OrderTerm[] = []
  const keys: Key[] = []
  for (const [i, o] of (spec.order ?? []).entries()) {
    const a = s.ann.get(o.field)
    let e: Expr, f: F | undefined, curKey: Plan['cursor'][number]
    if (a) {
      e = a.e; curKey = { alias: o.field }
      order.push({ e: grouped ? col(o.field) : a.e, dir: o.dir, nulls: o.nulls })
    } else {
      const c = s.ref(o.field)
      e = c.e
      const direct = !o.field.includes('__') && (def.fields[o.field] || Object.entries(def.fields).some(([n, x]) => x.key(n) === o.field))
      if (direct) {
        const r = s.field(o.field)
        f = r.f; curKey = { key: r.f.key(r.field) }
      } else if (!values) {
        push(e, `x__o${i}`, false); curKey = { alias: `x__o${i}` }
      } else curKey = { alias: `x__o${i}` }
      order.push({ e, dir: o.dir, nulls: o.nulls })
    }
    keys.push({ e, f, dir: o.dir, nulls: o.nulls })
    cursor.push(curKey)
  }
  let distinctOn: Expr[] | undefined
  if (Array.isArray(spec.distinct)) {
    distinctOn = spec.distinct.map(n => s.ref(n).e)
    const lead = (spec.order ?? []).slice(0, spec.distinct.length).map(o => o.field)
    if (lead.length < spec.distinct.length || !spec.distinct.every(n => lead.includes(n))) {
      throw invalid(`distinct(${spec.distinct.join(', ')}) needs order() to start with the same fields`)
    }
  }
  let w = where, h = having
  if (spec.cursor) {
    const cv = decodeCursor(spec.cursor)
    if (cv.length !== keys.length) throw invalid('invalid cursor', 'cursor')
    const n = distinctOn ? distinctOn.length : keys.length   // DISTINCT ON: one row per leading key — page on those
    const k = keysetOf(keys.slice(0, n), cv.slice(0, n), s.d)
    const onAgg = (spec.order ?? []).slice(0, n).some(o => s.ann.get(o.field)?.agg)
    if (onAgg) h = h ? and(h, k) : k
    else w = w ? and(w, k) : k
  }
  const simple = !values && !spec.annotate?.length && !related.length && !cursor.some(c => 'alias' in c) && !spec.distinct
  const groupBy = grouped ? aggs.flatMap((g, i) => (g ? [] : [{ t: 'ordinal' as const, n: i + 1 }])) : undefined
  const select: Select = {
    t: 'select', from: def.name, ...(s.o.alias ? { as: s.o.alias } : {}),
    ...(simple ? {} : { cols }),
    ...(s.joins.length ? { joins: s.joins } : {}),
    ...(w ? { where: w } : {}),
    ...(groupBy?.length ? { groupBy } : {}),
    ...(h ? { having: h } : {}),
    ...(order.length ? { order } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(spec.distinct === true ? { distinct: true } : {}),
    ...(distinctOn ? { distinctOn } : {}),
    ...(spec.forUpdate ? { forUpdate: spec.forUpdate } : {}),
  }
  return { select, plan: { mode: values ? 'values' : 'model', def, outs, related, cursor, simple }, firstCol, grouped, base: { where, having } }
}
// LEFT JOIN through an fk chain; every target column selected under a short alias (r<k>_<j>)
function selectRelated(s: Scope, def: ModelDef, path: string, k: number, push: (e: Expr, alias: string, agg: boolean) => void): RelPlan {
  const parts = path.split('__')
  let cur: ModelDef = def
  for (const p of parts) {
    const rel = relationOf(cur, p)
    if (rel?.kind !== 'fk') throw invalid(`selectRelated("${path}"): "${p}" is not a foreign key on ${cur.name} (use prefetchRelated for many-valued relations)`, path)
    cur = rel.target
  }
  // reuse the join that ref() builds for `path__<pk>`
  s.ref(`${path}__${pkCol(cur)}`)
  const j = s.joinAt.get(path)!
  const cols: Record<string, string> = {}
  let i = 0
  for (const [n, f] of concrete(cur.fields)) for (const c of f.columns(n)) {
    const alias = `x__r${k}_${i++}`
    cols[c] = alias
    push(qcol(c, j.alias), alias, false)
  }
  return { path: parts, def: cur, cols }
}

export interface Compiled2 { count: Select; page?: Select; plan: Plan }

// The read path: a count over the filter, plus the page (absent when limit <= 0). Columns are qualified
// only when the query joins (a second pass), so plain specs keep their exact SQL.
export function compileQuery(spec: QuerySpec, t: TableDef, d: Dialect): Compiled2 {
  const run = (qualify: boolean) => {
    const s = new Scope(t, d, { qualify })
    const b = buildSelect(s, t as ModelDef, spec, spec.limit > 0 && Number.isFinite(spec.limit) ? spec.limit : undefined)
    return { s, b }
  }
  let { s, b } = run(false)
  if (s.joins.length) ({ s, b } = run(true))
  const { select, plan, grouped, base } = b
  const needSub = grouped || !!spec.distinct
  // the count ignores the cursor (total of the whole filter)
  const count: Select = needSub
    ? { t: 'select', from: { ...select, where: base.where, having: base.having, order: undefined, limit: undefined, forUpdate: undefined, ...(select.cols ? {} : { cols: [raw('1')] }) }, as: 'c', cols: [fn('count', raw('*'))] }
    : { t: 'select', from: t.name, cols: [fn('count', raw('*'))], ...(select.joins ? { joins: select.joins } : {}), ...(base.where ? { where: base.where } : {}) }
  if (spec.offset && spec.cursor) throw invalid('a cursor page cannot also be sliced (offset)', 'cursor')
  return { count, page: spec.limit > 0 ? (spec.offset ? { ...select, offset: spec.offset } : select) : undefined, plan }
}

// The plain read path (unchanged contract): a count over the filter, plus the page.
export function compile(spec: QuerySpec, t: TableDef, d: Dialect): { count: Select; page?: Select } {
  const { count, page } = compileQuery(spec, t, d)
  return { count, page }
}

// SELECT agg AS alias, … FROM t WHERE … (aggregate())
export function compileAggregate(spec: QuerySpec, t: TableDef, aggs: [string, Expression][], d: Dialect): { select: Select; outs: Out[] } {
  if (spec.values || spec.distinct || spec.annotate?.some(([, x]) => (x as { kind: string }).kind === 'agg')) {
    throw invalid('aggregate() over values() / distinct() / aggregate annotations is not supported; aggregate the base queryset')
  }
  const run = (qualify: boolean) => {
    const s = new Scope(t, d, { qualify })
    for (const [name, x] of spec.annotate ?? []) { checkAlias(name, t); s.ann.set(name, s.expr(x)) }
    const { where, having } = s.filters(spec)
    if (having) throw invalid('aggregate(): a filter on an aggregate is not supported here')
    const cols: Expr[] = [], outs: Out[] = []
    for (const [name, x] of aggs) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw invalid(`aggregate name "${name}" must be an identifier`, name)
      const c = s.expr(x)
      if (!c.agg) throw invalid(`aggregate(): ${name} is not an aggregate (Sum, Count, Avg, Min, Max)`, name)
      const names = c.f ? c.f.columns(name) : [name]
      cols.push(as(c.e, names[0]))
      if (names[1]) cols.push(as(needCur(c, name), names[1]))
      outs.push({ key: name, alias: name, f: c.f, round: c.round })
    }
    return { s, select: { t: 'select' as const, from: t.name, cols, ...(s.joins.length ? { joins: s.joins } : {}), ...(where ? { where } : {}) }, outs }
  }
  let r = run(false)
  if (r.s.joins.length) r = run(true)
  return { select: r.select, outs: r.outs }
}

// UPDATE … SET col = <expression> (write mode: relation paths refused, subqueries wrapped on mysql)
export function writeScope(t: TableDef, d: Dialect): Scope { return new Scope(t, d, { mode: 'write' }) }
export function ddlScope(t: TableDef, d: Dialect): Scope { return new Scope(t, d, { mode: 'ddl' }) }
