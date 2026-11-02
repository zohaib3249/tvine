'use client'
// The condition builder, shared by rule editing and the panel access editor. It edits the contract JSON directly
// ({all|any: [...]}, {not: x}, {field, op, value}) so what you see is exactly what is saved. Every control has a stable
// agentId built from its path in the tree ("c0.1-op" = second item of the first group's op picker).
import { BOT_CATEGORIES, CIDR_RE, COUNTRIES, IP_RE, OPS, OP_LABEL, coerce, fieldOf, isGroup, isMulti, kidsOf, leaf, type Field } from './fields.js'
import type { Cond, Condition, Op } from './types.js'
import { Icon, cx } from '../ui.js'

type P<T> = { node: T; path: string; fields: Field[]; onChange(c: Condition): void; onRemove?(): void; depth: number }

export function ConditionBuilder({ value, onChange, fields, label = 'Conditions' }: { value: Condition; onChange(c: Condition): void; fields: Field[]; label?: string }) {
  // the root is always a group, so "+ condition" has somewhere to go
  const root: Condition = isGroup(value) || ('not' in value && isGroup(value.not)) ? value : { all: [value] }
  return <div role="group" aria-label={label} className="tvs-cond"><Node node={root} path="c" fields={fields} onChange={onChange} depth={0} /></div>
}

function Node({ node, path, fields, onChange, onRemove, depth }: P<Condition>) {
  const negated = 'not' in node
  const inner = negated ? node.not : node
  const set = (c: Condition) => onChange(negated ? { not: c } : c)
  const not = (
    <label className="flex items-center gap-1.5 text-xs font-medium text-muted" title="Invert: match when this is NOT true">
      <input type="checkbox" agentId={`${path}-not`} className="tva-check" checked={negated} onChange={(e) => onChange(e.target.checked ? { not: inner } : inner)} />NOT
    </label>
  )
  if (isGroup(inner) || 'not' in inner) {
    const g = 'not' in inner ? { all: [inner] } : inner
    return <Group node={g} path={path} fields={fields} onChange={set} onRemove={onRemove} depth={depth} not={not} negated={negated} />
  }
  return <Leaf node={inner} path={path} fields={fields} onChange={set} onRemove={onRemove} depth={depth} not={not} />
}

function Group({ node, path, fields, onChange, onRemove, depth, not, negated }: P<{ all: Condition[] } | { any: Condition[] }> & { not: React.ReactNode; negated: boolean }) {
  const mode = 'all' in node ? 'all' : 'any'
  const kids = kidsOf(node)
  const put = (k: Condition[], m = mode) => onChange(m === 'all' ? { all: k } : { any: k })
  return (
    <div className={cx('tvs-group', negated && 'is-not')} data-depth={depth}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Match</span>
        <div className="tva-seg" role="group" aria-label="Match mode">
          <button type="button" agentId={`${path}-all`} aria-pressed={mode === 'all'} onClick={() => put(kids, 'all')}>all</button>
          <button type="button" agentId={`${path}-any`} aria-pressed={mode === 'any'} onClick={() => put(kids, 'any')}>any</button>
        </div>
        <span className="text-xs text-muted">{mode === 'all' ? 'every line must be true' : 'at least one line must be true'}</span>
        <div className="flex-1" />
        {not}
        {onRemove && <button type="button" agentId={`${path}-remove`} aria-label="Remove group" className="tva-btn tva-btn-ghost tva-btn-icon h-7 w-7 text-muted" onClick={onRemove}><Icon name="x" size={14} /></button>}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {kids.length === 0 && <p className="rounded-md border border-dashed border-line p-3 text-center text-xs text-muted">No conditions: matches every request.</p>}
        {kids.map((k, i) => (
          <Node key={i} node={k} path={`${path}.${i}`} fields={fields} depth={depth + 1}
            onChange={(c) => put(kids.map((x, j) => (j === i ? c : x)))} onRemove={() => put(kids.filter((_, j) => j !== i))} />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" agentId={`${path}-add`} className="tva-btn h-8 text-[13px]" onClick={() => put([...kids, leaf(fields[0]!)])}><Icon name="plus" size={14} />Condition</button>
        {depth < 3 && <button type="button" agentId={`${path}-add-group`} className="tva-btn tva-btn-ghost h-8 text-[13px]" onClick={() => put([...kids, { any: [leaf(fields[0]!)] }])}><Icon name="layers" size={14} />Group</button>}
      </div>
    </div>
  )
}

function Leaf({ node, path, fields, onChange, onRemove, not }: P<Cond> & { not: React.ReactNode }) {
  const f = fieldOf(fields, node.field)
  const ops = OPS[f.type]
  const header = f.name === 'header.'
  return (
    <div className="tvs-leaf">
      <select agentId={`${path}-field`} aria-label="Field" className="tva-input h-8 text-[13px] sm:w-44" value={f.name}
        onChange={(e) => onChange(leaf(fieldOf(fields, e.target.value)))}>
        {fields.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
      </select>
      {header && <input agentId={`${path}-header`} aria-label="Header name" className="tva-input h-8 font-mono text-[13px] sm:w-40" value={node.field.slice(7)}
        onChange={(e) => onChange({ ...node, field: `header.${e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')}` })} />}
      <select agentId={`${path}-op`} aria-label="Operator" className="tva-input h-8 text-[13px] sm:w-40" value={ops.includes(node.op) ? node.op : ops[0]}
        onChange={(e) => { const op = e.target.value as Op; onChange({ ...node, op, value: coerce(node.value, op, f.type) }) }}>
        {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
      </select>
      <div className="min-w-0 flex-1"><Value node={node} f={f} path={path} onChange={(value) => onChange({ ...node, value })} /></div>
      <div className="flex items-center gap-2">
        {not}
        {onRemove && <button type="button" agentId={`${path}-remove`} aria-label="Remove condition" className="tva-btn tva-btn-ghost tva-btn-icon h-8 w-8 text-muted" onClick={onRemove}><Icon name="trash" size={14} /></button>}
      </div>
    </div>
  )
}

const choicesOf = (f: Field): { value: string; label: string }[] | undefined =>
  f.type === 'category' ? [...BOT_CATEGORIES, { value: 'browser', label: 'Real browser' }, { value: 'unknown', label: 'Unknown' }]
    : f.type === 'country' ? COUNTRIES.map((c) => ({ value: c, label: c }))
    : f.choices?.map((c) => ({ value: c, label: c }))

function Value({ node, f, path, onChange }: { node: Cond; f: Field; path: string; onChange(v: unknown): void }) {
  const id = `${path}-value`
  const cls = 'tva-input h-8 text-[13px]'
  if (f.type === 'boolean') return (
    <select agentId={id} aria-label="Value" className={cls} value={String(node.value)} onChange={(e) => onChange(e.target.value === 'true')}>
      <option value="true">yes</option><option value="false">no</option>
    </select>
  )
  const choices = choicesOf(f)
  if (choices && isMulti(node.op)) return <MultiPick id={id} choices={choices} value={(node.value as string[]) ?? []} onChange={onChange} />
  if (choices) return (
    <select agentId={id} aria-label="Value" className={cls} value={String(node.value)} onChange={(e) => onChange(e.target.value)}>
      {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  )
  if (isMulti(node.op)) {
    const text = ((node.value as unknown[]) ?? []).join(', ')
    return <input agentId={id} aria-label="Values, comma separated" placeholder="comma, separated" className={cls} defaultValue={text} key={text}
      onBlur={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (f.type === 'number' ? Number(s) : s)))} />
  }
  if (f.type === 'number') return <input type="number" agentId={id} aria-label="Value" className={cls} value={Number(node.value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
  const v = String(node.value ?? '')
  const bad = f.type === 'ip' && v !== '' && !(node.op === 'cidr' ? CIDR_RE : IP_RE).test(v)
  return (
    <input agentId={id} aria-label="Value" aria-invalid={bad || undefined} className={cx(cls, (f.type === 'ip' || node.op === 'regex') && 'font-mono')} value={v}
      placeholder={node.op === 'cidr' ? '203.0.113.0/24' : f.type === 'ip' ? '203.0.113.7' : node.op === 'regex' ? '^/wp-(admin|login)' : ''}
      maxLength={node.op === 'regex' ? 200 : 500} title={bad ? (node.op === 'cidr' ? 'Expected a range like 203.0.113.0/24' : 'Expected an IP address') : undefined}
      onChange={(e) => onChange(e.target.value)} />
  )
}

// chips for the picked values + a select to add one (country multiselect, bot categories, network kinds)
export function MultiPick({ id, choices, value, onChange }: { id: string; choices: { value: string; label: string }[]; value: string[]; onChange(v: string[]): void }) {
  const left = choices.filter((c) => !value.includes(c.value))
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <button key={v} type="button" agentId={`${id}-drop-${v}`} className="tva-chip hover:opacity-80" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
          {choices.find((c) => c.value === v)?.label ?? v}<Icon name="x" size={11} />
        </button>
      ))}
      {left.length > 0 && (
        <select agentId={id} aria-label="Add value" className="tva-input h-7 w-auto min-w-24 text-xs" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">+ add…</option>
          {left.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
    </div>
  )
}
