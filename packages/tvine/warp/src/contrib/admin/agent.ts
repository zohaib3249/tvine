// The agent view of the admin pages (headless read_page / x-tvine GET on settings.admin.path/**): a snapshot built
// from the same admin.* reads the panel makes, as the session's user, with the admin.* actions as controls whose
// model / pk come from a signed bind. No panel code runs; a human tab is driven through its widgets instead.
import type { ActionRef, Node, Settings, Snapshot } from '../../core/types.js'
import { signBind } from '../../security/sign.js'

type Result = { ok: true; data: any } | { ok: false; code: string; message: string; reason?: string }
export interface AdminAgentDeps {
  settings: Settings
  call(id: string, params: Record<string, unknown>, sid: string, page: string): Promise<Result>
  paramSpecs(id: string): ActionRef['params']
  has(id: string): boolean
  rev(sid: string): Promise<number>
}

export function adminSnapshot(d: AdminAgentDeps, base: string): (page: string, sid: string) => Promise<Snapshot> {
  const ref = (id: string, bound: Record<string, unknown> = {}): ActionRef[] => d.has(id)
    ? [{ id, params: d.paramSpecs(id).filter((p) => !(p.name in bound)), bind: signBind({ $action: id, ...bound }, d.settings) }] : []
  const refs = (ids: string[], bound: Record<string, unknown>) => ids.flatMap((id) => ref(id, bound))
  return async (page, sid) => {
    const u = new URL(page, 'http://admin.local')
    const seg = u.pathname.slice(base.length).split('/').filter(Boolean)
    const call = (id: string, p: Record<string, unknown> = {}) => d.call(id, p, sid, page)
    const nodes: Node[] = [], links: Snapshot['links'] = []
    const out = async (title: string): Promise<Snapshot> => ({ page, title, sid, rev: await d.rev(sid), nodes, links })
    const site = await call('admin.site')
    if (!site.ok) {   // not signed in, or not staff: the login control (as the panel shows its login)
      nodes.push({ id: 'admin:login', type: 'login', data: { message: site.message }, actions: ref('auth.login') })
      return out('Log in | Administration')
    }
    const models = (site.data.apps as { label: string; name: string; models: { key: string; name: string; namePlural: string; perms: Record<string, boolean> }[] }[])
      .flatMap((a) => a.models.map((m) => ({ ...m, app: a.name })))
    for (const m of models) links.push({ id: `link:${m.key}`, href: `${base}/${m.key.replace('.', '/')}/`, label: m.namePlural })
    const model = seg.length >= 2 ? models.find((m) => m.key === `${seg[0]}.${seg[1]}`) : undefined
    if (!model) {   // dashboard / app index: one node per model
      for (const m of models) {
        nodes.push({ id: `model:${m.key}`, type: 'admin-model', data: { app: m.app, name: m.name, namePlural: m.namePlural, perms: m.perms },
          actions: refs(['admin.list', 'admin.meta', ...(m.perms.add ? ['admin.create'] : [])], { model: m.key }) })
      }
      return out(site.data.title)
    }
    const key = model.key, meta = await call('admin.meta', { model: key })
    if (!meta.ok) { nodes.push({ id: 'admin:error', type: 'error', data: { message: meta.message }, actions: [] }); return out(site.data.title) }
    const pk = seg[2] && seg[2] !== 'add' ? decodeURIComponent(seg[2]) : undefined
    if (pk !== undefined) {   // change / delete / history pages: the object
      const obj = await call('admin.get', { model: key, pk })
      if (!obj.ok) { nodes.push({ id: 'admin:error', type: 'error', data: { message: obj.message }, actions: [] }); return out(site.data.title) }
      const p = obj.data.perms
      nodes.push({ id: `object:${key}:${pk}`, type: 'admin-object', data: { model: key, pk, display: obj.data.display, values: obj.data.values, inlines: obj.data.inlines, fields: Object.keys(meta.data.form.fields) },
        actions: [...refs(['admin.get', 'admin.history', ...(p.change ? ['admin.update'] : [])], { model: key, pk }), ...(p.delete ? refs(['admin.deletePreview', 'admin.delete'], { model: key }) : [])] })
      return out(`${obj.data.display} | ${site.data.title}`)
    }
    if (seg[2] === 'add') {
      nodes.push({ id: `add:${key}`, type: 'admin-add', data: { model: key, fields: meta.data.form.fields, inlines: meta.data.form.inlines.map((i: { name: string; fields: string[] }) => ({ name: i.name, fields: i.fields })) }, actions: ref('admin.create', { model: key }) })
      return out(`Add ${model.name} | ${site.data.title}`)
    }
    // changelist: query params (q, o, p, all, every other key a filter), as the panel sends them
    const q: Record<string, string> = Object.fromEntries(u.searchParams)
    const { q: text, o, p: pg, all, ...rest } = q
    const filters = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('tvine-')))
    const list = await call('admin.list', { model: key, ...(text && { q: text }), ...(o && { ordering: o.split(',') }), ...(pg && { page: Number(pg) }), ...(all && { all: true }), ...(Object.keys(filters).length && { filters }) })
    if (!list.ok) { nodes.push({ id: 'admin:error', type: 'error', data: { message: list.message }, actions: [] }); return out(site.data.title) }
    const disp = meta.data.display
    nodes.push({ id: `changelist:${key}`, type: 'admin-changelist', data: {
      model: key, namePlural: model.namePlural, count: list.data.count, page: list.data.page, pages: list.data.pages,
      columns: disp.listDisplay.map((c: { name: string; label: string }) => c.name), filters: disp.filters.map((f: { name: string; choices?: { value: string }[] }) => ({ name: f.name, values: f.choices?.map((c) => c.value) })),
      actions: disp.actions.map((a: { name: string }) => a.name), search: disp.search ?? false,
    }, actions: refs(['admin.list', 'admin.action', 'admin.listEdit', ...(model.perms.add ? ['admin.create'] : []), ...(model.perms.delete ? ['admin.delete'] : [])], { model: key }) })
    for (const r of list.data.rows as { pk: string; values: Record<string, unknown> }[]) {
      nodes.push({ id: `row:${key}:${r.pk}`, type: 'admin-row', data: { pk: r.pk, ...r.values }, actions: [...ref('admin.get', { model: key, pk: r.pk }), ...(model.perms.change ? ref('admin.update', { model: key, pk: r.pk }) : [])] })
      links.push({ id: `link:${key}:${r.pk}`, href: `${base}/${key.replace('.', '/')}/${encodeURIComponent(r.pk)}/change/`, label: String(r.pk) })
    }
    return out(`${model.namePlural} | ${site.data.title}`)
  }
}
