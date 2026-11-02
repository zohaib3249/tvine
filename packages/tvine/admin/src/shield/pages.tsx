'use client'
// Bots & AI, Lists, Events, Test a request, Settings, and the 403 page.
import { useState, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '../../../weft/dist/widgets/index.js'
import type { Call } from '../data.js'
import { useLiveData } from '../live.js'
import type { User } from '../types.js'
import { Empty, ErrorBox, Icon, PlainForm, Region, Skeleton, cx } from '../ui.js'
import { ShieldMark, MODE_TEXT } from './app.js'
import { ConditionBuilder } from './condition.js'
import { useShield, write } from './ctx.js'
import { BOT_CATEGORIES, CIDR_RE, IP_RE, describe, userFields } from './fields.js'
import { DECISION_LABEL } from './overview.js'
import { actionText } from './rules.js'
import type { BotCategory, Bots as BotsData, ChallengeLevel, IpdbStatus, ListEntry, Mode, Rule, ShieldSettings, Signals, Stance, TestResult } from './types.js'

const H = ({ title, sub, children }: { title: string; sub: ReactNode; children?: ReactNode }) => (
  <div className="mb-5 flex flex-wrap items-center gap-3">
    <div className="min-w-0 flex-1 basis-72"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="text-sm text-muted">{sub}</p></div>
    {children}
  </div>
)
const label = 'flex flex-col gap-1.5 text-[13px] font-medium'

// ---- Bots & AI ------------------------------------------------------------------------------------------------------
const STANCES: Stance[] = ['allow', 'challenge', 'block']
export function Bots() {
  const { call } = useShield()
  const b = useLiveData<BotsData>(call, 'shield.bots', {})
  const [over, setOver] = useState<Partial<Record<BotCategory, Stance>>>({})
  const stance = (c: BotCategory) => over[c] ?? b.data?.stances[c] ?? 'allow'
  const set = async (category: BotCategory, s: Stance) => {
    setOver((o) => ({ ...o, [category]: s }))
    if (!(await write(call, 'shield.bots.set', { category, stance: s }, `${BOT_CATEGORIES.find((x) => x.value === category)?.label}: ${s}`))) setOver((o) => ({ ...o, [category]: undefined }))
  }
  const verified = b.data?.catalog.filter((x) => x.verified) ?? []
  return (
    <Region id="shield:bots" label="Bots and AI" state={Object.fromEntries(BOT_CATEGORIES.map((c) => [c.value, stance(c.value)]))}>
      <H title="Bots & AI" sub="Decide what each kind of bot may do. Verified bots are checked by DNS, published IP ranges or signatures, so fakes are caught and blocked." />
      {b.error && !b.data && <ErrorBox error={b.error} />}
      <div className="grid gap-3 md:grid-cols-2">
        {BOT_CATEGORIES.map((c) => (
          <Region key={c.value} id={`category:${c.value}`} label={c.label} state={{ stance: stance(c.value) }} className="tva-card flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1"><h2 className="font-semibold">{c.label}</h2><p className="text-sm text-muted">{c.help}</p></div>
            </div>
            <div className="tvs-stance" role="radiogroup" aria-label={`${c.label} stance`}>
              {STANCES.map((s) => (
                <button key={s} type="button" role="radio" agentId={`${c.value}-${s}`} aria-checked={stance(c.value) === s} data-s={s} disabled={!b.data} onClick={() => stance(c.value) !== s && void set(c.value, s)}>{s}</button>
              ))}
            </div>
          </Region>
        ))}
      </div>
      <Region id="shield:verified" label="Verified bots" state={{ count: verified.length }} className="tva-card mt-4 overflow-hidden">
        <h2 className="px-4 pt-4 pb-2 font-semibold">Verified bots</h2>
        <p className="px-4 pb-3 text-sm text-muted">Bots Shield can prove are who they say. A request that only claims to be one of these is marked as spoofed.</p>
        {!b.data ? <Skeleton rows={4} /> : verified.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">None yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]">
            <thead><tr><th className="tva-th">Bot</th><th className="tva-th">Category</th><th className="tva-th">Verified by</th><th className="tva-th text-right">Hits</th></tr></thead>
            <tbody>{verified.map((v) => <tr key={v.name} className="tva-row"><td className="tva-td font-medium">{v.name}</td><td className="tva-td">{BOT_CATEGORIES.find((c) => c.value === v.category)?.label ?? v.category}</td><td className="tva-td text-muted">{v.via ?? '—'}</td><td className="tva-td text-right">{(v.hits ?? 0).toLocaleString()}</td></tr>)}</tbody>
          </table></div>
        )}
      </Region>
    </Region>
  )
}

// ---- Lists ----------------------------------------------------------------------------------------------------------
const KINDS: ListEntry['kind'][] = ['ip', 'cidr', 'country', 'asn']
const KIND_LABEL = { ip: 'IP', cidr: 'IP range', country: 'Country', asn: 'ASN' }
// one pasted line → an entry kind (or undefined = not understood)
export function kindOf(v: string): ListEntry['kind'] | undefined {
  if (CIDR_RE.test(v)) return 'cidr'
  if (IP_RE.test(v)) return 'ip'
  if (/^[A-Z]{2}$/i.test(v)) return 'country'
  if (/^(AS)?\d{1,10}$/i.test(v)) return 'asn'
  return undefined
}
export function parsePaste(text: string, list: ListEntry['list']): { entries: Omit<ListEntry, 'id'>[]; bad: string[] } {
  const entries: Omit<ListEntry, 'id'>[] = [], bad: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const [v = '', ...note] = raw.trim().split(/\s+#\s*|\s+/)
    if (!v || v.startsWith('#')) continue
    const kind = kindOf(v)
    if (!kind) { bad.push(v); continue }
    entries.push({ kind, list, value: kind === 'country' ? v.toUpperCase() : kind === 'asn' ? v.replace(/^AS/i, '') : v, ...(note.length && { note: note.join(' ') }) })
  }
  return { entries, bad }
}
export function Lists() {
  const { call } = useShield()
  const l = useLiveData<ListEntry[]>(call, 'shield.lists.list', {})
  const [tab, setTab] = useState<'all' | ListEntry['kind']>('all')
  const [form, setForm] = useState<Omit<ListEntry, 'id'>>({ kind: 'ip', value: '', list: 'deny', note: '' })
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState(''), [pasteList, setPasteList] = useState<ListEntry['list']>('deny')
  const rows = (l.data ?? []).filter((e) => tab === 'all' || e.kind === tab)
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await write(call, 'shield.lists.save', { entries: [{ ...form, value: form.value.trim(), note: form.note || undefined }] }, 'Added')) { setForm({ ...form, value: '', note: '' }); void l.reload() }
  }
  const p = parsePaste(text, pasteList)
  const bad = form.value !== '' && kindOf(form.value.trim()) !== form.kind
  return (
    <Region id="shield:lists" label="Lists" state={{ count: l.data?.length ?? 0, tab }}>
      <H title="Lists" sub="Always allow or always deny by IP, IP range, country or network. Lists are checked before rules.">
        <button type="button" agentId="import" className="tva-btn" onClick={() => setPaste(true)}><Icon name="download" size={14} />Import from paste</button>
      </H>
      <PlainForm onSubmit={add} className="tva-card mb-4 grid gap-3 p-4 sm:grid-cols-[8rem_1fr_7rem_1fr_auto] sm:items-end">
        <label className={label}>Type<select agentId="kind" className="tva-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ListEntry['kind'] })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
        <label className={label}>Value<input agentId="value" required aria-invalid={bad || undefined} className="tva-input font-mono" value={form.value} placeholder={{ ip: '203.0.113.7', cidr: '203.0.113.0/24', country: 'XX', asn: '64500' }[form.kind]} onChange={(e) => setForm({ ...form, value: e.target.value })} /></label>
        <label className={label}>List<select agentId="list" className="tva-input" value={form.list} onChange={(e) => setForm({ ...form, list: e.target.value as ListEntry['list'] })}><option value="deny">Deny</option><option value="allow">Allow</option></select></label>
        <label className={label}>Note<input agentId="note" className="tva-input" value={form.note ?? ''} maxLength={200} placeholder="Why (optional)" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <button type="submit" agentId="add" className="tva-btn tva-btn-primary" disabled={bad || !form.value.trim()}><Icon name="plus" size={14} />Add</button>
      </PlainForm>
      <div className="tva-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="tva-seg" role="group" aria-label="Filter by type">
            {(['all', ...KINDS] as const).map((k) => <button key={k} type="button" agentId={`tab-${k}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{k === 'all' ? 'All' : KIND_LABEL[k]}</button>)}
          </div>
        </div>
        {!l.data ? <Skeleton rows={5} /> : rows.length === 0 ? <Empty title="Nothing listed" icon="logs">Add an entry above, or import many at once from a paste.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full text-[13px]">
            <thead><tr><th className="tva-th">Value</th><th className="tva-th">Type</th><th className="tva-th">List</th><th className="tva-th">Note</th><th className="tva-th" /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id} className="tva-row">
                <td className="tva-td font-mono">{e.kind === 'asn' ? `AS${e.value}` : e.value}</td><td className="tva-td">{KIND_LABEL[e.kind]}</td>
                <td className="tva-td"><span className="tvs-decision" data-t={e.list === 'allow' ? 'ok' : 'error'}>{e.list}</span></td>
                <td className="tva-td text-muted">{e.note ?? ''}</td>
                <td className="tva-td text-right"><button type="button" agentId={`remove-${e.id}`} aria-label={`Remove ${e.value}`} className="tva-btn tva-btn-ghost tva-btn-icon h-8 w-8 text-muted" onClick={async () => { if (await write(call, 'shield.lists.delete', { id: e.id }, 'Removed')) void l.reload() }}><Icon name="trash" size={14} /></button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <Dialog name="import" label="Import from paste" open={paste} onOpenChange={setPaste} slots={{ trigger: { className: 'hidden' } }}>
        <h2 className="text-lg font-semibold">Import from paste</h2>
        <p className="mt-1 text-sm text-muted">One per line: an IP, a range (203.0.113.0/24), a 2-letter country or an ASN (AS64500). Anything after a space is the note.</p>
        <textarea agentId="paste" className="tva-input mt-3 h-40 font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={'203.0.113.7 scraper\n198.51.100.0/24\nXX\nAS64500 bulletproof host'} />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <select agentId="paste-list" aria-label="List" className="tva-input h-9 w-28" value={pasteList} onChange={(e) => setPasteList(e.target.value as ListEntry['list'])}><option value="deny">Deny</option><option value="allow">Allow</option></select>
          <span className="text-muted">{p.entries.length} ready{p.bad.length ? `, ${p.bad.length} not understood: ${p.bad.slice(0, 3).join(', ')}` : ''}</span>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" agentId="cancel" className="tva-btn" onClick={() => setPaste(false)}>Cancel</button>
          <button type="button" agentId="confirm" className="tva-btn tva-btn-primary" disabled={!p.entries.length} onClick={async () => { if (await write(call, 'shield.lists.save', { entries: p.entries }, `Imported ${p.entries.length}`)) { setPaste(false); setText(''); void l.reload() } }}>Import {p.entries.length || ''}</button>
        </div>
      </Dialog>
    </Region>
  )
}

export const Score = ({ n }: { n: number }) => <span className="tvs-score" data-t={n < 30 ? 'error' : n < 60 ? 'warn' : 'ok'}>{n}</span>
// every signal, grouped, as label/value pairs
export function SignalGrid({ s }: { s: Signals }) {
  const yes = (b?: boolean) => (b ? 'yes' : 'no')
  const groups: [string, [string, ReactNode][]][] = [
    ['Network', [['IP', s.ip], ['Network /24', s.ipNet], ['Country', s.country ?? '—'], ['ASN', s.asn ? `AS${s.asn}${s.asnOrg ? ` · ${s.asnOrg}` : ''}` : '—'], ['Network kind', s.asnKind ?? '—'], ['Tor exit', yes(s.tor)],
      ['Rate (1 min)', `ip ${s.rate.ip} · asn ${s.rate.asn} · path ${s.rate.path}`]]],
    ['Identity', [['User agent', s.ua || '—'], ['Browser family', s.uaFamily ?? '—'], ['Bot', s.bot.name ? `${s.bot.name} (${s.bot.category})` : s.bot.category], ['Verified', s.bot.verified ? `yes, via ${s.bot.via ?? '?'}` : 'no'], ['Spoofed', yes(s.bot.spoofed)]]],
    ['Consistency', [['Header score', `${Math.round(s.headerScore * 100)}%`], ['TLS JA4', s.tls?.ja4 ?? 'not available'], ['Clearance', s.clearance ? `${s.clearance.valid ? 'valid' : `invalid (${s.clearance.reason})`} · ${s.clearance.level}` : 'none']]],
    ['Request', [['Method', s.method], ['Host', s.host], ['Path', s.path], ['Score', <Score key="s" n={s.score} />]]],
  ]
  if (s.sensor) groups.push(['Browser sensor', [['webdriver', yes(s.sensor.webdriver)], ['Headless markers', s.sensor.headless.join(', ') || 'none'], ['Screen', s.sensor.screen], ['Time zone', s.sensor.tz], ['Pointer moves', String(s.sensor.behaviour.moves)]]])
  return (
    <div className="grid gap-3">
      {groups.map(([g, rows]) => (
        <div key={g}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g}</h3>
          <dl className="tvs-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </div>
      ))}
    </div>
  )
}

// ---- Test a request -------------------------------------------------------------------------------------------------
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const UA_PRESETS: Record<string, { ua: string; headers?: string }> = {
  Chrome: { ua: CHROME, headers: 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\naccept-language: en-US,en;q=0.9\nsec-ch-ua: "Chromium";v="131", "Google Chrome";v="131"\nsec-ch-ua-mobile: ?0\nsec-ch-ua-platform: "macOS"\nsec-fetch-dest: document\nsec-fetch-mode: navigate\nsec-fetch-site: none' },
  Googlebot: { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', headers: 'accept: text/html,application/xhtml+xml\naccept-encoding: gzip, deflate, br' },
  GPTBot: { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', headers: 'accept: */*' },
  'Claude-User': { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)', headers: 'accept: text/html' },
  curl: { ua: 'curl/8.7.1', headers: 'accept: */*' },
  HeadlessChrome: { ua: CHROME.replace('Chrome/', 'HeadlessChrome/'), headers: 'accept: text/html,application/xhtml+xml\nsec-fetch-mode: navigate' },
}
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim() }
  return out
}
const headersFor = (preset: string) => `user-agent: ${UA_PRESETS[preset]!.ua}\n${UA_PRESETS[preset]!.headers ?? ''}`.trim()

export function TestRequest() {
  const { call } = useShield()
  const rules = useLiveData<Rule[] | { rules: Rule[] }>(call, 'shield.rules.list', {})
  const ruleList = Array.isArray(rules.data) ? rules.data : rules.data?.rules ?? []
  const [f, setF] = useState({ ip: '203.0.113.7', method: 'GET', path: '/', preset: 'Chrome', headers: headersFor('Chrome') })
  const [res, setRes] = useState<TestResult>()
  const [err, setErr] = useState<{ code: string; message: string; reason?: string }>()
  const [busy, setBusy] = useState(false)
  const run = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true)
    const r = await call('shield.test', { ip: f.ip.trim(), method: f.method, path: f.path, headers: parseHeaders(f.headers) })
    setBusy(false)
    if (r.ok) { setRes(r.data as TestResult); setErr(undefined) } else setErr({ code: r.code, message: r.message, reason: r.reason })
  }
  return (
    <Region id="shield:test" label="Test a request" state={{ decision: res?.decision.action ?? null, matched: res?.trace.find((t) => t.matched)?.ruleId ?? null }}>
      <H title="Test a request" sub="Compose a request and see exactly what Shield would do: every signal, the score, each rule checked. Nothing is recorded or blocked." />
      <div className="grid gap-4 xl:grid-cols-[24rem_1fr]">
        <PlainForm onSubmit={run} className="tva-card flex h-fit flex-col gap-3 p-4">
          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <label className={label}>IP address<input agentId="ip" required className="tva-input font-mono" value={f.ip} aria-invalid={!IP_RE.test(f.ip.trim()) || undefined} onChange={(e) => setF({ ...f, ip: e.target.value })} /></label>
            <label className={label}>Method<select agentId="method" className="tva-input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select></label>
          </div>
          <label className={label}>Path<input agentId="path" required className="tva-input font-mono" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} /></label>
          <label className={label}>Browser or bot
            <select agentId="preset" className="tva-input" value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value, headers: headersFor(e.target.value) })}>{Object.keys(UA_PRESETS).map((k) => <option key={k}>{k}</option>)}</select>
          </label>
          <label className={label}>Headers<textarea agentId="headers" spellCheck={false} className="tva-input h-48 font-mono text-xs" value={f.headers} onChange={(e) => setF({ ...f, headers: e.target.value })} /></label>
          <button type="submit" agentId="run" className="tva-btn tva-btn-primary h-10" disabled={busy}><Icon name="play" size={14} />{busy ? 'Testing…' : 'Test request'}</button>
        </PlainForm>
        <div className="flex min-w-0 flex-col gap-4">
          {err && <ErrorBox error={err} />}
          {!res ? <div className="tva-card"><Empty title="No test yet" icon="play">Pick a preset like GPTBot or curl and press <strong>Test request</strong>.</Empty></div> : <TestOutput res={res} rules={ruleList} />}
        </div>
      </div>
    </Region>
  )
}
export function TestOutput({ res, rules }: { res: TestResult; rules: Rule[] }) {
  const d = res.decision
  const name = (id: string) => rules.find((r) => r.id === id)?.name ?? res.trace.find((t) => t.ruleId === id)?.name ?? id
  return (
    <>
      <Region id="test:decision" label="Decision" state={{ action: d.action, rule: d.ruleId ?? null, score: d.score, mode: d.mode }} className="tvs-verdict tva-card p-4" data-t={d.action === 'block' || d.action === 'rateLimit' ? 'error' : d.action === 'challenge' ? 'warn' : 'ok'}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Final decision</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold">{DECISION_LABEL[d.action] ?? d.action}{d.level ? ` · ${d.level}` : ''}{d.status ? ` · ${d.status}` : ''}</span>
          <Score n={d.score} />
          {d.mode === 'log' && <span className="tvs-decision" data-t="info">log mode: would only be recorded</span>}
        </div>
        <p className="mt-1 text-sm text-muted">{d.reason}{d.ruleId && <> — rule <strong className="text-fg">{name(d.ruleId)}</strong></>} · {d.ms.toFixed(2)} ms</p>
      </Region>
      <div className="grid gap-4 lg:grid-cols-2">
        <Region id="test:trace" label="Rule trace" state={{ checked: res.trace.length, matched: res.trace.filter((t) => t.matched).map((t) => t.ruleId).join(',') }} className="tva-card p-4">
          <h2 className="mb-2 font-semibold">Rules, in order</h2>
          <ol className="flex flex-col gap-1">
            {res.trace.map((t, i) => {
              const rule = rules.find((r) => r.id === t.ruleId)
              const decisive = t.ruleId === d.ruleId
              return (
                <li key={t.ruleId} className={cx('tvs-trace', t.matched && 'is-match', decisive && 'is-decisive')} aria-current={decisive ? 'step' : undefined}>
                  <span className="tvs-order">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{name(t.ruleId)}</p>
                    {rule && <p className="truncate text-xs text-muted">{describe(rule.when)} → {actionText(rule.then)}</p>}
                  </div>
                  <span className="text-xs font-semibold">{t.matched ? (decisive ? 'decided' : 'matched') : 'no match'}</span>
                  <span className="w-14 text-right text-xs tabular-nums text-muted">{t.ms.toFixed(2)} ms</span>
                </li>
              )
            })}
            {res.trace.length === 0 && <li className="text-sm text-muted">No rules ran.</li>}
          </ol>
        </Region>
        <Region id="test:score" label="Score breakdown" state={{ score: res.signals.score }} className="tva-card p-4">
          <h2 className="mb-1 font-semibold">Score {res.signals.score}</h2>
          <p className="mb-3 text-xs text-muted">Starts at 50. Signals push it toward 1 (bot) or 99 (human).</p>
          {res.scoreParts?.length ? (
            <ul className="flex flex-col gap-1.5">{res.scoreParts.map((p) => (
              <li key={p.signal} className="tvs-part" data-t={p.weight < 0 ? 'error' : 'ok'}>
                <span className="min-w-0 flex-1 truncate text-sm">{p.signal}</span>
                <span className="tvs-bar"><span style={{ width: `${Math.min(100, Math.abs(p.weight) * 2)}%` }} /></span>
                <span className="w-10 text-right text-sm font-semibold tabular-nums">{p.weight > 0 ? '+' : ''}{p.weight}</span>
              </li>
            ))}</ul>
          ) : <p className="text-sm text-muted">No breakdown returned.</p>}
        </Region>
      </div>
      <section className="tva-card p-4"><h2 className="mb-3 font-semibold">Signals</h2><SignalGrid s={res.signals} /></section>
    </>
  )
}

// ---- Settings -------------------------------------------------------------------------------------------------------
const MODES: { mode: Mode; help: string; warn?: string }[] = [
  { mode: 'off', help: 'Shield does nothing. Requests are not scored or recorded.', warn: 'Your site has no bot protection while Shield is off.' },
  { mode: 'log', help: 'Shield scores every request and records what it would do, but never challenges or blocks. Safe for trying rules.' },
  { mode: 'enforce', help: 'Shield challenges and blocks for real.', warn: 'Real visitors can be challenged or blocked. Test your rules in log mode first.' },
]
const LEVELS: { l: ChallengeLevel; label: string; help: string }[] = [
  { l: 'pow', label: 'Invisible puzzle', help: 'The browser solves a small math puzzle in the background. No clicks.' },
  { l: 'checkbox', label: 'Checkbox', help: 'One click on “I am human”, with timing and movement checks.' },
  { l: 'captcha', label: 'Image puzzle', help: 'Pick the matching tiles. Last resort for very low scores.' },
]
export function Settings() {
  const { call, settings, setSettings, user } = useShield()
  const [s, setS] = useState<ShieldSettings | undefined>(settings)
  const ipdb = useLiveData<IpdbStatus>(call, 'shield.ipdb.status', {})
  const [busy, setBusy] = useState(false), [updating, setUpdating] = useState(false)
  if (!s) return <div className="tva-card"><Skeleton rows={8} /></div>
  const fields = userFields(s.userFields)
  const dirty = JSON.stringify(s) !== JSON.stringify(settings)
  const save = async () => {
    setBusy(true)
    const r = await write<ShieldSettings>(call, 'shield.settings.save', { mode: s.mode, clearanceTtl: s.clearanceTtl, levels: s.levels, access: s.access, ...(s.events && { events: { logAll: s.events.logAll, retentionDays: s.events.retentionDays } }), ...(s.stats && { stats: s.stats }), ...(s.cleanup && { cleanup: { enabled: s.cleanup.enabled } }) }, 'Settings saved')
    setBusy(false)
    if (r) setSettings(typeof r === 'object' ? { ...s, ...r } : s)
  }
  const m = MODES.find((x) => x.mode === s.mode)!
  return (
    <Region id="shield:settings" label="Settings" state={{ mode: s.mode, ttl: s.clearanceTtl, levels: s.levels.join(','), access: describe(s.access, fields), dirty }}>
      <H title="Settings" sub="How strict Shield is, how long a passed challenge lasts, and who may open this panel.">
        <button type="button" agentId="save" className="tva-btn tva-btn-primary" disabled={!dirty || busy || !s.levels.length} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
      </H>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="tva-card p-4">
          <h2 className="mb-3 font-semibold">Mode</h2>
          <div className="tvs-modes" role="radiogroup" aria-label="Mode">
            {MODES.map((x) => <button key={x.mode} type="button" role="radio" agentId={`mode-${x.mode}`} aria-checked={s.mode === x.mode} data-mode={x.mode} onClick={() => setS({ ...s, mode: x.mode })}>{MODE_TEXT[x.mode]}</button>)}
          </div>
          <p className="mt-3 text-sm">{m.help}</p>
          {m.warn && <p role="alert" className={cx('mt-2 flex items-start gap-2 rounded-md p-3 text-sm', s.mode === 'off' ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn')}><Icon name="alert" size={16} />{m.warn}</p>}
        </section>
        <section className="tva-card p-4">
          <h2 className="mb-3 font-semibold">Challenges</h2>
          <label className={cx(label, 'max-w-xs')}>A passed challenge lasts
            <input agentId="clearance-ttl" className="tva-input" value={s.clearanceTtl} pattern="\d+[smhd]" placeholder="30m" onChange={(e) => setS({ ...s, clearanceTtl: e.target.value })} />
            <span className="text-xs font-normal text-muted">Like 30m, 12h or 7d. Rules can set their own.</span>
          </label>
          <p className="mt-4 mb-2 text-[13px] font-medium">Levels Shield may use</p>
          <div className="flex flex-col gap-2">
            {LEVELS.map((x) => (
              <label key={x.l} className="flex items-start gap-2 text-sm">
                <input type="checkbox" agentId={`level-${x.l}`} className="tva-check mt-0.5" checked={s.levels.includes(x.l)} onChange={(e) => setS({ ...s, levels: e.target.checked ? [...s.levels, x.l] : s.levels.filter((y) => y !== x.l) })} />
                <span><strong className="font-medium">{x.label}</strong><span className="block text-muted">{x.help}</span></span>
              </label>
            ))}
            {!s.levels.length && <p role="alert" className="text-sm text-danger">Pick at least one level.</p>}
          </div>
        </section>
        <section className="tva-card p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">Panel access</h2>
              <p className="text-sm text-muted">This decides <strong className="text-fg">who can open /shield</strong> and use every Shield action. It is checked against the signed-in user on each request. Default: superusers only.</p>
            </div>
            <span className="tva-chip">Now: {describe(s.access, fields)}</span>
          </div>
          <ConditionBuilder label="Panel access condition" value={s.access} fields={fields} onChange={(access) => setS({ ...s, access })} />
          <p className="mt-3 flex items-start gap-2 text-xs text-muted"><Icon name="alert" size={14} />Make sure you ({user.username}) still match, or you will lock yourself out. A superuser can always reset it with <code className="tva-kbd">tvine shell</code>.</p>
        </section>
        {s.events && s.stats && s.cleanup && <DataCard s={s} setS={setS} call={call} />}
        <IpdbCard ipdb={ipdb.data} error={ipdb.error} updating={updating} onUpdate={async () => { setUpdating(true); await write(call, 'shield.ipdb.update', {}, 'Update started'); setUpdating(false); void ipdb.reload() }} />
      </div>
    </Region>
  )
}
// events + rollups: what is kept, for how long, and a manual purge (superuser; the action re-checks)
function DataCard({ s, setS, call }: { s: ShieldSettings; setS(v: ShieldSettings): void; call: Call }) {
  const ev = s.events!, st = s.stats!, cl = s.cleanup!
  const [before, setBefore] = useState(''), [purging, setPurging] = useState(false)
  const num = (v: string) => Math.max(1, Math.round(Number(v) || 1))
  const purge = async () => {
    const when = before ? `older than ${before}` : 'ALL events (up to now)'
    if (!window.confirm(`Delete ${when}? This cannot be undone.`)) return
    setPurging(true)
    await write(call, 'shield.events.purge', before ? { before: new Date(before).toISOString() } : {}, 'Events deleted')
    setPurging(false)
  }
  return (
    <section className="tva-card p-4 xl:col-span-2">
      <h2 className="mb-3 font-semibold">Data and cleanup</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" agentId="log-all" className="tva-check mt-0.5" checked={ev.logAll} onChange={(e) => setS({ ...s, events: { ...ev, logAll: e.target.checked } })} />
            <span><strong className="font-medium">Save every request</strong><span className="block text-muted">Off: only challenges, blocks and a 1% sample of passes are saved.</span></span>
          </label>
          {ev.logAll && <p role="alert" className="flex items-start gap-2 rounded-md bg-warn/10 p-3 text-sm text-warn"><Icon name="alert" size={16} />Every request becomes a database row (up to {ev.hardCapPerMinute.toLocaleString()} a minute per server). Expect a large table on busy sites.</p>}
          <label className={cx(label, 'max-w-xs')}>Keep events for (days)
            <input agentId="events-retention" type="number" min={1} className="tva-input" value={ev.retentionDays} onChange={(e) => setS({ ...s, events: { ...ev, retentionDays: num(e.target.value) } })} />
          </label>
          <label className={cx(label, 'max-w-xs')}>Keep chart data for (days)
            <input agentId="stats-retention" type="number" min={1} className="tva-input" value={st.retentionDays} onChange={(e) => setS({ ...s, stats: { ...st, retentionDays: num(e.target.value) } })} />
          </label>
        </div>
        <div className="flex flex-col gap-3">
          <label className={cx(label, 'max-w-xs')}>Chart bucket
            <select agentId="stats-bucket" className="tva-input" value={st.bucket} onChange={(e) => setS({ ...s, stats: { ...st, bucket: e.target.value as typeof st.bucket } })}>
              {(['1m', '5m', '15m', '1h', '1d'] as const).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="text-xs font-normal text-muted">Changing it affects new data only.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" agentId="cleanup-enabled" className="tva-check mt-0.5" checked={cl.enabled} onChange={(e) => setS({ ...s, cleanup: { ...cl, enabled: e.target.checked } })} />
            <span><strong className="font-medium">Clean up old data automatically</strong><span className="block text-muted">Runs on schedule {cl.schedule ?? 'daily'} (needs tvine.tasks and a beat).</span></span>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className={label}>Delete events older than
              <input agentId="purge-before" type="date" className="tva-input" value={before} onChange={(e) => setBefore(e.target.value)} />
            </label>
            <button type="button" agentId="purge" className="tva-btn tva-btn-danger-solid" disabled={purging} onClick={() => void purge()}>{purging ? 'Deleting…' : before ? 'Delete' : 'Delete all now'}</button>
          </div>
          {!!s.dropped && <p className="text-xs text-muted">{s.dropped.toLocaleString()} events skipped by the per-minute cap since this server started.</p>}
        </div>
      </div>
    </section>
  )
}
function IpdbCard({ ipdb, error, updating, onUpdate }: { ipdb?: IpdbStatus; error?: { code: string; message: string }; updating: boolean; onUpdate(): void }) {
  return (
    <Region id="shield:ipdb" label="IP database" state={{ ok: ipdb?.ok ?? null, updatedAt: ipdb?.updatedAt ?? null }} className="tva-card p-4 xl:col-span-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Country & network database</h2>
          <p className="text-sm text-muted">Maps an IP to its country and network (DB-IP Lite). Updated monthly by a task.</p>
        </div>
        <button type="button" agentId="ipdb-update" className="tva-btn" disabled={updating} onClick={onUpdate}><Icon name="refresh" size={14} className={cx(updating && 'animate-spin')} />{updating ? 'Updating…' : 'Update now'}</button>
      </div>
      {error && !ipdb ? <div className="mt-3"><ErrorBox error={error} /></div> : !ipdb ? <div className="mt-3 tva-skel h-5 w-64" /> : (
        <dl className="tvs-kv mt-3">
          <div><dt>Status</dt><dd><span className="tvs-decision" data-t={ipdb.ok ? 'ok' : 'error'}>{ipdb.ok ? 'ready' : 'missing'}</span>{ipdb.message && <span className="ml-2 text-muted">{ipdb.message}</span>}</dd></div>
          <div><dt>Source</dt><dd>{ipdb.source}</dd></div>
          <div><dt>Updated</dt><dd>{ipdb.updatedAt ? new Date(ipdb.updatedAt).toLocaleString() : 'never'}</dd></div>
          {ipdb.rows !== undefined && <div><dt>Ranges</dt><dd>{ipdb.rows.toLocaleString()}</dd></div>}
          {ipdb.next && <div><dt>Next update</dt><dd>{new Date(ipdb.next).toLocaleDateString()}</dd></div>}
        </dl>
      )}
    </Region>
  )
}

// ---- 403 ------------------------------------------------------------------------------------------------------------
export function Denied({ user, call, onTheme }: { user: User; call: Call; onTheme(): void }) {
  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <Region id="shield:denied" label="Access denied" state={{ user: user.username }} className="tva-card w-full max-w-md p-6 sm:p-8" role="alert">
        <div className="mb-5 flex items-center gap-3"><ShieldMark size={40} /><div><p className="text-xs font-semibold uppercase tracking-wide text-muted">403 · Shield</p><h1 className="text-lg font-semibold">You don’t have access to Shield</h1></div></div>
        <p className="text-sm">You are signed in as <strong>{user.username}</strong>, but the <strong>panel access condition</strong> does not include you.</p>
        <p className="mt-2 text-sm text-muted">That condition decides who can open /shield. By default only superusers can. An administrator can widen it in Shield → Settings → Panel access (for example “is staff”, or “groups contains security”).</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" agentId="switch-user" className="tva-btn tva-btn-primary" onClick={() => void call('auth.logout').then(() => location.reload())}>Sign in as someone else</button>
          <a href="/admin/" agentId="admin" className="tva-btn">Go to admin</a>
          <button type="button" agentId="theme" aria-label="Toggle dark mode" className="tva-btn tva-btn-ghost tva-btn-icon" onClick={onTheme}><Icon name="moon" /></button>
        </div>
      </Region>
    </div>
  )
}
