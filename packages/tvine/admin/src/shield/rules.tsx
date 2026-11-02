'use client'
// Rules: ordered (first terminal match wins), drag or keyboard reorder (Weft SortableList: Space grabs, arrows move),
// enable toggles, hit counts; the editor = name + condition builder + action picker; reset to the built-in set.
import { useEffect, useState } from 'react'
import { Dialog, SortableList, Switch } from '../../../weft/dist/widgets/index.js'
import { useLiveData } from '../live.js'
import { Empty, ErrorBox, Icon, Region, Skeleton, cx } from '../ui.js'
import { ConditionBuilder } from './condition.js'
import { useShield, write } from './ctx.js'
import { RULE_FIELDS, describe } from './fields.js'
import type { Action, Rule } from './types.js'

const listOf = (d: unknown): Rule[] | undefined => (Array.isArray(d) ? d : (d as { rules?: Rule[] } | undefined)?.rules)
export const actionText = (a: Action): string =>
  a.type === 'challenge' ? `Challenge (${a.level}${a.ttl ? `, pass lasts ${a.ttl}` : ''})`
  : a.type === 'block' ? `Block ${a.status ?? 403}`
  : a.type === 'rateLimit' ? `Rate limit ${a.limit}/${a.window} per ${a.key}`
  : a.type === 'custom' ? `Custom: ${a.name}` : a.type === 'allow' ? 'Allow' : 'Log only'
const tone = (a: Action) => (a.type === 'block' || a.type === 'rateLimit' ? 'error' : a.type === 'challenge' ? 'warn' : a.type === 'log' || a.type === 'custom' ? 'info' : 'ok')

// move one id to a new index (SortableList onMove) — pure, tested
export function moveId(ids: string[], id: string, to: number): string[] {
  const o = ids.filter((x) => x !== id)
  o.splice(Math.max(0, Math.min(o.length, to)), 0, id)
  return o
}

export function Rules() {
  const { call, base, navigate } = useShield()
  const r = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const [rules, setRules] = useState<Rule[]>()
  const [reset, setReset] = useState(false)
  useEffect(() => { const l = listOf(r.data); if (l) setRules([...l].sort((a, b) => a.order - b.order)) }, [r.data])
  const onMove = async (id: string, to: number) => {
    const ids = moveId(rules!.map((x) => x.id), id, to)
    const prev = rules
    setRules(ids.map((x, i) => ({ ...rules!.find((y) => y.id === x)!, order: i })))
    if (!(await write(call, 'shield.rules.reorder', { ids }))) setRules(prev)
  }
  const toggle = async (rule: Rule, enabled: boolean) => {
    setRules((l) => l?.map((x) => (x.id === rule.id ? { ...x, enabled } : x)))
    if (!(await write(call, 'shield.rules.save', { rule: { ...rule, enabled } }, enabled ? `“${rule.name}” on` : `“${rule.name}” off`))) void r.reload()
  }
  return (
    <Region id="shield:rules" label="Rules" state={{ count: rules?.length ?? 0, order: rules?.map((x) => x.name).join(' > ').slice(0, 300) ?? '' }}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted">Checked top to bottom on every request. The first rule that matches decides. Drag to reorder, or focus a rule and press Space, then the arrow keys.</p>
        </div>
        <button type="button" agentId="reset" className="tva-btn" onClick={() => setReset(true)}><Icon name="refresh" size={14} />Reset to defaults</button>
        <a href={`${base}/rules/new/`} agentId="new" className="tva-btn tva-btn-primary" onClick={(e) => { e.preventDefault(); navigate(`${base}/rules/new/`) }}><Icon name="plus" size={14} />New rule</a>
      </div>
      {r.error && !rules && <ErrorBox error={r.error} />}
      {!rules ? <div className="tva-card"><Skeleton rows={6} /></div>
        : rules.length === 0 ? <div className="tva-card"><Empty title="No rules" icon="sliders">Every request passes (still scored and logged). Add a rule, or reset to the built-in set.</Empty></div>
        : (
          <SortableList name="rules" label="Rules, first match wins" items={rules} itemId={(x) => x.id} onMove={onMove} className="tvs-rules tva-card">
            {(rule) => (
              <div className={cx('tvs-rule', !rule.enabled && 'is-off')}>
                <Icon name="drag" className="tvs-grip text-muted" />
                <span className="tvs-order">{rule.order + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{rule.name}</p>
                  <p className="truncate text-xs text-muted" title={describe(rule.when)}>When {describe(rule.when)}</p>
                </div>
                <span className="tvs-decision hidden sm:inline-flex" data-t={tone(rule.then)}>{actionText(rule.then)}</span>
                <span className="w-20 text-right text-xs tabular-nums text-muted" title="Matches so far">{(rule.hits ?? 0).toLocaleString()} hits</span>
                <span className="flex items-center gap-1" onKeyDown={(e) => e.stopPropagation()}>
                  <Switch name={`enabled-${rule.id}`} label={`Enable ${rule.name}`} checked={rule.enabled} onCheckedChange={(v) => void toggle(rule, v)} className="tvs-switch" slots={{ label: { className: 'sr-only' } }} />
                  <a href={`${base}/rules/${rule.id}/`} agentId={`edit-${rule.id}`} className="tva-btn tva-btn-ghost h-8 px-2" onClick={(e) => { e.preventDefault(); navigate(`${base}/rules/${encodeURIComponent(rule.id)}/`) }}>Edit</a>
                </span>
              </div>
            )}
          </SortableList>
        )}
      <Dialog name="reset-rules" label="Reset rules" open={reset} onOpenChange={setReset} slots={{ trigger: { className: 'hidden' } }}>
        <h2 className="text-lg font-semibold">Reset rules to the defaults?</h2>
        <p className="mt-1 text-muted">Your rules are replaced by the built-in set: allow verified search engines and AI agents, challenge AI crawlers, block scanners and fake bots, challenge low scores, rate-limit 300/min per IP.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" agentId="cancel" className="tva-btn" onClick={() => setReset(false)}>Cancel</button>
          <button type="button" agentId="confirm" className="tva-btn tva-btn-danger-solid" onClick={async () => { setReset(false); const l = await write<Rule[]>(call, 'shield.rules.reset', {}, 'Rules reset'); if (l) void r.reload() }}>Reset</button>
        </div>
      </Dialog>
    </Region>
  )
}

const blank = (): Rule => ({ id: '', name: 'New rule', enabled: true, order: 0, when: { all: [{ field: 'path', op: 'startsWith', value: '/' }] }, then: { type: 'challenge', level: 'auto' } })

export function RuleEditor({ id }: { id: string }) {
  const { call, base, navigate } = useShield()
  const r = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const custom = useLiveData<string[]>(call, 'shield.customRules', {})
  const [draft, setDraft] = useState<Rule>()
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const isNew = id === 'new'
  useEffect(() => {
    if (draft) return
    if (isNew) return setDraft(blank())
    const found = listOf(r.data)?.find((x) => x.id === id)
    if (found) setDraft(structuredClone(found))
  }, [r.data])   // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => navigate(`${base}/rules/`)
  if (!draft) return r.data && !isNew ? <Empty title="Rule not found" icon="search">It may have been deleted.</Empty> : <div className="tva-card"><Skeleton rows={8} /></div>
  const save = async () => {
    setBusy(true)
    const { id: _id, hits: _h, ...rest } = draft
    const ok = await write(call, 'shield.rules.save', { rule: isNew ? rest : { ...rest, id: draft.id } }, 'Rule saved')
    setBusy(false)
    if (ok) back()
  }
  return (
    <Region id="shield:rule-editor" label={isNew ? 'New rule' : `Edit ${draft.name}`} state={{ rule: JSON.stringify({ when: draft.when, then: draft.then }).slice(0, 500) }}>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-[13px] text-muted">
        <a href={`${base}/rules/`} agentId="crumb-rules" className="hover:text-fg hover:underline" onClick={(e) => { e.preventDefault(); back() }}>Rules</a>
        <Icon name="chevron" size={12} /><span aria-current="page" className="text-fg">{isNew ? 'New rule' : draft.name}</span>
      </nav>
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="tva-card flex flex-wrap items-end gap-4 p-4">
            <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-[13px] font-medium">Name
              <input agentId="name" className="tva-input" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="flex h-9 items-center gap-2 text-[13px] font-medium">
              <input type="checkbox" agentId="enabled" className="tva-check" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Enabled
            </label>
          </section>
          <section className="tva-card p-4">
            <h2 className="mb-1 font-semibold">When</h2>
            <p className="mb-3 text-sm text-muted">The request must match these conditions. Now: <em>{describe(draft.when)}</em>.</p>
            <ConditionBuilder value={draft.when} fields={RULE_FIELDS} onChange={(when) => setDraft({ ...draft, when })} />
          </section>
        </div>
        <section className="tva-card h-fit p-4 xl:sticky xl:top-4">
          <h2 className="mb-3 font-semibold">Then</h2>
          <ActionPicker value={draft.then} onChange={(then) => setDraft({ ...draft, then })} custom={custom.data ?? []} />
          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            <button type="button" agentId="save" className="tva-btn tva-btn-primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save rule'}</button>
            <button type="button" agentId="cancel" className="tva-btn" onClick={back}>Cancel</button>
            <div className="flex-1" />
            {!isNew && <button type="button" agentId="delete" className="tva-btn tva-btn-danger" onClick={() => setDel(true)}><Icon name="trash" size={14} />Delete</button>}
          </div>
        </section>
      </div>
      <Dialog name="delete-rule" label="Delete rule" open={del} onOpenChange={setDel} slots={{ trigger: { className: 'hidden' } }}>
        <h2 className="text-lg font-semibold">Delete “{draft.name}”?</h2>
        <p className="mt-1 text-muted">Requests it used to match fall through to the next rules.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" agentId="cancel" className="tva-btn" onClick={() => setDel(false)}>Cancel</button>
          <button type="button" agentId="confirm" className="tva-btn tva-btn-danger-solid" onClick={async () => { setDel(false); if (await write(call, 'shield.rules.delete', { id: draft.id }, 'Rule deleted')) back() }}>Delete</button>
        </div>
      </Dialog>
    </Region>
  )
}

const ACTIONS: { type: Action['type']; label: string; help: string }[] = [
  { type: 'allow', label: 'Allow', help: 'Let it through. No later rule runs.' },
  { type: 'log', label: 'Log', help: 'Record it and keep checking the next rules.' },
  { type: 'challenge', label: 'Challenge', help: 'Ask the browser to prove it is human. Real people pass once and keep a pass for a while. Agents on /mcp and the API get a JSON 403 instead.' },
  { type: 'block', label: 'Block', help: 'Refuse with an error page (JSON on agent paths).' },
  { type: 'rateLimit', label: 'Rate limit', help: 'Allow up to N requests per time window, then answer 429.' },
  { type: 'custom', label: 'Custom', help: 'Run a rule your app registered in code with shield.registerRule(name, fn).' },
]
export function defaultAction(type: Action['type'], custom: string[] = []): Action {
  switch (type) {
    case 'challenge': return { type, level: 'auto', ttl: '30m' }
    case 'block': return { type, status: 403 }
    case 'rateLimit': return { type, limit: 300, window: '1m', key: 'ip' }
    case 'custom': return { type, name: custom[0] ?? '' }
    default: return { type }
  }
}
export function ActionPicker({ value, onChange, custom }: { value: Action; onChange(a: Action): void; custom: string[] }) {
  const cls = 'tva-input h-9'
  const lab = 'flex flex-col gap-1.5 text-[13px] font-medium'
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Action" className="grid grid-cols-3 gap-1.5">
        {ACTIONS.map((a) => (
          <button key={a.type} type="button" role="radio" agentId={`action-${a.type}`} aria-checked={value.type === a.type} className="tvs-action" data-t={tone(defaultAction(a.type))}
            onClick={() => value.type !== a.type && onChange(defaultAction(a.type, custom))}>{a.label}</button>
        ))}
      </div>
      <p className="text-sm text-muted">{ACTIONS.find((a) => a.type === value.type)?.help}</p>
      {value.type === 'challenge' && (
        <div className="grid grid-cols-2 gap-3">
          <label className={lab}>Level
            <select agentId="level" className={cls} value={value.level} onChange={(e) => onChange({ ...value, level: e.target.value as typeof value.level })}>
              <option value="auto">Auto (by score)</option><option value="pow">Invisible puzzle</option><option value="checkbox">Checkbox</option><option value="captcha">Image puzzle</option>
            </select>
          </label>
          <label className={lab}>Pass lasts
            <input agentId="ttl" className={cls} value={value.ttl ?? ''} placeholder="30m" pattern="\d+[smhd]" onChange={(e) => onChange({ ...value, ttl: e.target.value || undefined })} />
          </label>
        </div>
      )}
      {value.type === 'block' && (
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <label className={lab}>Status
            <select agentId="status" className={cls} value={value.status ?? 403} onChange={(e) => onChange({ ...value, status: Number(e.target.value) as 403 })}>
              {[403, 404, 429, 451].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className={lab}>Message (optional)
            <input agentId="message" className={cls} value={value.message ?? ''} maxLength={200} placeholder="Access denied" onChange={(e) => onChange({ ...value, message: e.target.value || undefined })} />
          </label>
        </div>
      )}
      {value.type === 'rateLimit' && (
        <div className="grid grid-cols-3 gap-3">
          <label className={lab}>Limit<input type="number" min={1} agentId="limit" className={cls} value={value.limit} onChange={(e) => onChange({ ...value, limit: Math.max(1, Number(e.target.value) || 1) })} /></label>
          <label className={lab}>Per<input agentId="window" className={cls} value={value.window} pattern="\d+[smhd]" onChange={(e) => onChange({ ...value, window: e.target.value })} /></label>
          <label className={lab}>Counted by
            <select agentId="key" className={cls} value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value as typeof value.key })}>
              <option value="ip">IP</option><option value="asn">Network</option><option value="path">Path</option><option value="ip+path">IP + path</option>
            </select>
          </label>
        </div>
      )}
      {value.type === 'custom' && (custom.length ? (
        <label className={lab}>Rule
          <select agentId="custom" className={cls} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })}>{custom.map((n) => <option key={n}>{n}</option>)}</select>
        </label>
      ) : <p className="rounded-md bg-sunken p-3 text-sm text-muted">No custom rules registered. Add one in app code: <code className="tva-kbd">shield.registerRule('name', fn)</code>.</p>)}
    </div>
  )
}
