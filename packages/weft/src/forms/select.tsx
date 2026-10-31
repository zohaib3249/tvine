'use client'
// Dropdown (single), MultiSelect (chips) and FileDrop: native-first custom controls for the form widgets.
// Dropdown / MultiSelect: APG listbox pattern (button or combobox input + popup listbox, aria-activedescendant),
// typeahead, arrow / Home / End / Enter / Escape, a search box over 8 options or when the rows come from `search`.
// A hidden native <select> mirrors the value for local lists (form posts, headless tests, autofill parity).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Search } from './types.js'

export type Opt = { value: string; label: string }
const SEARCH_OVER = 8

// ---- icons (inline SVG, currentColor) ----
const svg = (d: ReactNode, cls = 'tf-icon') => <svg className={cls} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
export const Icon = {
  chevron: () => svg(<path d="m6 8 4 4 4-4" />, 'tf-icon tf-chevron'),
  check: () => svg(<path d="m5 10.5 3.2 3L15 6.5" />, 'tf-icon tf-check-mark'),
  x: () => svg(<path d="m6 6 8 8m0-8-8 8" />),
  search: () => svg(<><circle cx="9" cy="9" r="5" /><path d="m13 13 3.5 3.5" /></>),
  upload: () => svg(<><path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5" /><path d="M4 13v2a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-2" /></>, 'tf-icon tf-icon-lg'),
  file: () => svg(<><path d="M11.5 3H6.5A1.5 1.5 0 0 0 5 4.5v11A1.5 1.5 0 0 0 6.5 17h7a1.5 1.5 0 0 0 1.5-1.5V6.5z" /><path d="M11.5 3v3.5H15" /></>, 'tf-icon tf-icon-lg'),
}

// async rows over search(q, page), latest request wins
function useRemote(search: Search | undefined) {
  const [res, setRes] = useState<Opt[]>([]), [more, setMore] = useState(false), [page, setPage] = useState(1), [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const run = (q: string, pg = 1) => {
    if (!search) return
    const n = ++seq.current; setLoading(true)
    search(q, pg).then((r) => {
      if (n !== seq.current) return
      const rows = r.results.map((x) => ({ value: x.pk, label: x.text }))
      setRes((old) => (pg > 1 ? [...old, ...rows] : rows)); setMore(r.more); setPage(pg)
    }, () => { if (n === seq.current) setRes([]) }).finally(() => { if (n === seq.current) setLoading(false) })
  }
  return { res, more, page, loading, run }
}

// open state + outside click + highlighted row + typeahead, shared by both controls
function usePopup(rootRef: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false), [hi, setHi] = useState(-1), [q, setQ] = useState('')
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open, rootRef])
  const buf = useRef({ s: '', t: 0 })
  const typeahead = (key: string, list: Opt[]): number => {
    const now = Date.now(), b = buf.current
    b.s = now - b.t > 600 ? key : b.s + key; b.t = now
    return list.findIndex((o) => o.label.toLowerCase().startsWith(b.s.toLowerCase()))
  }
  return { open, setOpen, hi, setHi, q, setQ, typeahead }
}
const scrollTo = (id: string) => (typeof document !== 'undefined' ? document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }) : undefined)
const match = (q: string) => (o: Opt) => !q || o.label.toLowerCase().includes(q.toLowerCase())

// arrow / Home / End / Enter / Escape over `list`; returns true when handled
function navKey(e: KeyboardEvent, p: ReturnType<typeof usePopup>, list: Opt[], pick: (o: Opt) => void, close: () => void): boolean {
  const n = list.length
  switch (e.key) {
    case 'ArrowDown': case 'ArrowUp':
      e.preventDefault()
      if (!p.open) { p.setOpen(true); return true }
      if (n) p.setHi((h) => (e.key === 'ArrowDown' ? Math.min(h + 1, n - 1) : Math.max(h - 1, 0)))
      return true
    case 'Home': case 'End': if (!p.open || !n) return false; e.preventDefault(); p.setHi(e.key === 'Home' ? 0 : n - 1); return true
    case 'Enter': if (!p.open || !list[p.hi]) return false; e.preventDefault(); pick(list[p.hi]!); return true
    case 'Escape': if (!p.open) return false; e.preventDefault(); e.stopPropagation(); close(); return true
    case 'Tab': if (p.open) p.setOpen(false); return false
  }
  return false
}

interface Common { id: string; name: string; label: string; describedBy?: string; invalid: boolean; disabled: boolean; required: boolean; search?: Search }

function Options(p: { id: string; list: Opt[]; hi: number; setHi(i: number): void; isOn(v: string): boolean; pick(o: Opt): void; multi?: boolean
  loading?: boolean; more?: boolean; onMore?(): void; label: string; empty: string }) {
  return <ul className="tf-listbox" id={`${p.id}-list`} role="listbox" aria-label={p.label} aria-multiselectable={p.multi || undefined} aria-busy={p.loading || undefined}>
    {p.list.map((o, i) => <li key={o.value} id={`${p.id}-o${i}`} role="option" className="tf-option" data-value={o.value} aria-selected={p.isOn(o.value)}
      data-highlighted={i === p.hi ? '' : undefined} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => p.hi !== i && p.setHi(i)} onClick={() => p.pick(o)}>
      {p.multi && <span className="tf-optbox" aria-hidden="true">{p.isOn(o.value) && Icon.check()}</span>}
      <span className="tf-option-label">{o.label}</span>{!p.multi && p.isOn(o.value) && Icon.check()}</li>)}
    {p.more && <li role="presentation" className="tf-option tf-more" onMouseDown={(e) => e.preventDefault()} onClick={p.onMore}>Load more…</li>}
    {p.loading && <li role="presentation" className="tf-option tf-muted" data-part="loading"><span className="tf-spinner" aria-hidden="true" /> Loading…</li>}
    {!p.loading && !p.list.length && <li role="presentation" className="tf-option tf-muted" data-part="empty">{p.empty}</li>}
  </ul>
}

// ---- single select: a button + popup listbox ----
export function Dropdown(p: Common & { options?: Opt[]; value: Opt | null; onChange(o: Opt | null): void; placeholder?: string }) {
  const root = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), box = useRef<HTMLInputElement>(null)
  const pop = usePopup(root), remote = useRemote(p.search)
  const local = p.options ?? [], async = !!p.search && !p.options
  const list = async ? remote.res : local.filter(match(pop.q))
  const withSearch = async || local.length > SEARCH_OVER
  const close = (focus = true) => { pop.setOpen(false); pop.setQ(''); if (focus) btn.current?.focus() }
  const pick = (o: Opt) => { p.onChange(o); close() }
  const openUp = () => {
    pop.setOpen(true); pop.setHi(Math.max(0, list.findIndex((o) => o.value === p.value?.value)))
    if (async) remote.run(pop.q)
    if (withSearch) setTimeout(() => box.current?.focus(), 0)
  }
  useEffect(() => { if (pop.open && pop.hi >= 0) scrollTo(`${p.id}-o${pop.hi}`) }, [pop.open, pop.hi, p.id])
  const onBtnKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!pop.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openUp(); return }
    if (navKey(e, pop, list, pick, close)) return
    if (e.key === ' ' && pop.open && list[pop.hi]) { e.preventDefault(); pick(list[pop.hi]!); return }
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !withSearch) {   // typeahead
      const i = pop.typeahead(e.key, list)
      if (i >= 0) { if (!pop.open) pop.setOpen(true); pop.setHi(i) }
    }
  }
  const active = pop.open && list[pop.hi] ? `${p.id}-o${pop.hi}` : undefined
  return <div className="tf-select" data-part="select" data-open={pop.open ? '' : undefined} ref={root}>
    <button ref={btn} type="button" className="tf-input tf-select-trigger" id={p.id} disabled={p.disabled}
      aria-haspopup="listbox" aria-expanded={pop.open} aria-controls={`${p.id}-list`} aria-activedescendant={withSearch ? undefined : active}
      aria-invalid={p.invalid || undefined} aria-describedby={p.describedBy} aria-required={p.required || undefined}
      onClick={() => (pop.open ? close() : openUp())} onKeyDown={onBtnKey}>
      <span className={p.value ? 'tf-select-value' : 'tf-select-value tf-placeholder'}>{p.value?.label ?? p.placeholder ?? 'Select…'}</span>
      {Icon.chevron()}
    </button>
    {p.value && !p.required && !p.disabled && <button type="button" className="tf-select-clear" aria-label={`Clear ${p.label}`} onClick={() => { p.onChange(null); btn.current?.focus() }}>{Icon.x()}</button>}
    <div className="tf-pop" hidden={!pop.open}>
      {withSearch && <div className="tf-pop-search">{Icon.search()}
        <input ref={box} className="tf-pop-input" type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={pop.open}
          aria-controls={`${p.id}-list`} aria-activedescendant={active} aria-label={`Search ${p.label}`} placeholder="Search…" value={pop.q}
          onKeyDown={(e) => navKey(e, pop, list, pick, close)}
          onChange={(e) => { pop.setQ(e.target.value); pop.setOpen(true); pop.setHi(0); if (async) remote.run(e.target.value) }} /></div>}
      <Options id={p.id} list={list} hi={pop.hi} setHi={pop.setHi} isOn={(v) => p.value?.value === v} pick={pick} label={p.label}
        loading={async && remote.loading} more={async && remote.more} onMore={() => remote.run(pop.q, remote.page + 1)}
        empty={async && !pop.q ? 'Type to search' : 'No matches'} />
    </div>
    {/* form / headless parity: the same value on a native control */}
    <select className="tf-sr-only" tabIndex={-1} aria-hidden="true" name={p.name} disabled={p.disabled} value={p.value?.value ?? ''}
      onChange={(e) => p.onChange(e.target.value ? (local.find((o) => o.value === e.target.value) ?? { value: e.target.value, label: e.target.value }) : null)}>
      <option value="" />
      {(async ? (p.value ? [p.value] : []) : local).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
}

// ---- multi select: chips + inline search + popup listbox (stays open while picking) ----
export function MultiSelect(p: Common & { options?: Opt[]; value: Opt[]; onChange(v: Opt[]): void; max?: number }) {
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
  const pop = usePopup(root), remote = useRemote(p.search)
  const local = p.options ?? [], async = !!p.search && !p.options
  const list = async ? remote.res : local.filter(match(pop.q))
  const on = new Set(p.value.map((o) => o.value)), full = p.max != null && p.value.length >= p.max
  const toggle = (o: Opt) => {
    if (on.has(o.value)) p.onChange(p.value.filter((x) => x.value !== o.value))
    else if (!full) p.onChange([...p.value, o])
  }
  const close = () => { pop.setOpen(false); pop.setQ('') }
  const openUp = () => { if (p.disabled) return; if (!pop.open) { pop.setOpen(true); pop.setHi(0); if (async) remote.run(pop.q) } }
  useEffect(() => { if (pop.open && pop.hi >= 0) scrollTo(`${p.id}-o${pop.hi}`) }, [pop.open, pop.hi, p.id])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !pop.q && p.value.length) { e.preventDefault(); p.onChange(p.value.slice(0, -1)); return }
    if (!pop.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openUp(); return }
    navKey(e, pop, list, toggle, close)
  }
  const active = pop.open && list[pop.hi] ? `${p.id}-o${pop.hi}` : undefined
  const count = `${p.value.length}${p.max != null ? `/${p.max}` : ''}`
  return <div className="tf-multi" data-part="multi" data-open={pop.open ? '' : undefined} data-full={full ? '' : undefined} ref={root}>
    <div className="tf-input tf-multi-box" data-disabled={p.disabled ? '' : undefined} aria-invalid={p.invalid || undefined}
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); openUp() } }}>
      <ul className="tf-chips" aria-label={`${p.label} selected`}>
        {p.value.map((o) => <li key={o.value} className="tf-chip" data-value={o.value}>{o.label}
          {!p.disabled && <button type="button" className="tf-chip-x" aria-label={`Remove ${o.label}`} tabIndex={-1}
            onClick={() => p.onChange(p.value.filter((x) => x.value !== o.value))}>{Icon.x()}</button>}</li>)}
      </ul>
      <input ref={input} className="tf-multi-input" id={p.id} type="text" role="combobox" autoComplete="off" aria-autocomplete="list"
        aria-expanded={pop.open} aria-controls={`${p.id}-list`} aria-activedescendant={active} aria-describedby={p.describedBy}
        aria-invalid={p.invalid || undefined} disabled={p.disabled} placeholder={p.value.length ? '' : full ? '' : 'Search or pick…'} value={pop.q}
        onFocus={openUp} onClick={openUp} onKeyDown={onKey}
        onChange={(e) => { pop.setQ(e.target.value); pop.setOpen(true); pop.setHi(0); if (async) remote.run(e.target.value) }} />
      <span className="tf-count" title={`${p.value.length} selected`} aria-hidden="true">{count}</span>
      {Icon.chevron()}
    </div>
    <span className="tf-sr-only" aria-live="polite">{p.value.length} selected{full ? ', limit reached' : ''}</span>
    <div className="tf-pop" hidden={!pop.open}>
      {!async && local.length > 1 && <div className="tf-pop-head">
        <button type="button" className="tf-link" disabled={p.max != null && local.length > p.max} onMouseDown={(e) => e.preventDefault()}
          onClick={() => p.onChange([...p.value, ...local.filter((o) => !on.has(o.value))])}>Select all</button>
        <button type="button" className="tf-link" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onChange([])}>None</button>
        {p.max != null && <span className="tf-muted">max {p.max}</span>}
      </div>}
      <Options id={p.id} list={list} hi={pop.hi} setHi={pop.setHi} isOn={(v) => on.has(v)} pick={toggle} multi label={p.label}
        loading={async && remote.loading} more={async && remote.more} onMore={() => remote.run(pop.q, remote.page + 1)}
        empty={async && !pop.q ? 'Type to search' : 'No matches'} />
    </div>
    {!async && <select className="tf-sr-only" tabIndex={-1} aria-hidden="true" multiple name={p.name} disabled={p.disabled} value={[...on]}
      onChange={(e) => p.onChange([...e.target.selectedOptions].map((x) => local.find((o) => o.value === x.value)!).filter(Boolean))}>
      {local.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>}
  </div>
}

// ---- file / image: drop zone → card with thumbnail or icon, name, size, replace / remove ----
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const isFile = (v: unknown): v is File => typeof File !== 'undefined' && v instanceof File
const fileName = (v: any): string => (isFile(v) ? v.name : typeof v === 'string' ? decodeURIComponent(v.split('/').pop()!.split('?')[0]!) : v?.name ?? v?.url ?? '')
const fileUrl = (v: any): string | undefined => (typeof v === 'string' ? v : v?.url)

export function FileDrop(p: { id: string; name: string; label: string; describedBy?: string; invalid: boolean; disabled: boolean; required: boolean
  image: boolean; accept?: string; maxBytes?: number; value: any; onChange(v: File | null): void; check(f: File): string | undefined }) {
  const v = p.value, inp = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string>(), [over, setOver] = useState(false), [preview, setPreview] = useState<string>()
  useEffect(() => {
    if (!p.image || !isFile(v) || typeof URL.createObjectURL !== 'function') return setPreview(undefined)
    const u = URL.createObjectURL(v); setPreview(u); return () => URL.revokeObjectURL(u)
  }, [v, p.image])
  const take = (f?: File | null) => { if (!f) return; const e = p.check(f); setErr(e); if (!e) p.onChange(f) }
  const src = preview ?? (p.image ? fileUrl(v) : undefined), url = !isFile(v) ? fileUrl(v) : undefined
  const hint = [p.accept && p.accept !== '*' && p.accept.replace(/image\/\*/g, 'images').replace(/application\//g, '').replace(/,/g, ', '), p.maxBytes && `up to ${fmtSize(p.maxBytes)}`].filter(Boolean).join(' · ')
  const drop = p.disabled ? {} : {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true) }, onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]) },
  }
  return <div className="tf-file" data-part="file" data-filled={v ? '' : undefined} data-over={over ? '' : undefined} data-invalid={err ? '' : undefined} {...drop}>
    {v ? <div className="tf-file-card">
      {src ? <img className="tf-preview" src={src} alt="" /> : <span className="tf-file-icon">{Icon.file()}</span>}
      <div className="tf-file-meta">
        <span className="tf-file-name">{url ? <a href={url} target="_blank" rel="noreferrer">{fileName(v)}</a> : fileName(v)}</span>
        <span className="tf-file-size">{isFile(v) ? `${fmtSize(v.size)} · ready to upload on save` : 'Current file'}</span>
      </div>
      {!p.disabled && <div className="tf-file-actions">
        <button type="button" className="tf-btn tf-btn-ghost" onClick={() => inp.current?.click()}>Replace</button>
        {!p.required && <button type="button" className="tf-btn tf-btn-ghost tf-btn-danger" onClick={() => { setErr(undefined); p.onChange(null) }}>Remove</button>}
      </div>}
    </div>
      : <label htmlFor={p.id} className="tf-drop">
        <span className="tf-drop-icon">{Icon.upload()}</span>
        <span><span className="tf-drop-cta">Click to upload</span> or drag and drop</span>
        {hint && <span className="tf-drop-hint">{hint}</span>}
      </label>}
    <input ref={inp} className="tf-file-input tf-sr-only" type="file" id={p.id} name={p.name} accept={p.accept} disabled={p.disabled}
      required={p.required && !v} aria-invalid={p.invalid || !!err || undefined} aria-describedby={p.describedBy}
      onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
    {err && <p className="tf-hint tf-hint-error" role="alert" data-part="file-error">{err}</p>}
  </div>
}
