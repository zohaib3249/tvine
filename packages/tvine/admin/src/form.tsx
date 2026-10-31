'use client'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'tvine/widgets'
import { href, urlFor } from './routes.js'
import type { ModelMeta, ObjectData } from './types.js'
import { AdminModelForm, type ModelFormState } from './forms-adapter.js'
import { Icon, Region, Slotted, cx, slotClass, useAdmin } from './ui.js'


export function ChangeForm({ meta, obj }: { meta: ModelMeta; obj?: ObjectData }) {
  const { call, base, navigate, setDirty, prefs, route } = useAdmin()
  const submitter = useRef('_save')
  const save = (sub: string, st: ModelFormState) => { submitter.current = sub; st.submit() }
  const [gen, setGen] = useState(0)   // "save and add another" → a fresh form
  const adding = !obj
  const perms = obj?.perms ?? meta.perms
  const readOnly = !adding && !perms.change
  useEffect(() => () => setDirty(false), [setDirty])
  useEffect(() => {
    if (!obj) return
    const recent = prefs.get<{ model: string; pk: string; display: string }[]>('recent', []).filter((r) => !(r.model === meta.key && r.pk === obj.pk))
    prefs.set('recent', [{ model: meta.key, pk: obj.pk, display: obj.display }, ...recent].slice(0, 8))
  }, [obj?.pk])   // eslint-disable-line react-hooks/exhaustive-deps
  const objUrls = (meta.urls ?? []).filter((u) => u.path.includes('<') && obj)
  const link = (to: string, label: string, id: string, icon: string, cls = '') => (
    <a href={to} agentId={id} onClick={(e) => { e.preventDefault(); navigate(to) }} className={cx('tva-btn', cls)}><Icon name={icon} />{label}</a>
  )
  return (
    <Slotted slot="form" meta={meta}>
      <Region id="admin:form" label={adding ? `Add ${meta.name}` : `Change ${meta.name}`} state={{ mode: adding ? 'add' : 'change', pk: obj?.pk ?? null }} className={slotClass('form')}>
        <div className="mb-5 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{adding ? `Add ${meta.name}` : readOnly ? `View ${meta.name}` : `Change ${meta.name}`}</h1>
            {obj && <p className="truncate text-muted">{obj.display}</p>}
          </div>
          {obj && <div className="flex flex-wrap gap-2">
            {objUrls.map((u) => <span key={u.name} className="contents">{link(urlFor(base, meta.key, u.path, { id: obj.pk, pk: obj.pk, object_id: obj.pk }), u.title, `url-${u.name}`, 'ext')}</span>)}
            {link(href(base, { name: 'history', model: meta.key, pk: obj.pk }), 'History', 'history', 'clock')}
          </div>}
        </div>
        <AdminModelForm key={gen} meta={meta.form} model={meta.key} obj={obj} call={call} readOnly={readOnly} onDirty={setDirty}
          onSaved={(pk) => {
            setDirty(false)
            const sub = submitter.current
            submitter.current = '_save'
            toast({ kind: 'success', title: adding ? `${meta.name} added` : `${meta.name} changed`, description: obj?.display })
            if (sub === '_continue') navigate(href(base, { name: 'change', model: meta.key, pk }), { replace: adding })
            else if (sub === '_addanother') { if (route.name === 'add') setGen((g) => g + 1); else navigate(href(base, { name: 'add', model: meta.key })) }
            else navigate(href(base, { name: 'changelist', model: meta.key }))
          }}
          actions={(st) => !readOnly && (
            <div className="sticky bottom-0 z-[1] mt-5 flex w-full flex-wrap items-center gap-2 rounded-lg border border-line bg-surface/95 p-3 shadow-lg backdrop-blur">
              {obj && perms.delete && link(href(base, { name: 'delete', model: meta.key, pk: obj.pk }), 'Delete', 'delete', 'trash', 'tva-btn-danger tva-btn-ghost')}
              <div className="flex-1" />
              {meta.perms.add && <button type="button" agentId="save-add" disabled={st.submitting} onClick={() => save('_addanother', st)} className="tva-btn hidden sm:inline-flex">Save and add another</button>}
              <button type="button" id="tva-save-continue" agentId="save-continue" disabled={st.submitting} onClick={() => save('_continue', st)} className="tva-btn">Save and continue</button>
              <button type="submit" agentId="save" disabled={st.submitting} onClick={() => { submitter.current = '_save' }} className="tva-btn tva-btn-primary">{st.submitting ? 'Saving…' : 'Save'}</button>
            </div>
          )} />
      </Region>
    </Slotted>
  )
}
