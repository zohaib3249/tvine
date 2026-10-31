'use client'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import { useWidget } from '../widget/useWidget.js'
import { WeftError } from '../widget/hooks.js'
import type { ActionHandle, Control, ControlCtx, Json } from '../widget/types.js'
import type { Paginated } from '../types.js'
import { agentNavigate } from '../runtime/nav.js'
import { submitForm } from '../runtime/submit.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, useControllable, type Slots, type SlotProps } from './_parts.js'

// widgets/table.md: native <table>. Sort / filter / next page are real links to the ListView query params
// (`?sort=-price`, `?<field>=v`, `?cursor=`), so the headless `url` map and the in-tab click land on the same URL
// and the server returns the same rows. Each rendered row registers as an entity (`order:7`) under a
// `list:rows` widget, so the W2 shaper prints them as cols/rows with ×N row-control lines. Virtual mode
// mounts (and registers) only the visible window; the table's state carries count + offset + cursor.
// Bulk actions are `do` calls with the selected ids; their `danger` reaches the hooks as metadata, never a refusal.
// ponytail: no 'range' filter, no client-side sort, no APG grid mode, no select-all; add when a page needs them.
type C = Record<string, Control<any, any>>
type Sort = { column: string; dir: 'asc' | 'desc' }
type S = { sort?: Sort; filters?: Record<string, string>; selected?: string[]; count: number; offset?: number; cursor?: string }
export type TableColumn<T> = { key: string; header: string; sortable?: boolean; filter?: 'text' | { enum: string[] }; cell?(t: T): ReactNode }
export type TableBulk = { name: string; label: string; action: ActionHandle; param?: string; confirm?: boolean | string; onRun?(ids: string[]): void | Promise<void> }
export type TableProps<T = any> = {
  name: string; label: string
  rows: T[] | Paginated<T>; rowId(t: T): string; entity?: string
  columns: TableColumn<T>[]
  sort?: Sort; onSortChange?(s: Sort): void
  filters?: Record<string, string>; onFiltersChange?(f: Record<string, string>): void
  selection?: 'none' | 'single' | 'multiple'; selected?: string[]; defaultSelected?: string[]; onSelectedChange?(ids: string[]): void
  bulk?: TableBulk[]
  query?: string                                   // current search string to keep in links (e.g. "status=paid")
  url?: { sort?: string; cursor?: string; filters?: Record<string, string> }   // ListView param names by default
  virtual?: { rowHeight: number; height?: number }
  className?: SlotProps<S>['className']
  slots?: Slots<'root' | 'toolbar' | 'table' | 'header' | 'headerCell' | 'body' | 'row' | 'cell' | 'footer', S>
}
type Inner = TableProps & { start: number; scrollTo(i: number): void; sel: { current: string[] } }

const itemsOf = <T,>(r: T[] | Paginated<T>) => (Array.isArray(r) ? r : r.items)
const sortParam = (p: TableProps) => p.url?.sort ?? 'sort'
const cursorParam = (p: TableProps) => p.url?.cursor ?? 'cursor'
const filterParam = (p: TableProps, key: string) => p.url?.filters?.[key] ?? key
// Same page, one param changed (undefined = removed); a new sort or filter starts again at the first page.
const hrefWith = (p: TableProps, k: string, v: string | undefined) => {
  const q = new URLSearchParams(p.query)
  if (k !== cursorParam(p)) q.delete(cursorParam(p))
  if (v === undefined || v === '') q.delete(k); else q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : '?'
}
const sortValue = (s: Sort) => (s.dir === 'desc' ? `-${s.column}` : s.column)
const sortOf = (v: string): Sort => (v.startsWith('-') ? { column: v.slice(1), dir: 'desc' } : { column: v, dir: 'asc' })

// Click the matching link when it is on screen (app onClick runs); else fire the handler and navigate.
async function go(href: string, ctx: ControlCtx, a: HTMLAnchorElement | null | undefined, handler?: () => void) {
  if (!a) handler?.()
  await agentNavigate(href, ctx.signal, a ? () => a.click() : undefined)
}

const useTable = defineWidget<Inner, S, C>({
  kind: 'table',
  state: (p) => {
    const f = Object.fromEntries(Object.entries(p.filters ?? {}).filter(([, v]) => v !== undefined && v !== ''))
    const next = Array.isArray(p.rows) ? undefined : p.rows.nextCursor
    return {
      ...(p.sort && { sort: p.sort }), ...(Object.keys(f).length && { filters: f }),
      ...(p.selection && p.selection !== 'none' && { selected: p.selected ?? [] }),
      count: Array.isArray(p.rows) ? p.rows.length : p.rows.total ?? p.rows.items.length,
      ...(p.virtual && { offset: p.start }), ...(next && { cursor: next }),
    }
  },
  controls: ({ props: p, el }) => {
    const items = itemsOf(p.rows), ids = items.map(p.rowId)
    const a = (sel: string) => el()?.querySelector<HTMLAnchorElement>(sel)
    const c: C = {}
    const sortable = p.columns.filter((x) => x.sortable).flatMap((x) => [x.key, `-${x.key}`])
    if (sortable.length) c.sort = { kind: 'select', params: { by: { type: 'string', enum: sortable } },
      run: (x: { by: string }, ctx) => go(hrefWith(p, sortParam(p), x.by), ctx, a(`a[data-sort-to="${CSS.escape(x.by)}"]`), () => p.onSortChange?.(sortOf(x.by))) }
    for (const col of p.columns) {
      if (!col.filter) continue
      const enumOf = typeof col.filter === 'object' ? col.filter.enum : undefined
      c[`filter_${col.key}`] = { kind: 'select', params: { value: { type: 'string', ...(enumOf && { enum: enumOf }) } },
        run: (x: { value: string }, ctx) => go(hrefWith(p, filterParam(p, col.key), x.value), ctx,
          enumOf && a(`a[data-filter="${CSS.escape(col.key)}"][data-value="${CSS.escape(x.value)}"]`),
          () => p.onFiltersChange?.({ ...p.filters, [col.key]: x.value })) }
    }
    const next = Array.isArray(p.rows) ? undefined : p.rows.nextCursor
    if (next) c.next = { kind: 'navigate', params: { cursor: { type: 'string', enum: [next] } },
      run: (_: unknown, ctx) => go(hrefWith(p, cursorParam(p), next), ctx, a('a[rel=next]')) }
    if (p.selection && p.selection !== 'none') {
      // Through the real row checkboxes (rendered rows only: a virtual table scrolls first).
      const shown = () => [...(el()?.querySelectorAll<HTMLInputElement>('input[data-row]') ?? [])].map((i) => i.dataset.row!)
      c.select = { kind: 'select', params: { rows: { type: 'string', enum: ids, multiple: true } },
        run: async (x: { rows: string[] }, ctx) => {
          if (p.selection === 'single' && x.rows.length > 1) throw invalid('rows', 'this table selects one row')
          for (const id of x.rows) if (!shown().includes(id)) throw invalid('rows', `row ${id} is not on screen; scroll to it first`)
          for (const id of new Set([...p.sel.current, ...x.rows])) {
            if (p.sel.current.includes(id) !== x.rows.includes(id) && shown().includes(id)) inner<HTMLInputElement>(ctx, el(), `input[data-row="${CSS.escape(id)}"]`).click()
          }
        } }
    }
    for (const b of p.bulk ?? []) {
      const param = b.param ?? 'ids'
      c[`bulk_${b.name}`] = { kind: 'submit', label: b.label, enabled: b.action.agent, ...(b.confirm && { confirm: b.confirm }),
        params: { [param]: { type: 'string', enum: ids, multiple: true, optional: true } },
        run: async (x: Record<string, string[] | undefined>, ctx) => {
          const sel = x[param] ?? p.sel.current
          if (!sel.length) throw invalid(param, 'select rows first')
          const r = await ctx.run(b.action, { [param]: sel })
          if (!r.ok) throw new WeftError(r.code, r.message, undefined, r.field)
          return r as unknown as Json
        } }
    }
    if (p.virtual) c.scroll = { kind: 'scroll', params: { to: { type: 'number', min: 0, max: Math.max(0, items.length - 1), step: 1 } },
      run: (x: { to: number }) => { if (!Number.isInteger(x.to)) throw invalid('to', 'to must be a whole number'); p.scrollTo(x.to) } }
    return c
  },
  headless: (p) => {
    const m: Record<string, ReturnType<typeof headlessOf>> = { sort: headlessOf({ url: sortParam(p), name: p.name }), next: headlessOf({ url: cursorParam(p), name: p.name }) }
    for (const col of p.columns) if (col.filter) m[`filter_${col.key}`] = headlessOf({ url: filterParam(p, col.key), name: p.name }, typeof col.filter === 'object' ? 'enum' : 'any')
    // Selection lives in the bulk action's params (ids[]); each bulk control is that action's `do`.
    if (p.bulk?.[0]) m.select = { params: p.bulk[0].action, field: p.bulk[0].param ?? 'ids' }
    for (const b of p.bulk ?? []) m[`bulk_${b.name}`] = { params: b.action }
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v)) as Record<string, NonNullable<ReturnType<typeof headlessOf>>>
  },
  describe: (p) => ({ label: p.label }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

// One rendered row = one entity node (`order:7`); its cells' own widgets scope under it.
function Row<T>({ t, p, on, toggle, s }: { t: T; p: TableProps<T> & { disabled?: boolean }; on: boolean; toggle(id: string): void; s: S }) {
  const id = p.rowId(t), rec = t as Record<string, unknown>
  const data = Object.fromEntries(p.columns.map((c) => [c.key, rec[c.key] ?? null]))
  const label = String(data.name ?? data.title ?? id)   // only published column values (never a field the app left out)
  const w = useWidget({ kind: 'data', label, data, ...(p.entity ? { entity: `${p.entity}:${id}` } : { id: `row:${id}` }) })
  const pick = p.selection && p.selection !== 'none'
  return part('tr', { ref: w.ref, ...w.props, 'aria-selected': pick ? on : undefined, 'data-state': on ? 'selected' : undefined, style: p.virtual && { height: p.virtual.rowHeight } }, p.slots?.row, s, <>
    {w.embed}
    {pick && <td><AutoOff><input type="checkbox" data-row={id} checked={on} aria-label={`Select ${label}`} disabled={p.disabled} onChange={() => toggle(id)} /></AutoOff></td>}
    <w.Scope>{p.columns.map((c) => part('td', { key: c.key }, p.slots?.cell, s, c.cell ? c.cell(t) : String(rec[c.key] ?? '')))}</w.Scope>
  </>)
}

function Body<T>({ p, items, start, end, toggle, sel, s }: { p: TableProps<T> & { disabled?: boolean }; items: T[]; start: number; end: number; toggle(id: string): void; sel: string[]; s: S }) {
  const w = useWidget({ kind: 'list', name: 'rows', label: p.label })
  const h = p.virtual?.rowHeight ?? 0, span = p.columns.length + (p.selection && p.selection !== 'none' ? 1 : 0)
  return part('tbody', { ref: w.ref, ...w.props }, p.slots?.body, s, <>
    {w.embed}
    {start > 0 && <tr aria-hidden style={{ height: start * h }}><td colSpan={span} /></tr>}
    <w.Scope>{items.slice(start, end).map((t) => { const id = p.rowId(t); return <Row key={id} t={t} p={p} on={sel.includes(id)} toggle={toggle} s={s} /> })}</w.Scope>
    {end < items.length && <tr aria-hidden style={{ height: (items.length - end) * h }}><td colSpan={span} /></tr>}
  </>)
}

export function Table<T>(props: DefinedProps<TableProps<T>, C>) {
  const { label, columns, sort, filters, selection = 'none', selected, defaultSelected, onSelectedChange, bulk, virtual, disabled, className, slots } = props
  const items = itemsOf(props.rows)
  const [sel, setSel] = useControllable<string[]>(selected, defaultSelected ?? [])
  const latest = useRef(sel); latest.current = sel
  const [start, setStart] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const per = virtual ? Math.ceil((virtual.height ?? virtual.rowHeight * 10) / virtual.rowHeight) + 1 : items.length
  const scrollTo = (i: number) => { const n = Math.max(0, Math.min(i, items.length - 1)); setStart(n); if (box.current) box.current.scrollTop = n * virtual!.rowHeight }
  const w = useTable({ ...props, selection, selected: sel, start, scrollTo, sel: latest } as Inner)
  const s = w.state
  // A ref, not the render's value: several agent clicks in one tick each see the previous one.
  const toggle = (id: string) => {
    const cur = latest.current
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : selection === 'single' ? [id] : [...cur, id]
    latest.current = next; setSel(next); onSelectedChange?.(next)
  }
  const runBulk = async (b: TableBulk) => {
    const ids = latest.current
    if (b.confirm && !window.confirm(typeof b.confirm === 'string' ? b.confirm : `${b.label}: ${ids.length} selected?`)) return
    if (b.onRun) await b.onRun(ids)
    else await submitForm({ action: b.action.id, bind: b.action.bind || undefined, params: { [b.param ?? 'ids']: ids } })
  }
  const filterBar = columns.filter((c) => c.filter).map((c) => {
    const cur = filters?.[c.key] ?? '', k = filterParam(props, c.key)
    if (typeof c.filter === 'object') return <span key={c.key} role="group" aria-label={c.header}>
      {['', ...c.filter.enum].map((v) => <a key={v} href={hrefWith(props, k, v)} data-filter={c.key} data-value={v} aria-current={v === cur || undefined}
        onClick={() => props.onFiltersChange?.({ ...filters, [c.key]: v })}>{v || 'All'}</a>)}
    </span>
    // Native GET form: the other params ride along as hidden inputs.
    const keep = [...new URLSearchParams(props.query)].filter(([q]) => q !== k && q !== cursorParam(props))
    return <form key={c.key} method="get" role="search" onSubmit={(e: FormEvent<HTMLFormElement>) => props.onFiltersChange?.({ ...filters, [c.key]: String(new FormData(e.currentTarget).get(k) ?? '') })}>
      {keep.map(([q, v]) => <input key={q} type="hidden" name={q} value={v} />)}
      <input type="search" name={k} defaultValue={cur} aria-label={c.header} />
    </form>
  })
  const next = Array.isArray(props.rows) ? undefined : props.rows.nextCursor
  const table = part('table', {}, slots?.table, s, <>
    <caption>{label}</caption>
    <thead><AutoOff><tr>
      {selection !== 'none' && <th scope="col"><span hidden>Select</span></th>}
      {columns.map((c) => {
        const dir = sort?.column === c.key ? sort.dir : undefined
        const to = dir === 'asc' ? `-${c.key}` : c.key
        return part('th', { key: c.key, scope: 'col', 'aria-sort': dir ? (dir === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined, 'data-sort': c.sortable ? dir ?? 'none' : undefined }, slots?.headerCell, s,
          c.sortable ? <a href={hrefWith(props, sortParam(props), to)} data-sort-to={to} onClick={() => props.onSortChange?.(sortOf(to))}>{c.header}</a> : c.header)
      })}
    </tr></AutoOff></thead>
    <w.Scope><Body p={props as TableProps<any>} items={items} start={virtual ? start : 0} end={virtual ? start + per : items.length} toggle={toggle} sel={sel} s={s} /></w.Scope>
  </>)
  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'table', 'data-disabled': flag(disabled) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {(filterBar.length > 0 || !!bulk?.length) && part('div', { role: 'toolbar', 'aria-label': `${label} tools` }, slots?.toolbar, s, <>
        {filterBar}
        {bulk?.map((b) => <button key={b.name} type="button" data-bulk={b.name} data-danger={flag(b.action.danger)} disabled={disabled || !sel.length} onClick={() => void runBulk(b)}>{b.label}</button>)}
      </>)}
    </AutoOff>
    {virtual
      ? <div ref={box} style={{ height: virtual.height ?? virtual.rowHeight * 10, overflow: 'auto' }} onScroll={(e) => setStart(Math.floor(e.currentTarget.scrollTop / virtual.rowHeight))}>{table}</div>
      : table}
    {next && <AutoOff>{part('div', {}, slots?.footer, s, <a rel="next" href={hrefWith(props, cursorParam(props), next)}>Next</a>)}</AutoOff>}
  </>)
}
