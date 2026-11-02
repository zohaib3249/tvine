'use client'
// "Run code" rules: the action is JavaScript the server runs in a sandbox (shield.code.*). CodeMirror 6 editor with
// req.* / action completions, hover docs, debounced server lint (shield.code.check), a reference panel and a test bench
// (shield.code.run on a sample request or a stored event). Agents write code through the hidden textarea agentId="code".
import { useEffect, useRef, useState } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippetCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { Icon, Region, cx } from '../ui.js'
import { useShield } from './ctx.js'
import { actionText, tone } from './rules.js'
import type { Action, CodeCheck, CodeField, CodeProblem, CodeRun, CodeTemplate } from './types.js'

// the bundled copy of the server template (used when shield.code.template fails)
export const FALLBACK: CodeTemplate = {
  template: `// Runs for every request that matches "When".
// Return an action to decide, or nothing to pass the request to the next rule.
// If this code throws or runs too long, the rule is skipped: traffic is never blocked by a broken rule.
function (req) {
  if (req.path.startsWith('/checkout') && req.score < 20) {
    return { type: 'challenge', level: 'pow' }
  }
  return null
}
`,
  fields: [
    { name: 'ip', type: 'string', description: 'Client IP address.' }, { name: 'ipNet', type: 'string', description: 'The /24 (IPv4) or /48 (IPv6) network of the IP.' },
    { name: 'country', type: 'string', description: 'Two-letter country code, e.g. "US". Empty for local addresses.' },
    { name: 'asn', type: 'number', description: 'Network (autonomous system) number.' }, { name: 'asnOrg', type: 'string', description: 'Network owner, e.g. "Amazon.com".' },
    { name: 'asnKind', type: 'string', description: '"datacenter", "residential", "mobile" or "unknown".' }, { name: 'tor', type: 'boolean', description: 'True for Tor exit nodes.' },
    { name: 'ua', type: 'string', description: 'The User-Agent header.' }, { name: 'path', type: 'string', description: 'Request path, e.g. "/checkout".' },
    { name: 'method', type: 'string', description: 'HTTP method, e.g. "GET".' }, { name: 'host', type: 'string', description: 'The Host header.' },
    { name: 'headers', type: 'object', description: 'Request headers, lower-case names.' },
    { name: 'bot.name', type: 'string', description: 'Known bot name, e.g. "GPTBot".' }, { name: 'bot.category', type: 'string', description: 'search, ai-crawler, ai-agent, monitor, seo, scraper, scanner, automation, browser or unknown.' },
    { name: 'bot.verified', type: 'boolean', description: 'The bot proved who it is (reverse DNS, IP range, signature).' },
    { name: 'rate.ip', type: 'number', description: 'Requests in the last minute from this IP.' }, { name: 'rate.asn', type: 'number', description: 'Requests in the last minute from this network.' },
    { name: 'rate.path', type: 'number', description: 'Requests in the last minute to this path.' },
    { name: 'score', type: 'number', description: 'Bot score: 1 = surely a bot, 99 = surely a human.' },
  ],
  actions: ['allow', 'log', 'challenge', 'block', 'rateLimit'],
}
const SNIPPET: Record<string, string> = {
  allow: "return { type: 'allow' }", log: "return { type: 'log' }",
  challenge: "return { type: 'challenge', level: '${pow}' }", block: "return { type: 'block', status: ${403} }",
  rateLimit: "return { type: 'rateLimit', limit: ${100}, window: '${1m}', key: '${ip}' }",
}
const ACTION_HELP: Record<string, string> = { allow: 'Let it through. No later rule runs.', log: 'Record it, keep checking the next rules.', challenge: 'Ask the browser to prove it is human.', block: 'Refuse with an error page.', rateLimit: 'Allow N requests per window, then 429.' }
const KEYS: Record<string, string[]> = { challenge: ['level', 'ttl'], block: ['status', 'message'], rateLimit: ['limit', 'window', 'key'] }
const VALUES: Record<string, string[]> = { level: ['auto', 'pow', 'checkbox', 'captcha'], key: ['ip', 'asn', 'path', 'ip+path'], window: ['10s', '1m', '5m', '1h'], status: ['403', '404', '429', '451'] }
export const plain = (a: string) => (SNIPPET[a] ?? `return { type: '${a}' }`).replace(/\$\{([^}]*)\}/g, '$1')

type Live = { fields: CodeField[]; actions: string[]; run(): void }
export function completions(live: { current: Live }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { fields, actions } = live.current
    const req = ctx.matchBefore(/\breq\.[\w.]*/)
    if (req) return { from: req.from + 4, options: fields.map((f) => ({ label: f.name, type: 'property', detail: f.type, info: f.description })), validFor: /^[\w.]*$/ }
    const val = ctx.matchBefore(/\b(level|key|window|status|type)\s*:\s*['"]?[\w+]*/)
    if (val) {
      const [, k, q, typed] = /^(\w+)\s*:\s*(['"]?)([\w+]*)$/.exec(val.text)!
      const opts = k === 'type' ? actions : VALUES[k!] ?? []
      return { from: val.to - typed!.length, options: opts.map((v) => ({ label: v, type: 'enum', apply: q || k === 'status' ? v : `'${v}'`, info: k === 'type' ? ACTION_HELP[v] : undefined })), validFor: /^[\w+]*$/ }
    }
    const obj = /\breturn\s*\{([^{}]*)$/.exec(ctx.state.sliceDoc(Math.max(0, ctx.pos - 400), ctx.pos))
    if (obj) {
      const seg = obj[1]!.split(',').pop()!
      if (seg.includes(':')) return null
      const word = /\w*$/.exec(seg)![0]
      if (!word && !ctx.explicit) return null
      const type = /type\s*:\s*['"](\w+)/.exec(obj[1]!)?.[1]
      const keys = (type ? KEYS[type] ?? [] : ['type', ...new Set(Object.values(KEYS).flat())]).filter((k) => !new RegExp(`\\b${k}\\s*:`).test(obj[1]!))
      return { from: ctx.pos - word.length, options: keys.map((k) => ({ label: k, type: 'property', apply: `${k}: `, detail: type ? `${type} option` : 'action key' })), validFor: /^\w*$/ }
    }
    const word = ctx.matchBefore(/\w+/)
    if ((!word && !ctx.explicit) || (word && ctx.state.sliceDoc(word.from - 1, word.from) === '.')) return null
    return { from: word?.from ?? ctx.pos, options: actions.filter((a) => SNIPPET[a]).map((a) => snippetCompletion(SNIPPET[a]!, { label: a, type: 'keyword', detail: 'return action', info: ACTION_HELP[a] })), validFor: /^\w*$/ }
  }
}

// the req.<field> under the cursor (hover)
export function fieldAt(text: string, i: number, fields: CodeField[]): { from: number; to: number; field: CodeField } | null {
  let s = i, e = i
  while (s > 0 && /[\w.]/.test(text[s - 1]!)) s--
  while (e < text.length && /[\w.]/.test(text[e]!)) e++
  while (text[e - 1] === ".") e--
  const m = /^req\.([\w.]+)$/.exec(text.slice(s, e))
  const field = m && fields.find((f) => f.name === m[1])
  return field ? { from: s, to: e, field } : null
}

const hl = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: 'var(--tva-c7)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--tva-c3)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tva-c2)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tva-muted)', fontStyle: 'italic' },
  { tag: [t.propertyName], color: 'var(--tva-c1)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tva-c5)' },
  { tag: t.invalid, color: 'var(--tva-danger)' },
])
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--tva-surface)', color: 'var(--tva-fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--tva-fg)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--tva-fg)' },
  '.cm-gutters': { backgroundColor: 'var(--tva-sunken)', color: 'var(--tva-muted)', borderRight: '1px solid var(--tva-line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--tva-brand) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in oklab, var(--tva-brand) 10%, transparent)', color: 'var(--tva-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in oklab, var(--tva-c1) 28%, transparent) !important' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--tva-c3) 25%, transparent)', outline: 'none' },
  '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--tva-warning) 30%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--tva-surface)', color: 'var(--tva-fg)', border: '1px solid var(--tva-line)', borderRadius: '6px', boxShadow: '0 8px 24px -8px rgb(0 0 0 / .3)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--tva-brand-soft)', color: 'var(--tva-fg)' },
  '.cm-completionDetail': { color: 'var(--tva-muted)', fontStyle: 'normal', marginLeft: '.6em' },
  '.cm-completionInfo': { maxWidth: '20rem', padding: '6px 8px' },
  '.cm-panels': { backgroundColor: 'var(--tva-sunken)', color: 'var(--tva-fg)', borderColor: 'var(--tva-line)' },
  '.cm-panel input, .cm-panel button': { color: 'inherit' },
  '.cm-textfield': { backgroundColor: 'var(--tva-surface)', border: '1px solid var(--tva-line)', borderRadius: '4px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--tva-surface)', border: '1px solid var(--tva-line)', borderRadius: '4px' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--tva-danger)', textUnderlineOffset: '3px' },
})

function tip(f: CodeField) {
  const d = document.createElement('div'); d.className = 'tvs-cm-tip'
  const h = document.createElement('code'); h.textContent = `req.${f.name}: ${f.type}`
  const p = document.createElement('p'); p.textContent = f.description
  d.append(h, p)
  return d
}

// the CodeMirror view; the React value is the source of truth (external changes are pushed into the doc)
function Editor({ value, onChange, problems, live, viewRef }: { value: string; onChange(s: string): void; problems: CodeProblem[]; live: { current: Live }; viewRef: { current: EditorView | null } }) {
  const host = useRef<HTMLDivElement>(null)
  const change = useRef(onChange); change.current = onChange
  useEffect(() => {
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce
    const ext: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), lintGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(),
      autocompletion(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
      javascript(), javascriptLanguage.data.of({ autocomplete: completions(live) }), syntaxHighlighting(hl), theme,
      EditorState.tabSize.of(2), EditorView.contentAttributes.of({ 'aria-label': 'Rule code (JavaScript)' }),
      hoverTooltip((v, pos) => {
        const line = v.state.doc.lineAt(pos)
        const hit = fieldAt(line.text, pos - line.from, live.current.fields)
        return hit ? { pos: line.from + hit.from, end: line.from + hit.to, above: true, create: () => ({ dom: tip(hit.field) }) } : null
      }),
      keymap.of([{ key: 'Mod-Enter', run: () => { live.current.run(); return true } }, ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => { if (u.docChanged) change.current(u.state.doc.toString()) }),
      ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
    ]
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: ext }) })
    viewRef.current = v
    return () => { v.destroy(); viewRef.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = viewRef.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const doc = v.state.doc
    const diags: Diagnostic[] = problems.map((p) => {
      const line = doc.line(Math.min(Math.max(1, p.line), doc.lines))
      const from = Math.min(line.to, line.from + Math.max(0, p.column - 1))
      return { from, to: Math.min(line.to, from + 1), severity: 'error', message: p.message }
    })
    v.dispatch(setDiagnostics(v.state, diags))
  }, [problems])   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} className="tvs-cm" />
}

export const CHECK_DEBOUNCE_MS = 400
type Sample = { ip: string; path: string; method: string; ua: string; country: string; score: number }
const SAMPLE: Sample = { ip: '203.0.113.7', path: '/checkout', method: 'POST', ua: 'python-requests/2.32.3', country: 'US', score: 18 }
type RunState = { busy?: boolean; res?: CodeRun; fail?: string }
const runText = (r: RunState) => (r.fail ? `failed: ${r.fail}` : !r.res ? '' : r.res.ok ? (r.res.result ? actionText(r.res.result) : 'no decision') : `error ${r.res.error?.kind ?? ''}: ${r.res.error?.message ?? ''}`)

export function CodePanel({ value, onChange, onErrors, ray: ray0, full: full0, onFull }: { value: { type: 'code'; source: string }; onChange(a: Action): void; onErrors(n: number): void; ray?: string; full?: boolean; onFull?(f: boolean): void }) {
  const { call } = useShield()
  const [tpl, setTpl] = useState<CodeTemplate>()
  const [problems, setProblems] = useState<CodeProblem[]>([])
  const [checkFail, setCheckFail] = useState<string>()
  const [refOpen, setRefOpen] = useState(true)
  const [fullOwn, setFullOwn] = useState(false)
  const full = full0 ?? fullOwn, setFull = onFull ?? setFullOwn
  useEffect(() => { if (full) view.current?.focus() }, [full])
  const [tab, setTab] = useState<'sample' | 'event'>(ray0 ? 'event' : 'sample')
  const [sample, setSample] = useState(SAMPLE)
  const [ray, setRay] = useState(ray0 ?? '')
  const [run, setRun] = useState<RunState>({})
  const view = useRef<EditorView | null>(null)
  const source = value.source
  const set = (s: string) => onChange({ type: 'code', source: s })
  const doRun = async () => {
    setRun((r) => ({ ...r, busy: true }))
    const r = await call('shield.code.run', tab === 'event' ? { source, ray: ray.trim() } : { source, input: sample })
    setRun(r.ok ? { res: r.data as CodeRun } : { fail: r.message })
  }
  const live = useRef<Live>({ fields: FALLBACK.fields, actions: FALLBACK.actions, run: () => {} })
  live.current = { fields: tpl?.fields ?? FALLBACK.fields, actions: tpl?.actions ?? FALLBACK.actions, run: () => void doRun() }
  useEffect(() => {
    let on = true
    void call('shield.code.template', {}).then((r) => { if (on) setTpl(r.ok ? (r.data as CodeTemplate) : FALLBACK) })
    return () => { on = false }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tpl && !source.trim()) set(tpl.template) }, [tpl])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let on = true
    const t = setTimeout(async () => {
      const r = await call('shield.code.check', { source })
      if (!on) return
      const errs = r.ok ? (r.data as CodeCheck).errors ?? [] : []
      setCheckFail(r.ok ? undefined : r.message); setProblems(errs); onErrors(errs.length)
    }, CHECK_DEBOUNCE_MS)
    return () => { on = false; clearTimeout(t) }
  }, [source])   // eslint-disable-line react-hooks/exhaustive-deps
  const jump = (line: number, col = 1) => {
    const v = view.current
    if (!v) return
    const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines))
    v.dispatch({ selection: { anchor: Math.min(l.to, l.from + col - 1) }, scrollIntoView: true }); v.focus()
  }
  const insert = (text: string) => { const v = view.current; if (!v) return; v.dispatch(v.state.replaceSelection(text)); v.focus() }
  const fields = tpl?.fields ?? FALLBACK.fields, actions = tpl?.actions ?? FALLBACK.actions
  const lab = 'flex flex-col gap-1 text-[12px] font-medium'
  const res = run.res
  return (
    <Region id="rule:code" label="Rule code" state={{ source: source.slice(0, 2000), errors: problems.length, lastRun: runText(run) || null, loading: !tpl }} className={cx('tva-card tvs-code', full && 'is-full')} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? 'Code editor' : undefined}
      onKeyDown={(e: React.KeyboardEvent) => { if (full && e.key === 'Escape' && !(e.target as HTMLElement).closest('.cm-editor')) setFull(false) }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Icon name="code" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Code</h2>
          <p className="text-[13px] text-muted">Return an action, or nothing to pass to the next rule. If the code throws or times out, the rule is skipped, never blocking traffic.</p>
        </div>
        <button type="button" agentId="code-reference" className="tva-btn h-8 text-xs" aria-expanded={refOpen} onClick={() => setRefOpen(!refOpen)}><Icon name="file" size={13} />Reference</button>
        <button type="button" agentId="code-fullscreen" className="tva-btn tva-btn-icon h-8 w-8" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull(!full)}><Icon name="resize" size={14} /></button>
        {full && <button type="button" agentId="code-done" className="tva-btn tva-btn-primary h-8 text-xs" onClick={() => setFull(false)}>Done</button>}
      </div>
      <div className={cx('tvs-code-body', refOpen && 'has-ref')}>
        <div className="min-w-0">
          <Editor value={source} onChange={set} problems={problems} live={live} viewRef={view} />
          {/* the plain-text twin of the editor: agents (and any tool without a pointer) write the code here */}
          <textarea agentId="code" className="sr-only" tabIndex={-1} aria-label="Rule code, plain text" value={source} onChange={(e) => set(e.target.value)} />
        </div>
        {refOpen && (
          <aside className="tvs-code-ref" aria-label="Reference">
            <h3 className="tvs-nav-h pt-3">Request · req.</h3>
            {fields.map((f) => (
              <button key={f.name} type="button" agentId={`ref-${f.name}`} className="tvs-ref-item" title={f.description} onClick={() => insert(`req.${f.name}`)}>
                <code>req.{f.name}</code><span className="text-muted">{f.type}</span><span className="block text-muted">{f.description}</span>
              </button>
            ))}
            <h3 className="tvs-nav-h pt-3">Actions · return</h3>
            {actions.map((a) => (
              <button key={a} type="button" agentId={`ref-action-${a}`} className="tvs-ref-item" title={ACTION_HELP[a]} onClick={() => insert(plain(a))}>
                <code>{plain(a).replace(/^return /, '')}</code><span className="block text-muted">{ACTION_HELP[a]}</span>
              </button>
            ))}
          </aside>
        )}
      </div>
      <div className="border-t border-line px-4 py-2 text-[13px]" role="status">
        {problems.length ? (
          <ul className="flex flex-col gap-0.5" aria-label="Problems">
            {problems.map((p, i) => (
              <li key={i}><button type="button" agentId={`problem-${i}`} className="tvs-problem" onClick={() => jump(p.line, p.column)}><Icon name="alert" size={13} />Line {p.line}:{p.column} — {p.message}</button></li>
            ))}
          </ul>
        ) : <p className="text-muted">{checkFail ? `Could not check the code: ${checkFail}` : <><Icon name="check" size={13} className="inline text-ok" /> No problems. <kbd className="tva-kbd">Tab</kbd> indents; <kbd className="tva-kbd">Esc</kbd> then <kbd className="tva-kbd">Tab</kbd> leaves the editor.</>}</p>}
      </div>
      <Region id="code:test" label="Test the code" state={{ tab, ray: ray || null, busy: !!run.busy, result: runText(run) || null }} className="border-t border-line p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Test</h3>
          <div role="tablist" aria-label="Test input" className="tvs-modes ml-2 !inline-grid">
            <button type="button" role="tab" agentId="tab-sample" aria-selected={tab === 'sample'} aria-checked={tab === 'sample'} onClick={() => setTab('sample')}>Sample request</button>
            <button type="button" role="tab" agentId="tab-event" aria-selected={tab === 'event'} aria-checked={tab === 'event'} onClick={() => setTab('event')}>Real event</button>
          </div>
          <div className="flex-1" />
          <button type="button" agentId="code-run" className="tva-btn tva-btn-primary h-8" disabled={run.busy || (tab === 'event' && !ray.trim())} onClick={() => void doRun()}>
            <Icon name="play" size={13} />{run.busy ? 'Running…' : 'Run'}<span className="ml-1 text-xs opacity-75" aria-hidden="true">⌘↵</span>
          </button>
        </div>
        {tab === 'sample' ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            {(['ip', 'path', 'method', 'country', 'score'] as const).map((k) => (
              <label key={k} className={lab}>{k}
                <input agentId={`sample-${k}`} className="tva-input h-8 font-mono text-xs" type={k === 'score' ? 'number' : 'text'} min={1} max={99} value={sample[k]}
                  onChange={(e) => setSample({ ...sample, [k]: k === 'score' ? Number(e.target.value) || 0 : e.target.value })} />
              </label>
            ))}
            <label className={cx(lab, 'col-span-2 md:col-span-6')}>ua
              <input agentId="sample-ua" className="tva-input h-8 font-mono text-xs" value={sample.ua} onChange={(e) => setSample({ ...sample, ua: e.target.value })} />
            </label>
          </div>
        ) : (
          <label className={lab}>Ray ID of a stored event
            <input agentId="ray" className="tva-input h-8 max-w-xs font-mono text-xs" value={ray} placeholder="9f3a1c07" onChange={(e) => setRay(e.target.value)} />
          </label>
        )}
        {(res || run.fail) && (
          <div className="tvs-run mt-4" aria-live="polite">
            {run.fail ? <p className="text-danger">{run.fail}</p>
              : res!.ok ? (
                <p className="flex flex-wrap items-center gap-2">
                  {res!.result ? <span className="tvs-decision" data-t={tone(res!.result)}>{actionText(res!.result)}</span> : <><span className="tvs-decision" data-t="info">No decision</span><span className="text-muted">passes to the next rule</span></>}
                  <span className="text-xs text-muted tabular-nums">{res!.ms.toFixed(2)} ms</span>
                </p>
              ) : (
                <div className="tvs-run-err">
                  <p className="flex flex-wrap items-center gap-2"><span className="tvs-decision" data-t="error">{res!.error?.kind ?? 'error'}</span><span className="text-danger">{res!.error?.message}</span><span className="text-xs text-muted tabular-nums">{res!.ms.toFixed(2)} ms</span>
                    {res!.error?.line && <button type="button" agentId="jump-error" className="tva-btn tva-btn-ghost h-7 text-xs" onClick={() => jump(res!.error!.line!)}>Go to line {res!.error.line}</button>}</p>
                  <p className="mt-1 text-xs text-muted">In live traffic this rule would be skipped and the request checked by the next rules.</p>
                </div>
              )}
            {res && res.logs.length > 0 && <><h4 className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Console</h4><pre className="tva-pre text-xs">{res.logs.join('\n')}</pre></>}
          </div>
        )}
      </Region>
    </Region>
  )
}
