'use client'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog, Drawer, toast } from 'tvine/widgets'
import { safeHref } from 'tvine/forms'
import { href, listParams, queryOf, toggleSort, urlFor } from './routes.js'
import type { ActionMeta, ActionResult, DeletePreview, Display, Facet, FilterMeta, ListResult, ModelMeta, Row } from './types.js'
import { Empty, ErrorBox, Icon, cap, PlainForm, Region, Skeleton, Slotted, cx, slotClass, useAdmin } from './ui.js'
import { ChartStrip } from './dashboard.js'
import { DeleteTree } from './pages.js'

// A list cell as Django shows it: choice labels (get_FOO_display), money with its currency, local dates.
export function show(v: Display | undefined, empty = '—', f?: { kind?: string; choices?: { value: string; label: string }[] }): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-muted">{empty}</span>
  if (typeof v === 'boolean') return <span className={v ? 'text-ok' : 'text-danger'} aria-label={v ? 'Yes' : 'No'}><Icon name={v ? 'check' : 'x'} /></span>
  if (typeof v === 'object') {
    const m = v as unknown as { value?: unknown; currency?: unknown }
    if (typeof m.value === 'number' && typeof m.currency === 'string') {
      try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency }).format(m.value) } catch { return `${m.value} ${m.currency}` }
    }
    const to = safeHref(v.href)   // app-code hrefs: same SAFE rule as rich text (no javascript:/data:, no //x)
    return to ? <a href={to} className="text-accent hover:underline" {...(/^https?:/i.test(to) && { rel: 'noopener noreferrer nofollow' })}>{v.text}</a> : v.text
  }
  const label = f?.choices?.find((c) => c.value === String(v))?.label
  if (label) return label
  if (typeof v === 'string' && (f?.kind === 'datetime' || f?.kind === 'date')) {
    const d = new Date(v)
    if (!isNaN(+d)) return <time dateTime={v}>{f.kind === 'date' ? d.toLocaleDateString() : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
  }
  return String(v)
}
const raw = (v: Display | undefined) => (v && typeof v === 'object' ? (v.value ?? v.text) : v)

export function Changelist({ meta, list, error }: { meta: ModelMeta; list?: ListResult; error?: { code: string; message: string } }) {
  const ctx = useAdmin()
  const { query, setQuery, prefs, call, base, navigate, refresh } = ctx
  const d = meta.display
  const p = listParams(meta.key, query)
  const ordering = p.ordering ?? []
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allPages, setAllPages] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  useEffect(() => { setHidden(prefs.get<string[]>(`cols:${meta.key}`, [])) }, [meta.key])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected(new Set()); setAllPages(false) }, [list])
  const cols = d.listDisplay.filter((c) => !hidden.includes(c.name))
  const links = d.listDisplayLinks?.length ? d.listDisplayLinks : [cols[0]?.name]
  const rows = list?.rows ?? []
  const set = (patch: Record<string, string | undefined>) => {
    const next = { ...query, ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k]
    if (!('p' in patch)) delete next.p
    setQuery(next as Record<string, string>)
  }
  const activeFilters = Object.keys(p.filters ?? {}).length
  const modelUrls = (meta.urls ?? []).filter((u) => !u.path.includes('<'))

  const filters = (id: string) => <Filters id={id} meta={meta} facets={list?.facets} onPick={() => setFiltersOpen(false)} set={set} />
  return (
    <Slotted slot="changelist" meta={meta}>
      <Region id="admin:changelist" label={meta.namePlural} state={{ count: list?.count ?? 0, page: list?.page ?? 1, selected: allPages ? list?.count ?? 0 : selected.size }} className={slotClass('changelist')}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{cap(meta.namePlural)}</h1>
          {list && <span className="tva-chip">{list.count.toLocaleString()}</span>}
          <div className="flex-1" />
          {modelUrls.map((u) => <a key={u.name} href={urlFor(base, meta.key, u.path, {})} agentId={`url-${u.name}`} onClick={(e) => { e.preventDefault(); navigate(urlFor(base, meta.key, u.path, {})) }} className="tva-btn">{u.title}</a>)}
          {meta.perms.add && <a href={href(base, { name: 'add', model: meta.key })} agentId="add" onClick={(e) => { e.preventDefault(); navigate(href(base, { name: 'add', model: meta.key })) }} className="tva-btn tva-btn-primary"><Icon name="plus" />Add {meta.name}</a>}
        </div>
        <ChartStrip model={meta.key} filters={p.filters} />

        <div className="flex gap-5">
          <div className="min-w-0 flex-1">
            <div className="tva-card overflow-hidden">
              <Toolbar meta={meta} total={list?.count} activeFilters={activeFilters} hidden={hidden}
                setHidden={(h) => { setHidden(h); prefs.set(`cols:${meta.key}`, h) }} set={set}
                filterDrawer={d.filters.length > 0 && (
                  <Drawer name="filters" label="Filters" side="right" open={filtersOpen} onOpenChange={setFiltersOpen}
                    trigger={<><Icon name="filter" />Filters{activeFilters > 0 && <span className="tva-chip">{activeFilters}</span>}</>}
                    slots={{ root: { className: 'lg:hidden' }, trigger: { className: 'tva-btn' } }}>
                    <h2 className="mb-3 text-lg font-semibold">Filters</h2>{filters('admin:filters-drawer')}
                  </Drawer>
                )} />
              {d.dateHierarchy && <DateHierarchy field={d.dateHierarchy} facets={list?.facets} set={set} />}
              {d.actions.length > 0 && rows.length > 0 && (
                <ActionBar meta={meta} selected={selected} allPages={allPages} setAllPages={setAllPages} total={list?.count ?? 0} pageRows={rows.length}
                  done={() => { setSelected(new Set()); setAllPages(false); refresh() }} />
              )}
              {error && !list ? <div className="p-4"><ErrorBox error={error} /></div>
                : !list ? <Skeleton rows={8} />
                : rows.length === 0 ? (
                  <Empty title={p.q || activeFilters ? 'No results match' : `No ${meta.namePlural.toLowerCase()} yet`} icon={p.q || activeFilters ? 'search' : 'box'}>
                    {p.q || activeFilters
                      ? <button type="button" agentId="clear-filters" className="tva-btn mt-2" onClick={() => setQuery({})}>Clear search and filters</button>
                      : meta.perms.add && <button type="button" agentId="add-first" className="tva-btn tva-btn-primary mt-2" onClick={() => navigate(href(base, { name: 'add', model: meta.key }))}>Add {meta.name}</button>}
                  </Empty>
                ) : (
                  <EditableTable meta={meta} rows={rows} cols={cols} links={links} ordering={ordering} selected={selected} setSelected={(s) => { setSelected(s); setAllPages(false) }}
                    sort={(c, multi) => set({ o: toggleSort(ordering, c, multi).join(',') })} />
                )}
              {list && list.count > 0 && <Pager list={list} meta={meta} all={!!p.all} set={set} />}
            </div>
          </div>
          {d.filters.length > 0 && (
            <aside className={cx('hidden w-64 shrink-0 lg:block', slotClass('filters'))}>
              <div className="tva-card sticky top-4 p-4">{filters('admin:filters')}</div>
            </aside>
          )}
        </div>
      </Region>
    </Slotted>
  )
}

function Toolbar({ meta, total, activeFilters, hidden, setHidden, set, filterDrawer }: {
  meta: ModelMeta; total?: number; activeFilters: number; hidden: string[]; setHidden(h: string[]): void
  set(p: Record<string, string | undefined>): void; filterDrawer: ReactNode
}) {
  const { query } = useAdmin()
  const [q, setQ] = useState(query.q ?? '')
  useEffect(() => setQ(query.q ?? ''), [query.q])
  const [cols, setCols] = useState(false)
  const searchable = meta.display.search !== false
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
      {searchable && (
        <PlainForm role="search" className="flex min-w-0 flex-1 basis-60 items-center gap-2" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() || undefined }) }}>
          <div className="relative min-w-0 flex-1">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input id="tva-search" type="search" name="q" agentId="search" aria-label={`Search ${meta.namePlural}`} placeholder={`Search ${meta.namePlural.toLowerCase()}…  ( / )`}
              value={q} onChange={(e) => setQ(e.target.value)} className="tva-input pl-8" title={meta.display.searchHelp ?? undefined} />
          </div>
          <button type="submit" agentId="search-go" className="tva-btn">Search</button>
        </PlainForm>
      )}
      {meta.display.searchHelp && <p className="w-full text-xs text-muted sm:order-last">{meta.display.searchHelp}</p>}
      {!searchable && <div className="flex-1" />}
      {filterDrawer}
      {activeFilters > 0 && <button type="button" agentId="reset-filters" className="tva-btn tva-btn-ghost text-muted" onClick={() => set(Object.fromEntries(Object.keys(query).filter((k) => !['q', 'o'].includes(k)).map((k) => [k, undefined])))}><Icon name="x" />Reset</button>}
      <Dialog name="columns" label="Columns" open={cols} onOpenChange={setCols} trigger={<><Icon name="columns" /><span className="hidden sm:inline">Columns</span></>} slots={{ trigger: { className: 'tva-btn' } }}>
        <h2 className="mb-1 text-lg font-semibold">Columns</h2>
        <p className="mb-3 text-sm text-muted">Choose the columns you see. Saved for your account on this browser.</p>
        <div className="grid gap-1">
          {meta.display.listDisplay.map((c) => (
            <label key={c.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
              <input type="checkbox" className="tva-check" agentId={`col-${c.name}`} checked={!hidden.includes(c.name)}
                onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== c.name) : [...hidden, c.name])} />
              {c.label}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end"><button type="button" agentId="cols-done" className="tva-btn tva-btn-primary" onClick={() => setCols(false)}>Done</button></div>
      </Dialog>
      {total !== undefined && <span className="hidden text-xs text-muted md:inline">{total.toLocaleString()} total</span>}
    </div>
  )
}

function EditableTable({ meta, rows, cols, links, ordering, selected, setSelected, sort }: {
  meta: ModelMeta; rows: Row[]; cols: ModelMeta['display']['listDisplay']; links: string[]; ordering: string[]
  selected: Set<string>; setSelected(s: Set<string>): void; sort(col: string, multi: boolean): void
}) {
  const { base, navigate, call, refresh } = useAdmin()
  const editable = (meta.display.listEditable ?? []).filter((f) => meta.perms.change && cols.some((c) => c.name === f))
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({})
  const [errs, setErrs] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => { setEdits({}); setErrs({}) }, [rows])
  const dirty = Object.keys(edits).length
  const hasActions = meta.display.actions.length > 0
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.pk))
  const save = async () => {
    setSaving(true)
    const sent = Object.entries(edits).map(([pk, values]) => ({ pk, values }))
    const r = await call('admin.listEdit', { model: meta.key, rows: sent })
    setSaving(false)
    const fe = !r.ok && r.code === 'invalid_param' ? ((r as { errors?: { field: string; message: string }[] }).errors ?? []) : []
    if (fe.length) {   // `rows.<i>.<field>` → { pk: { field: message } }
      const e: Record<string, Record<string, string>> = {}
      for (const x of fe) { const [, i, f] = x.field.split('.'); const pk = sent[+i!]?.pk; if (pk && f) (e[pk] ??= {})[f] ??= x.message }
      setErrs(e); toast({ kind: 'error', title: 'Some rows have errors', description: 'Fix the highlighted cells and save again.' }); return
    }
    if (!r.ok) { toast({ kind: 'error', title: 'Not saved', description: r.message }); return }
    toast({ kind: 'success', title: `Saved ${dirty} ${dirty === 1 ? meta.name : meta.namePlural}` })
    refresh()
  }
  const sortIdx = (c: string) => ordering.findIndex((o) => o.replace(/^-/, '') === c)
  return (
    <Slotted slot="table" meta={meta}>
      <div className="overflow-x-auto">
        <table className={cx('w-full text-sm', slotClass('table'))}>
          <thead>
            <tr>
              {hasActions && <th className="tva-th w-10"><input type="checkbox" className="tva-check" agentId="select-page" aria-label="Select all on this page" checked={allOnPage}
                onChange={(e) => setSelected(new Set(e.target.checked ? rows.map((r) => r.pk) : []))} /></th>}
              {cols.map((c) => {
                const i = sortIdx(c.name)
                const desc = i >= 0 && ordering[i].startsWith('-')
                return (
                  <th key={c.name} className="tva-th" aria-sort={i === 0 ? (desc ? 'descending' : 'ascending') : undefined}>
                    {c.sortable ? (
                      <button type="button" agentId={`sort-${c.name}`} title="Click to sort; Shift-click adds a secondary sort" onClick={(e) => sort(c.name, e.shiftKey || ordering.length > 0)}
                        className="inline-flex items-center gap-1 uppercase hover:text-fg">
                        {c.label}{i >= 0 && <><Icon name={desc ? 'down' : 'up'} size={12} />{ordering.length > 1 && <sup>{i + 1}</sup>}</>}
                      </button>
                    ) : c.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Region key={r.pk} as="tr" id={`row:${r.pk}`} label={String(raw(r.values[cols[0]?.name]) ?? r.pk)} className="tva-row" data-selected={selected.has(r.pk) ? '' : undefined}>
                {hasActions && <td className="tva-td"><input type="checkbox" className="tva-check" agentId="select" aria-label={`Select ${r.pk}`} checked={selected.has(r.pk)}
                  onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(r.pk) : s.delete(r.pk); setSelected(s) }} /></td>}
                {cols.map((c) => {
                  const err = errs[r.pk]?.[c.name]
                  let cell: ReactNode
                  if (editable.includes(c.name)) {
                    const f = meta.form.fields[c.name]
                    const v = edits[r.pk]?.[c.name] ?? raw(r.values[c.name]) ?? ''
                    const put = (x: unknown) => setEdits((e) => ({ ...e, [r.pk]: { ...e[r.pk], [c.name]: x } }))
                    cell = f?.kind === 'bool'
                      ? <input type="checkbox" className="tva-check" agentId={c.name} aria-label={c.label} checked={!!v} onChange={(e) => put(e.target.checked)} />
                      : f?.choices
                        ? <select agentId={c.name} aria-label={c.label} aria-invalid={!!err} value={String(v)} onChange={(e) => put(e.target.value)} className="tva-input h-8 min-w-28">
                            {f.choices.map((ch) => <option key={ch.value} value={ch.value}>{ch.label}</option>)}
                          </select>
                        : <input agentId={c.name} aria-label={c.label} aria-invalid={!!err} value={String(v)} type={['int', 'decimal', 'money'].includes(f?.kind ?? '') ? 'number' : 'text'}
                            onChange={(e) => put(e.target.value)} className="tva-input h-8 min-w-24" />
                    cell = <>{cell}{err && <p role="alert" className="mt-0.5 text-xs text-danger">{err}</p>}</>
                  } else if (links.includes(c.name)) {
                    const to = href(base, { name: 'change', model: meta.key, pk: r.pk })
                    cell = <a href={to} agentId="open" onClick={(e) => { e.preventDefault(); navigate(to) }} className="font-medium text-accent hover:underline">{show(r.values[c.name], meta.display.emptyValueDisplay, { kind: c.kind, choices: meta.form.fields[c.name]?.choices })}</a>
                  } else cell = show(r.values[c.name], meta.display.emptyValueDisplay, { kind: c.kind, choices: meta.form.fields[c.name]?.choices })
                  return <td key={c.name} className={cx('tva-td', c.kind && ['int', 'decimal', 'money'].includes(c.kind) && 'text-right')}>{cell}</td>
                })}
              </Region>
            ))}
          </tbody>
        </table>
      </div>
      {dirty > 0 && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t border-line bg-surface px-3 py-2">
          <span className="text-sm text-muted">{dirty} changed {dirty === 1 ? 'row' : 'rows'}</span>
          <div className="flex-1" />
          <button type="button" agentId="discard-edits" className="tva-btn" onClick={() => { setEdits({}); setErrs({}) }}>Discard</button>
          <button type="button" agentId="save-edits" className="tva-btn tva-btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </Slotted>
  )
}

function ActionBar({ meta, selected, allPages, setAllPages, total, pageRows, done }: {
  meta: ModelMeta; selected: Set<string>; allPages: boolean; setAllPages(b: boolean): void; total: number; pageRows: number; done(): void
}) {
  const { call, query } = useAdmin()
  const [action, setAction] = useState('')
  const [confirm, setConfirm] = useState<{ a: ActionMeta; preview?: DeletePreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const n = allPages ? total : selected.size
  const target = () => (allPages ? { selectAll: true, filters: listParams(meta.key, query).filters ?? {}, ...(query.q && { q: query.q }) } : { pks: [...selected] })
  const run = async (a: ActionMeta) => {
    setBusy(true)
    const r = a.name === 'deleteSelected' && !allPages
      ? await call('admin.delete', { model: meta.key, pks: [...selected] })
      : await call('admin.action', { model: meta.key, action: a.name, ...target() })
    setBusy(false); setConfirm(null)
    if (!r.ok) { toast({ kind: 'error', title: a.description, description: r.message }); return }
    const res = (r.data ?? {}) as ActionResult & { deleted?: number; protected?: unknown[] }
    if (res.protected?.length) toast({ kind: 'error', title: 'Cannot delete', description: `${res.protected.length} protected related object(s) prevent this.` })
    else toast({ kind: res.level === 'error' || res.level === 'warning' ? 'error' : 'success', title: res.message ?? (res.deleted !== undefined ? `Deleted ${res.deleted} ${res.deleted === 1 ? meta.name : meta.namePlural}` : `${a.description}: done`) })
    if (res.download) download(res.download)
    done()
  }
  const go = async () => {
    const a = meta.display.actions.find((x) => x.name === action)
    if (!a || n === 0) return
    if (a.name === 'deleteSelected') {
      const pv = allPages ? undefined : await call('admin.deletePreview', { model: meta.key, pks: [...selected] })
      setConfirm({ a, preview: pv?.ok ? (pv.data as DeletePreview) : undefined })
    } else if (a.confirm) setConfirm({ a })
    else await run(a)
  }
  const del = confirm?.a.name === 'deleteSelected'
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken/60 px-3 py-2 text-sm">
      <select agentId="action" aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)} className="tva-input h-8 w-auto min-w-48">
        <option value="">Action…</option>
        {meta.display.actions.map((a) => <option key={a.name} value={a.name}>{a.description}</option>)}
      </select>
      <button type="button" agentId="run" className="tva-btn h-8" disabled={!action || n === 0 || busy} onClick={go}>{busy ? 'Running…' : 'Go'}</button>
      <span className="text-muted" aria-live="polite">{n} of {total} selected</span>
      {selected.size === pageRows && total > pageRows && !allPages && (
        <button type="button" agentId="select-all" className="font-medium text-accent hover:underline" onClick={() => setAllPages(true)}>Select all {total.toLocaleString()} {meta.namePlural.toLowerCase()}</button>
      )}
      {allPages && <button type="button" agentId="clear-selection" className="font-medium text-accent hover:underline" onClick={() => setAllPages(false)}>Clear selection</button>}
      <Dialog name="confirm-action" label="Confirm action" open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null) }} slots={{ trigger: { className: 'hidden' } }}>
        {confirm && <>
          <h2 className="pr-8 text-lg font-semibold">{del ? `Delete ${n} ${n === 1 ? meta.name : meta.namePlural}?` : confirm.a.description}</h2>
          <p className="mt-1 text-muted">{typeof confirm.a.confirm === 'string' ? confirm.a.confirm : del ? 'These objects and the related objects below will be deleted.' : `Run “${confirm.a.description}” on ${n} selected ${n === 1 ? meta.name : meta.namePlural}?`}</p>
          {confirm.preview && <div className="mt-3 max-h-64 overflow-auto rounded-md border border-line p-3"><DeleteTree preview={confirm.preview} /></div>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" agentId="cancel" className="tva-btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" agentId="confirm" disabled={busy || !!confirm.preview?.protected?.length} className={cx('tva-btn', del ? 'tva-btn-danger-solid' : 'tva-btn-primary')} onClick={() => run(confirm.a)}>{del ? 'Yes, delete' : 'Confirm'}</button>
          </div>
        </>}
      </Dialog>
    </div>
  )
}

export function download(d: NonNullable<ActionResult['download']>) {
  const o = typeof d === 'string' ? { url: d } : d
  const url = o.url ?? URL.createObjectURL(new Blob([o.data ?? ''], { type: o.contentType ?? 'text/plain' }))
  const a = document.createElement('a')
  a.href = url; a.download = o.filename ?? ''; a.rel = 'noopener'
  document.body.append(a); a.click(); a.remove()
}

function Filters({ id, meta, facets, set, onPick }: { id: string; meta: ModelMeta; facets?: Record<string, Facet[]>; set(p: Record<string, string | undefined>): void; onPick(): void }) {
  const { query, prefs } = useAdmin()
  const [saved, setSaved] = useState<{ name: string; query: Record<string, string> }[]>([])
  useEffect(() => { setSaved(prefs.get(`saved:${meta.key}`, [])) }, [meta.key])   // eslint-disable-line react-hooks/exhaustive-deps
  const [name, setName] = useState('')
  const store = (s: typeof saved) => { setSaved(s); prefs.set(`saved:${meta.key}`, s) }
  const pick = (k: string, v: string | undefined) => { set({ [k]: v }); onPick() }
  return (
    <Region id={id} label="Filters" className="flex flex-col gap-5">
      {meta.display.filters.map((f) => <FilterGroup key={f.name} f={f} facets={facets?.[f.name]} value={query[f.name]} pick={(v) => pick(f.name, v)} />)}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted"><Icon name="bookmark" size={13} />Saved filters</h3>
        {saved.length === 0 && <p className="text-xs text-muted">Save the current search and filters to reuse them.</p>}
        <ul className="flex flex-col gap-0.5">
          {saved.map((s) => (
            <li key={s.name} className="flex items-center gap-1">
              <button type="button" agentId={`saved-${s.name}`} className="flex-1 truncate rounded-md px-2 py-1 text-left hover:bg-sunken" onClick={() => { set({ ...Object.fromEntries(Object.keys(query).map((k) => [k, undefined])), ...s.query }); onPick() }}>{s.name}</button>
              <button type="button" agentId={`unsave-${s.name}`} aria-label={`Remove ${s.name}`} className="rounded p-1 text-muted hover:text-danger" onClick={() => store(saved.filter((x) => x !== s))}><Icon name="x" size={13} /></button>
            </li>
          ))}
        </ul>
        <PlainForm className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { store([...saved.filter((x) => x.name !== name.trim()), { name: name.trim(), query: { ...query } }]); setName('') } }}>
          <input agentId="saved-name" aria-label="Saved filter name" placeholder="Name…" value={name} onChange={(e) => setName(e.target.value)} className="tva-input h-8 text-[13px]" />
          <button type="submit" agentId="save-filter" className="tva-btn h-8 px-2.5">Save</button>
        </PlainForm>
      </div>
    </Region>
  )
}

const DATE_CHOICES = [{ value: 'today', label: 'Today' }, { value: 'past7', label: 'Past 7 days' }, { value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }]
function FilterGroup({ f, facets, value, pick }: { f: FilterMeta; facets?: Facet[]; value?: string; pick(v: string | undefined): void }) {
  const opts: { value: string; label: string; count?: number }[] = facets ?? f.choices
    ?? (f.kind === 'boolean' ? [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] : f.kind === 'date' ? DATE_CHOICES : [])
  const item = (v: string | undefined, label: string, count?: number) => {
    const on = (value ?? undefined) === v
    return (
      <li key={v ?? '_all'}>
        <button type="button" agentId={`${f.name}-${v ?? 'all'}`} aria-pressed={on} onClick={() => pick(v)}
          className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left', on ? 'bg-brand-soft font-medium text-accent' : 'hover:bg-sunken')}>
          <span className="flex-1 truncate">{label}</span>{count !== undefined && <span className="text-xs text-muted tabular-nums">{count}</span>}
        </button>
      </li>
    )
  }
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">By {f.label}</h3>
      <ul className="flex flex-col gap-0.5 text-[13px]">
        {item(undefined, 'All')}
        {opts.map((o) => item(String(o.value), o.label, 'count' in o ? o.count : undefined))}
      </ul>
    </div>
  )
}

// Django date_hierarchy: year → month → day drill-down, chips from the list's facets (`<field>__year|month|day`).
function DateHierarchy({ field, facets, set }: { field: string; facets?: Record<string, Facet[]>; set(p: Record<string, string | undefined>): void }) {
  const { query } = useAdmin()
  const y = query[`${field}__year`], m = query[`${field}__month`], dd = query[`${field}__day`]
  const level = !y ? 'year' : !m ? 'month' : !dd ? 'day' : null
  const opts = level ? facets?.[`${field}__${level}`] ?? [] : []
  const up = !y ? null : !m ? { [`${field}__year`]: undefined } : !dd ? { [`${field}__month`]: undefined } : { [`${field}__day`]: undefined }
  if (!y && opts.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-2 text-[13px]" aria-label="Date drill-down">
      <Icon name="clock" className="text-muted" />
      {up && <button type="button" agentId="date-up" className="tva-btn h-7 px-2" onClick={() => set(up)}>‹ {[y, m, dd].filter(Boolean).join('-')}</button>}
      {opts.map((o) => (
        <button key={o.value} type="button" agentId={`date-${o.value}`} className="tva-btn h-7 px-2" onClick={() => set({ [`${field}__${level}`]: o.value })}>
          {o.label}<span className="text-xs text-muted">{o.count}</span>
        </button>
      ))}
    </div>
  )
}

function Pager({ list, meta, all, set }: { list: ListResult; meta: ModelMeta; all: boolean; set(p: Record<string, string | undefined>): void }) {
  const pages = useMemo(() => {
    const out: (number | '…')[] = []
    for (let i = 1; i <= list.pages; i++) {
      if (i === 1 || i === list.pages || Math.abs(i - list.page) <= 1) out.push(i)
      else if (out[out.length - 1] !== '…') out.push('…')
    }
    return out
  }, [list.page, list.pages])
  const canAll = list.count <= (meta.display.listMaxShowAll ?? 200)
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1 px-3 py-2.5 text-sm">
      <span className="mr-auto text-muted">{all ? `All ${list.count}` : `Page ${list.page} of ${list.pages}`} · {list.count.toLocaleString()} {list.count === 1 ? meta.name : meta.namePlural}</span>
      {!all && list.pages > 1 && <>
        <button type="button" agentId="prev" className="tva-btn h-8 px-2.5" disabled={list.page <= 1} onClick={() => set({ p: String(list.page - 1) })}>‹ Prev</button>
        {pages.map((n, i) => n === '…' ? <span key={`e${i}`} className="px-1 text-muted">…</span> : (
          <button key={n} type="button" agentId={`page-${n}`} aria-current={n === list.page ? 'page' : undefined} onClick={() => set({ p: String(n) })}
            className={cx('tva-btn h-8 min-w-8 px-2', n === list.page && 'tva-btn-primary')}>{n}</button>
        ))}
        <button type="button" agentId="next" className="tva-btn h-8 px-2.5" disabled={list.page >= list.pages} onClick={() => set({ p: String(list.page + 1) })}>Next ›</button>
      </>}
      {list.pages > 1 && canAll && !all && <button type="button" agentId="show-all" className="tva-btn tva-btn-ghost h-8" onClick={() => set({ all: '1', p: undefined })}>Show all</button>}
      {all && <button type="button" agentId="paginate" className="tva-btn tva-btn-ghost h-8" onClick={() => set({ all: undefined })}>Paginate</button>}
    </nav>
  )
}
export { queryOf }
