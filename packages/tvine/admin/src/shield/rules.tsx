'use client'
// Rules: ordered (first terminal match wins), drag or keyboard reorder (Weft SortableList: Space grabs, arrows move),
// enable toggles, hit counts; the editor = name + condition builder + action picker; reset to the built-in set.
import { useEffect, useState } from 'react'
import { Sparkline } from '../charts.js'
import { Dialog, SortableList, Switch } from '../../../weft/dist/widgets/index.js'
import { useLiveData } from '../live.js'
import { Empty, ErrorBox, Icon, Region, Skeleton, cx } from '../ui.js'
import { CodePanel } from './code.js'
import { ConditionBuilder } from './condition.js'
import { useShield, write } from './ctx.js'
import { RULE_FIELDS, describe } from './fields.js'
import { Ago, num } from './kit.js'
import { DecisionBadge } from './overview.js'
import type { Action, Cond, Condition, Rule, RulePreview } from './types.js'

const listOf = (d: unknown): Rule[] | undefined => (Array.isArray(d) ? d : (d as { rules?: Rule[] } | undefined)?.rules)
export const actionText = (a: Action): string =>
  a.type === 'challenge' ? `Challenge (${a.level}${a.ttl ? `, pass lasts ${a.ttl}` : ''})`
  : a.type === 'block' ? `Block ${a.status ?? 403}`
  : a.type === 'rateLimit' ? `Rate limit ${a.limit}/${a.window} per ${a.key}`
  : a.type === 'custom' ? `Custom: ${a.name}` : a.type === 'code' ? 'Code' : a.type === 'allow' ? 'Allow' : 'Log only'
export const tone = (a: Action) => (a.type === 'block' || a.type === 'rateLimit' ? 'error' : a.type === 'challenge' ? 'warn' : a.type === 'log' || a.type === 'custom' || a.type === 'code' ? 'info' : 'ok')

// a compact one-line expression: "country eq CN and score < 30 → Challenge (pow)"
const SYM: Record<string, string> = { eq: 'eq', neq: 'ne', lt: '<', gt: '>', in: 'in', notIn: 'not in', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', regex: 'matches', cidr: 'in' }
export function expr(c: Condition): string {
  if ('not' in c) return `not (${expr(c.not)})`
  if ('all' in c || 'any' in c) {
    const k = 'all' in c ? c.all : c.any
    if (!k.length) return 'every request'
    return k.map((x) => ('all' in x || 'any' in x) && ('all' in x ? x.all : x.any).length > 1 ? `(${expr(x)})` : expr(x)).join('all' in c ? ' and ' : ' or ')
  }
  const l = c as Cond
  const v = Array.isArray(l.value) ? `{${l.value.join(' ')}}` : typeof l.value === 'string' ? (/\s/.test(l.value) || l.value === '' ? JSON.stringify(l.value) : l.value) : String(l.value)
  return `${l.field} ${SYM[l.op] ?? l.op} ${v}`
}
const actionShort = (a: Action) => (a.type === 'challenge' ? `Challenge (${a.level})` : a.type === 'block' ? `Block ${a.status ?? 403}` : a.type === 'rateLimit' ? `Rate limit ${a.limit}/${a.window}` : a.type === 'custom' ? `Custom ${a.name}` : a.type === 'code' ? 'Code' : a.type === 'allow' ? 'Allow' : 'Log')

// move one id to a new index (SortableList onMove) — pure, tested
export function moveId(ids: string[], id: string, to: number): string[] {
  const o = ids.filter((x) => x !== id)
  o.splice(Math.max(0, Math.min(o.length, to)), 0, id)
  return o
}

export function Rules() {
  const { call, base, navigate, settings } = useShield()
  const r = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const [rules, setRules] = useState<Rule[]>()
  const [reset, setReset] = useState(false)
  const [errOpen, setErrOpen] = useState<string>()
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
    <Region id="shield:rules" label="Rules" state={{ count: rules?.length ?? 0, order: rules?.map((x) => `${x.name}${x.enabled ? '' : ' (off)'}: ${x.hits24h ?? 0}/24h`).join(' > ').slice(0, 400) ?? '' }}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted">Checked top to bottom on every request. The first rule that matches decides. Drag to reorder, or focus a rule and press Space, then the arrow keys.</p>
        </div>
        <button type="button" agentId="reset" className="tva-btn" onClick={() => setReset(true)}><Icon name="refresh" size={14} />Reset to defaults</button>
        <a href={`${base}/rules/new/`} agentId="new" className="tva-btn tva-btn-primary" onClick={(e) => { e.preventDefault(); navigate(`${base}/rules/new/`) }}><Icon name="plus" size={14} />New rule</a>
      </div>
      {settings?.rateOverlap && (
        <Region id="shield:rate-overlap" label="Two rate limits" state={{ warning: settings.rateOverlap }} className="tvs-warn mb-4 rounded-lg border p-3 text-sm" role="alert">
          <p className="font-semibold">Two rate limits are on</p>
          <p className="mt-1 text-muted">{settings.rateOverlap}</p>
        </Region>
      )}
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
                  <p className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{rule.name}</span>{rule.then.type === 'code' && <CodeBadges rule={rule} open={errOpen === rule.id} onToggle={() => setErrOpen(errOpen === rule.id ? undefined : rule.id)} />}</p>
                  <p className="tvs-expr truncate" title={describe(rule.when)}>{expr(rule.when)} <span className="text-muted">→</span> <span data-t={tone(rule.then)}>{actionShort(rule.then)}</span></p>
                  {errOpen === rule.id && <CodeError rule={rule} />}
                </div>
                <span className="tvs-decision hidden md:inline-flex" data-t={tone(rule.then)}>{actionText(rule.then)}</span>
                <span className="hidden w-24 sm:block">{rule.spark && rule.spark.length > 1 && <Sparkline values={rule.spark} width={96} height={24} label={`${rule.name}, last 24h`} />}</span>
                <span className="w-20 text-right text-xs tabular-nums" title={`${(rule.hits ?? 0).toLocaleString()} matches in total`}><strong className="text-fg">{num(rule.hits24h ?? 0)}</strong><span className="block text-muted">24h hits</span></span>
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

// empty until edited: the server refuses saving a challenge / block that matches every request
const blank = (): Rule => ({ id: '', name: 'New rule', enabled: true, order: 0, when: { all: [{ field: 'path', op: 'startsWith', value: '' }] }, then: { type: 'challenge', level: 'auto' } })

// /rules/new/?when=<json>&name=… (Events → "Create rule from this")
function prefill(q: Record<string, string>): Rule {
  const r = blank()
  try { if (q.when) r.when = JSON.parse(q.when) as Condition } catch { /* keep the blank */ }
  if (q.name) r.name = q.name.slice(0, 120)
  if (q.action === 'code') r.then = { type: 'code', source: '' }
  return r
}

export function RuleEditor({ id }: { id: string }) {
  const { call, base, navigate, query } = useShield()
  const r = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const custom = useLiveData<string[]>(call, 'shield.customRules', {})
  const [full, setFull] = useState(false)   // the code editor as a full-screen dialog (opens when Code is picked)
  const [draft, setDraft] = useState<Rule>()
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [codeErrors, setCodeErrors] = useState(0)
  const isNew = id === 'new'
  useEffect(() => {
    if (draft) return
    if (isNew) return setDraft(prefill(query))
    const found = listOf(r.data)?.find((x) => x.id === id)
    if (found) setDraft(structuredClone(found))
  }, [r.data])   // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => navigate(`${base}/rules/`)
  if (!draft) return r.data && !isNew ? <Empty title="Rule not found" icon="search">It may have been deleted.</Empty> : <div className="tva-card"><Skeleton rows={8} /></div>
  const code = draft.then.type === 'code' ? draft.then : undefined
  const blocked = code && (codeErrors > 0 ? `Fix ${codeErrors === 1 ? 'the code problem' : `${codeErrors} code problems`} to save.` : !code.source.trim() ? 'Write some code to save.' : '')
  const save = async () => {
    setBusy(true)
    const { id: _id, hits: _h, hits24h: _h24, spark: _s, ...rest } = draft
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
          <Preview when={draft.when} then={code} />
        </div>
        <section className="tva-card h-fit p-4 xl:sticky xl:top-4">
          <h2 className="mb-3 font-semibold">Then</h2>
          <ActionPicker value={draft.then} onChange={(then) => { setCodeErrors(0); setDraft({ ...draft, then }) }} custom={custom.data ?? []} onOpenEditor={() => setFull(true)} />
          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            <button type="button" agentId="save" className="tva-btn tva-btn-primary" disabled={busy || !draft.name.trim() || !!blocked} aria-describedby={blocked ? 'save-why' : undefined} onClick={() => void save()}>{busy ? 'Saving…' : 'Save rule'}</button>
            <button type="button" agentId="cancel" className="tva-btn" onClick={back}>Cancel</button>
            <div className="flex-1" />
            {!isNew && <button type="button" agentId="delete" className="tva-btn tva-btn-danger" onClick={() => setDel(true)}><Icon name="trash" size={14} />Delete</button>}
          </div>
          {blocked && <p id="save-why" className="mt-2 text-[13px] text-danger" role="status">{blocked}</p>}
        </section>
        {code && <div className="min-w-0 xl:col-span-2 xl:row-start-2"><CodePanel value={code} onChange={(then) => setDraft({ ...draft, then })} onErrors={setCodeErrors} ray={query.ray} full={full} onFull={setFull} /></div>}
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
  { type: 'code', label: 'Code', help: 'Write JavaScript that looks at the request and returns an action. It opens in the editor, is checked as you type and runs in a sandbox. A broken rule is skipped: it never blocks traffic.' },
]
export function defaultAction(type: Action['type'], custom: string[] = []): Action {
  switch (type) {
    case 'challenge': return { type, level: 'auto', ttl: '30m' }
    case 'block': return { type, status: 403 }
    case 'rateLimit': return { type, limit: 300, window: '1m', key: 'ip' }
    case 'custom': return { type, name: custom[0] ?? '' }
    case 'code': return { type, source: '' }
    default: return { type }
  }
}
export function ActionPicker({ value, onChange, custom, onOpenEditor }: { value: Action; onChange(a: Action): void; custom: string[]; onOpenEditor?(): void }) {
  const cls = 'tva-input h-9'
  const lab = 'flex flex-col gap-1.5 text-[13px] font-medium'
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Action" className="grid grid-cols-3 gap-1.5">
        {ACTIONS.map((a) => (
          <button key={a.type} type="button" role="radio" agentId={`action-${a.type}`} aria-checked={value.type === a.type || (a.type === 'code' && value.type === 'custom')} className={cx('tvs-action', a.type === 'code' && 'inline-flex items-center justify-center gap-1.5')} data-t={tone(defaultAction(a.type))}
            onClick={() => { if (a.type === 'code' && value.type !== 'code') { onChange(defaultAction('code')); onOpenEditor?.() } else if (value.type !== a.type) onChange(defaultAction(a.type, custom)) }}>{a.type === 'code' && <Icon name="code" size={14} />}{a.label}</button>
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
      {value.type === 'code' && <button type="button" agentId="open-editor" className="tva-btn tva-btn-primary h-9 w-full" onClick={() => onOpenEditor?.()}><Icon name="code" size={14} />Open code editor</button>}
      {value.type === 'custom' && <button type="button" agentId="write-code" className="tva-btn h-9 w-full" onClick={() => { onChange(defaultAction('code')); onOpenEditor?.() }}><Icon name="code" size={14} />Write code here instead</button>}
      {(value.type === 'code' || value.type === 'custom') && custom.length > 0 && (
        <label className={lab}>Or run a rule from your app code
          <select agentId="custom" className={cls} value={value.type === 'custom' ? value.name : ''} onChange={(e) => onChange(e.target.value ? { type: 'custom', name: e.target.value } : defaultAction('code'))}>
            <option value="">— write code here —</option>{custom.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

// live match preview: what this condition would have matched over the last 24h (debounced)
export const PREVIEW_DEBOUNCE_MS = 400
function Preview({ when, then }: { when: Condition; then?: Action }) {
  const { call, base, navigate } = useShield()
  const [res, setRes] = useState<{ data?: RulePreview; error?: string; busy: boolean }>({ busy: true })
  const key = JSON.stringify([when, then])
  useEffect(() => {
    let live = true
    setRes((r) => ({ ...r, busy: true }))
    const t = setTimeout(async () => {
      const r = await call('shield.rules.preview', then ? { when, then, sinceHours: 24 } : { when, sinceHours: 24 })
      if (live) setRes(r.ok ? { data: r.data as RulePreview, busy: false } : { error: r.message, busy: false })
    }, PREVIEW_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(t) }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  const d = res.data
  return (
    <Region id="rule:preview" label="Match preview" state={{ matched: d?.matched ?? null, scanned: d?.scanned ?? null, busy: res.busy }} className="tva-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Match preview</h2>
          <p className="text-sm text-muted" role="status">
            {res.error ? <span className="text-danger">{res.error}</span>
              : !d ? 'Checking the last 24 hours…'
              : then ? <>The code would have decided <strong className="text-fg tabular-nums">{d.matched.toLocaleString()}</strong> of <span className="tabular-nums">{d.scanned.toLocaleString()}</span> stored requests in the last 24h{d.scanned ? ` (${Math.round((d.matched / d.scanned) * 1000) / 10}%)` : ''}.</>
              : <>Would have matched <strong className="text-fg tabular-nums">{d.matched.toLocaleString()}</strong> of <span className="tabular-nums">{d.scanned.toLocaleString()}</span> stored requests in the last 24h{d.scanned ? ` (${Math.round((d.matched / d.scanned) * 1000) / 10}%)` : ''}.</>}
          </p>
        </div>
        {res.busy && d && <span className="text-xs text-muted">Updating…</span>}
      </div>
      {d && d.scanned > 0 && <div className="tvs-bar mx-4 mb-3 w-auto"><span style={{ width: `${Math.min(100, (d.matched / d.scanned) * 100)}%`, background: 'var(--tva-brand)' }} /></div>}
      {d && d.sample.length > 0 && (
        <div className={cx('overflow-x-auto border-t border-line transition-opacity', res.busy && 'opacity-60')}>
          <table className="w-full text-[13px]">
            <thead><tr><th className="tva-th">Time</th><th className="tva-th">IP</th><th className="tva-th">Request</th><th className="tva-th">Now</th></tr></thead>
            <tbody>{d.sample.slice(0, 8).map((r) => (
              <tr key={r.ray} className="tva-row cursor-pointer" onClick={() => navigate(`${base}/events/?ray=${encodeURIComponent(r.ray)}`)}>
                <td className="tva-td whitespace-nowrap text-muted"><Ago ts={r.ts} /></td><td className="tva-td font-mono text-xs">{r.ip ?? '—'}</td>
                <td className="tva-td max-w-[18rem] truncate font-mono text-xs">{r.method ?? 'GET'} {r.path}</td><td className="tva-td"><DecisionBadge d={r.decision} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Region>
  )
}

// code rule health in the rules list: errors in the last hour (click: the last one, under the row) and the paused state
function CodeBadges({ rule, open, onToggle }: { rule: Rule; open: boolean; onToggle(): void }) {
  const c = rule.code
  const n = c?.errors1h ?? 0
  return (
    <span className="inline-flex shrink-0 items-center gap-1" onKeyDown={(e) => e.stopPropagation()}>
      <span className="tvs-badge" title="Code rule"><Icon name="code" size={11} />code</span>
      {c?.paused && <span className="tvs-badge" data-t="warn" title="Paused after repeated errors. It is skipped, so requests go on to the next rules.">paused</span>}
      {n > 0 && (
        <button type="button" agentId={`code-errors-${rule.id}`} className="tvs-badge" data-t="error" aria-expanded={open} title={c?.lastError ? `${c.lastError.kind}: ${c.lastError.message}` : undefined} onClick={(e) => { e.stopPropagation(); onToggle() }}>
          {num(n)} {n === 1 ? 'error' : 'errors'} / 1h
        </button>
      )}
    </span>
  )
}
function CodeError({ rule }: { rule: Rule }) {
  const e = rule.code?.lastError
  return (
    <Region id={`code-error:${rule.id}`} label="Last code error" state={{ kind: e?.kind ?? null, message: e?.message ?? null, at: e?.at ?? null }} className="tvs-run mt-2 text-[13px] font-normal">
      {e ? <p className="flex flex-wrap items-center gap-2"><span className="tvs-decision" data-t="error">{e.kind}</span><span className="break-all font-mono text-xs">{e.message}</span><span className="text-xs text-muted"><Ago ts={e.at} /></span></p>
        : <p className="text-xs">No details kept.</p>}
      <p className="mt-1 text-xs text-muted">A failing code rule is skipped: the request goes on to the next rules and is never blocked by the error.{rule.code?.paused ? ' This rule is paused after repeated errors.' : ''}</p>
    </Region>
  )
}
