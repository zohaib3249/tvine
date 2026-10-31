'use client'
import { useState } from 'react'
import { toast } from '@tvine/weft/widgets'
import type { Call, RouteData } from './data.js'
import { href } from './routes.js'
import type { DeleteNode, DeletePreview, LogEntry, ModelMeta, ObjectData, SiteApp, User } from './types.js'
import { Empty, ErrorBox, Icon, cap, PlainForm, Region, Skeleton, Slotted, cx, slotClass, useAdmin } from './ui.js'
import { CustomComponent } from './app.js'

function AppCard({ a }: { a: SiteApp }) {
  const { base, navigate } = useAdmin()
  const models = a.models.filter((m) => m.perms.view || m.perms.add)
  if (!models.length) return null
  return (
    <section className="tva-card overflow-hidden">
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 font-semibold">
        <a href={href(base, { name: 'app', app: a.label })} agentId={`app-${a.label}`} onClick={(e) => { e.preventDefault(); navigate(href(base, { name: 'app', app: a.label })) }} className="hover:text-accent">{a.name}</a>
      </h2>
      <ul className="divide-y divide-line">
        {models.map((m) => (
          <li key={m.key} className="flex items-center gap-2 px-4 py-2.5">
            {m.perms.view
              ? <a href={href(base, { name: 'changelist', model: m.key })} agentId={m.key} onClick={(e) => { e.preventDefault(); navigate(href(base, { name: 'changelist', model: m.key })) }} className="flex-1 font-medium hover:text-accent">{cap(m.namePlural)}</a>
              : <span className="flex-1 font-medium">{cap(m.namePlural)}</span>}
            {m.perms.add && <a href={href(base, { name: 'add', model: m.key })} agentId={`add-${m.key}`} aria-label={`Add ${m.name}`} onClick={(e) => { e.preventDefault(); navigate(href(base, { name: 'add', model: m.key })) }} className="tva-btn tva-btn-ghost h-7 px-2 text-accent"><Icon name="plus" size={14} />Add</a>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Dashboard({ data }: { data?: RouteData }) {
  const { site } = useAdmin()
  const widgets = site.widgets ?? []
  return (
    <Slotted slot="dashboard">
      <Region id="admin:dashboard" label={site.indexTitle} className={slotClass('dashboard')}>
        <h1 className="mb-5 text-2xl font-semibold tracking-tight">{site.indexTitle}</h1>
        {widgets.length > 0 && (
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {widgets.map((w) => (
              <Region key={w.id} id={`widget:${w.id}`} label={w.title} className={cx('tva-card p-4', w.size === 'lg' ? 'sm:col-span-2 xl:col-span-4' : w.size === 'md' && 'sm:col-span-2')}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{w.title}</h2>
                {w.component ? <CustomComponent name={w.component} data={data?.widgets?.[w.id]} />
                  : !data ? <div className="tva-skel h-8 w-24" /> : <WidgetData v={data.widgets?.[w.id]} />}
              </Region>
            ))}
          </div>
        )}
        {site.apps.length === 0
          ? <Empty title="Nothing to manage yet">You don’t have permission to view any models, or none are registered.</Empty>
          : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{site.apps.map((a) => <AppCard key={a.label} a={a} />)}</div>}
      </Region>
    </Slotted>
  )
}

// Generic widget data: a number → stat; rows → mini table; object → key/value.
function WidgetData({ v }: { v: unknown }) {
  if (v && typeof v === 'object' && 'error' in v) return <p className="text-sm text-danger">{String((v as { error: unknown }).error)}</p>
  if (typeof v === 'number' || typeof v === 'string') return <p className="text-3xl font-semibold tabular-nums">{typeof v === 'number' ? v.toLocaleString() : v}</p>
  const rows = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { rows?: unknown }).rows) ? (v as { rows: unknown[] }).rows : null
  if (rows) {
    const cols = Object.keys((rows[0] ?? {}) as object).slice(0, 4)
    return (
      <table className="w-full text-sm"><tbody>
        {rows.slice(0, 8).map((r, i) => <tr key={i} className="border-t border-line first:border-0">{cols.map((c) => <td key={c} className="py-1.5 pr-2 tabular-nums">{String((r as Record<string, unknown>)[c] ?? '')}</td>)}</tr>)}
      </tbody></table>
    )
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('value' in o) return <div><p className="text-3xl font-semibold tabular-nums">{String(o.value)}</p>{o.hint !== undefined && <p className="text-sm text-muted">{String(o.hint)}</p>}</div>
    return <dl className="grid grid-cols-2 gap-1 text-sm">{Object.entries(o).map(([k, x]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="text-right tabular-nums">{String(x)}</dd></div>)}</dl>
  }
  return <p className="text-muted">—</p>
}

export function AppIndex({ app }: { app: string }) {
  const { site } = useAdmin()
  const a = site.apps.find((x) => x.label === app)
  if (!a) return <Empty title="App not found" icon="search" />
  return <Region id="admin:app" label={a.name}><h1 className="mb-5 text-2xl font-semibold tracking-tight">{a.name}</h1><div className="max-w-xl"><AppCard a={a} /></div></Region>
}

export function DeleteTree({ preview }: { preview: DeletePreview }) {
  const node = (n: DeleteNode, i: number) => (
    <li key={i} className="mt-1">
      <span className={cx(n.protected && 'font-medium text-danger')}>{n.label}</span>
      {n.children?.length ? <ul className="ml-4 border-l border-line pl-3">{n.children.map(node)}</ul> : null}
    </li>
  )
  return (
    <div className="text-sm">
      {preview.protected?.length ? <div role="alert" className="mb-3 rounded-md bg-danger/10 p-3 text-danger">Deleting would require deleting these protected related objects: <ul className="ml-4 list-disc">{preview.protected.map(node)}</ul></div> : null}
      {preview.counts && <p className="mb-2 flex flex-wrap gap-2">{Object.entries(preview.counts).map(([k, c]) => <span key={k} className="tva-chip">{k}: {c}</span>)}</p>}
      <ul>{preview.tree.map(node)}</ul>
    </div>
  )
}

export function DeleteView({ meta, obj, preview, error, pk }: { meta: ModelMeta; obj?: ObjectData; preview?: DeletePreview; error?: { code: string; message: string }; pk: string }) {
  const { call, base, navigate } = useAdmin()
  const [busy, setBusy] = useState(false)
  const blocked = !!preview?.protected?.length
  const go = async () => {
    setBusy(true)
    const r = await call('admin.delete', { model: meta.key, pks: [pk] })
    setBusy(false)
    const prot = r.ok && (r.data as { protected?: unknown[] })?.protected?.length
    if (!r.ok || prot) { toast({ kind: 'error', title: 'Not deleted', description: r.ok ? 'Protected related objects exist.' : r.message }); return }
    toast({ kind: 'success', title: `${meta.name} deleted`, description: obj?.display })
    navigate(href(base, { name: 'changelist', model: meta.key }), { replace: true })
  }
  return (
    <Region id="admin:delete" label={`Delete ${meta.name}`} className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">{blocked ? `Cannot delete ${meta.name}` : 'Are you sure?'}</h1>
      <p className="mb-4 text-muted">{blocked ? `Deleting the ${meta.name} “${obj?.display ?? pk}” would require deleting protected related objects.`
        : `Deleting the ${meta.name} “${obj?.display ?? pk}” will also delete the related objects below.`}</p>
      {error && !preview && <ErrorBox error={error} />}
      <div className="tva-card mb-5 p-4">{preview ? <DeleteTree preview={preview} /> : !error && <Skeleton rows={3} />}</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" agentId="confirm" disabled={busy || blocked || !preview} onClick={go} className="tva-btn tva-btn-danger-solid"><Icon name="trash" />{busy ? 'Deleting…' : 'Yes, I’m sure'}</button>
        <button type="button" agentId="cancel" onClick={() => navigate(href(base, { name: 'change', model: meta.key, pk }))} className="tva-btn">No, take me back</button>
      </div>
    </Region>
  )
}

export function HistoryView({ meta, obj, rows, pk }: { meta: ModelMeta; obj?: ObjectData; rows?: LogEntry[] | { rows: LogEntry[] }; pk: string }) {
  const list = Array.isArray(rows) ? rows : rows?.rows
  return (
    <Region id="admin:history" label={`History of ${obj?.display ?? pk}`} className="max-w-4xl">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Change history: {obj?.display ?? pk}</h1>
      <div className="tva-card overflow-hidden">
        {!list ? <Skeleton rows={4} /> : list.length === 0 ? <Empty title="No history" icon="clock">This object doesn’t have a change history. It probably wasn’t added via this admin site.</Empty> : (
          <ol className="divide-y divide-line">
            {list.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3">
                <time className="w-44 shrink-0 text-sm text-muted tabular-nums" dateTime={e.actionTime}>{new Date(e.actionTime).toLocaleString()}</time>
                <span className="font-medium">{e.user}</span>
                <span className="tva-chip">{e.action}</span>
                <span className="min-w-0 flex-1 text-muted">{e.changeMessage ?? e.message ?? ''}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="sr-only">{meta.name}</p>
    </Region>
  )
}

export function Login({ error, user, call, onDone }: { error?: { code: string; message: string; reason?: string }; user: User | null; call: Call; onDone(): void }) {
  const [u, setU] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const signedInNotStaff = user && !user.isStaff
  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <Region id="admin:login" label="Admin sign in" className="tva-card w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-lg bg-brand font-bold text-brand-fg">A</span><h1 className="text-lg font-semibold">Administration</h1></div>
        {signedInNotStaff && <p role="alert" className="mb-4 rounded-md bg-warn/10 p-3 text-sm text-warn">You are signed in as {user.username}, but you are not authorized to access the admin. Sign in with a staff account.</p>}
        {error && !signedInNotStaff && error.code !== 'expired_sid' && user && <div className="mb-4"><ErrorBox error={error} /></div>}
        {err && <p role="alert" className="mb-4 rounded-md bg-danger/10 p-3 text-sm text-danger">{err}</p>}
        <PlainForm className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true)
          const r = await call('auth.login', { username: u, password: pw })
          setBusy(false)
          if (r.ok) onDone(); else setErr(r.message || 'Please enter the correct username and password for a staff account.')
        }}>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">Username<input agentId="username" autoComplete="username" required value={u} onChange={(e) => setU(e.target.value)} className="tva-input" /></label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">Password<input agentId="password" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} className="tva-input" /></label>
          <button type="submit" agentId="login" disabled={busy} className="tva-btn tva-btn-primary mt-1 h-10">{busy ? 'Signing in…' : 'Log in'}</button>
        </PlainForm>
      </Region>
    </div>
  )
}
