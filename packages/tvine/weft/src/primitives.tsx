import { Children, Fragment, cloneElement, isValidElement, type ComponentType, type ElementType, type ReactElement, type ReactNode } from 'react'
import { bindAction, pageFragment, paramSpecs, register, registerLink } from './runtime/registry.js'
import { FormWidget, LinkWidget } from './runtime/primitives.client.js'
import { WidgetScope } from './widget/scope.js'
import { FieldError, FormClient, type Spec } from './runtime/form.client.js'
import { idFor } from './useAgent.js'
import type { ActionDef, Paginated } from './types.js'

// --- Scope ------------------------------------------------------------------------------
// React.createContext does not exist in the react-server build, so primitives cannot read
// an enclosing Section/Form/Page through context. Instead each scoping primitive walks the
// element tree it was handed (its children, and the `children` of any element inside them)
// and passes `scope` to every primitive it finds. That is plain element cloning: identical
// under RSC, SSR, Suspense and streaming.
// Ceiling: elements a custom component creates internally are not visible to the walk. For
// those, use render-prop children `{(scope) => <Custom scope={scope} />}` (List: the third
// render-prop arg) and forward `scope` to the primitives inside. Misses are loud in dev:
// Section/Form/List warn when they saw only components, Input errors without a Form scope.
// Human-side behaviour never depends on scope: disabling is a native <fieldset disabled>,
// field errors come from client context.
export interface Scope {
  prefix?: string                                   // id prefix: `section:cart > ...`
  page?: boolean                                    // inside a <Page>
  silent?: boolean                                  // past List pageSize: render, don't register
  form?: { id: string; action: string; fields: string[] | null }
}
type Scoped = { scope?: Scope }
type Kids = ReactNode | ((scope: Scope) => ReactNode)
type Seen = { prims: number; comps: Set<string> }

const PRIMS = new Set<unknown>()
const dev = () => process.env.NODE_ENV !== 'production'
const pid = (s: Scope | undefined, id: string) => (s?.prefix ? `${s.prefix} > ${id}` : id)
const quiet = (s: Scope | undefined, el: ReactElement) => (s?.silent ? null : el)
const newSeen = (): Seen => ({ prims: 0, comps: new Set() })

function nameOf(t: unknown): string {
  const o = t as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } }
  return o.displayName || o.name || o.render?.name || o.type?.name || 'Anonymous'
}

function walk(node: ReactNode, scope: Scope, seen: Seen = newSeen()): ReactNode {
  return Children.map(node, (c) => {
    if (!isValidElement<Scoped & { children?: ReactNode }>(c)) return c
    if (PRIMS.has(c.type)) {
      seen.prims++
      return c.props.scope ? c : cloneElement(c, { scope })
    }
    // W3's auto-instrumented intrinsics (AutoEl, props.$tag) are plain HTML, not opaque components.
    if (typeof c.type !== 'string' && typeof c.type !== 'symbol' && !('$tag' in c.props)) seen.comps.add(nameOf(c.type))
    const kids = c.props.children
    if (kids == null || typeof kids === 'function') return c
    return cloneElement(c, undefined, walk(kids, scope, seen))
  }) ?? null
}

function warnOpaque(tag: string, seen: Seen) {
  if (!dev() || seen.prims > 0 || seen.comps.size === 0) return
  console.warn(`tvine: ${tag} found no primitives in its children, only components (${[...seen.comps].join(', ')}). ` +
    'Primitives rendered inside a component do not get this scope — use render-prop children ' +
    '{(scope) => <Custom scope={scope} />} and pass scope on to them.')
}

// Visit-only scan through every element (primitives included) — no cloning.
function scan(node: ReactNode, f: (el: ReactElement<Record<string, unknown>>) => void) {
  Children.forEach(node, (c) => {
    if (!isValidElement<{ children?: ReactNode }>(c)) return
    f(c as ReactElement<Record<string, unknown>>)
    const kids = c.props.children
    if (kids != null && typeof kids !== 'function') scan(kids, f)
  })
}

// --- Data -------------------------------------------------------------------------------
export function Data({ type, value, agentId, personal, live, children, scope }: Scoped & {
  type: string; value: Record<string, unknown>; agentId?: string; personal?: boolean; live?: boolean; children?: ReactNode
}) {
  const s = scope ?? {}
  const own = idFor(type, { id: agentId, data: value })
  // v1 node id keeps the RSC prefix; client widgets inside scope under the GLOBAL entity id.
  return <>{quiet(s, register({ id: pid(s, own), type, data: value, personal, live }))}<WidgetScope id={own} entity>{walk(children, s)}</WidgetScope></>
}

// --- Section ----------------------------------------------------------------------------
export function Section({ name, as: As = 'section', className, children, scope }: Scoped & {
  name: string; as?: ElementType; className?: string; children: Kids
}) {
  const id = pid(scope, `section:${name}`)
  const inner = { ...scope, prefix: id }
  let kids: ReactNode
  if (typeof children === 'function') kids = children(inner)
  else { const seen = newSeen(); kids = walk(children, inner, seen); warnOpaque(`<Section name="${name}">`, seen) }
  return <>{quiet(scope, register({ id, type: 'section', data: { name } }))}<As className={className}><WidgetScope id={`section:${name}`}>{kids}</WidgetScope></As></>
}

// --- Page -------------------------------------------------------------------------------
// Detects nesting the walk can see (literal nesting). A Page in a layout plus one in the
// page segment is separate trees: not detected here, but the warp extractor warns (dev) on a
// second page fragment.
export function Page({ name, title, personal, live, children, scope }: Scoped & {
  name: string; title?: string; personal?: boolean; live?: boolean; children: Kids
}) {
  if (scope?.page && dev()) throw new Error(`tvine: nested <Page name="${name}"> — a route has exactly one Page`)
  const inner = { ...scope, page: true }
  return <>{pageFragment({ page: name, title: title ?? name, personal, live })}{typeof children === 'function' ? children(inner) : walk(children, inner)}</>
}

// --- Link -------------------------------------------------------------------------------
// No dependency on next: pass `as={NextLink}` to get client navigation. `id` is the DOM id;
// `agentId` overrides the agent link id (default `link:<href>`).
const UNSAFE = /^(javascript|data|vbscript):/i
// In-tab id: hrefs carry `?`, `=`, `&`, which widget ids don't allow (ids.ts); cleaned quietly here
// (a query string is normal, not a dev mistake). The v1 link id in the snapshot keeps the raw href.
const linkSeg = (id: string) => id.replace(/[^\p{L}\p{N}_.:@/+-]/gu, '_').slice(0, 256)
export function Link({ href, label, params, personal, live, agentId, as: As = 'a', children, scope, ...rest }: Scoped & {
  href: string; label?: string; params?: string[]; personal?: boolean; live?: boolean; agentId?: string; as?: ElementType; children?: ReactNode
  [k: string]: unknown
}) {
  const parts = Children.toArray(children)
  let text = label ?? (parts.every((p) => typeof p === 'string' || typeof p === 'number') ? parts.join('') : undefined)
  if (text === undefined) {
    if (dev()) throw new Error(`tvine: <Link href="${href}"> needs a label (children are not plain text)`)
    text = href
  }
  // Browsers ignore control chars/whitespace inside a scheme ("java\tscript:").
  const unsafe = UNSAFE.test(href.replace(/[\u0000- \u007F]/g, ''))
  if (unsafe && dev()) console.warn(`tvine: <Link href="${href}"> has an unsafe scheme; not exposed to agents`)
  const link = { id: pid(scope, agentId ?? `link:${href}`), href, label: text, ...(params && { params }) }
  return <>{!unsafe && quiet(scope, <>{registerLink(link, { personal, live })}<LinkWidget seg={linkSeg(agentId ?? `link:${href}`)} label={text} href={href} /></>)}<As href={href} {...rest}>{children}</As></>
}

// --- List -------------------------------------------------------------------------------
// `query`: the current search params (e.g. Next's searchParams) so the `next` link keeps
// sort/filter state; `cursor` is replaced.
type Query = URLSearchParams | Record<string, string | string[] | undefined>

function nextHref(query: Query | undefined, cursor: string): string {
  const q = new URLSearchParams(query instanceof URLSearchParams ? query : undefined)
  if (query && !(query instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) if (x !== undefined) q.append(k, x)
  }
  q.set('cursor', cursor)
  return `?${q}`
}

export function List<T>({ name, items, query, children, as: As = 'ul', className, scope }: Scoped & {
  name: string; items: T[] | Paginated<T>; query?: Query
  children: (item: T, i: number, scope: Scope) => ReactNode   // forward scope to row components
  as?: ElementType; className?: string
}) {
  const s = scope ?? {}
  const page = Array.isArray(items) ? undefined : items
  const rows = page ? page.items : (items as T[])
  const data = page
    ? { name, count: page.total ?? rows.length, pageSize: page.pageSize, ...(page.nextCursor && { nextCursor: page.nextCursor }) }
    : { name, count: rows.length }
  const id = pid(s, `list:${name}`)
  const seen = newSeen()
  const out = rows.map((item, i) => {
    // Agent rows are capped at pageSize; humans still see every row.
    const rs = page && i >= page.pageSize ? { ...s, silent: true } : s
    return <Fragment key={i}>{walk(children(item, i, rs), rs, seen)}</Fragment>
  })
  if (children.length < 3) warnOpaque(`<List name="${name}">`, seen)   // a 3-arg render prop takes scope itself
  return (
    <>
      {quiet(s, register({ id, type: 'list', data }))}
      {page?.nextCursor && quiet(s, registerLink({ id: `${id}:next`, href: nextHref(query, page.nextCursor), label: 'next', params: ['cursor'] }))}
      <As className={className}><WidgetScope id={`list:${name}`}>{out}</WidgetScope></As>
    </>
  )
}

// --- Form -------------------------------------------------------------------------------
type ButtonProps = Scoped & {
  intent?: string; disabled?: boolean; asChild?: boolean; children: ReactNode; className?: string
  action?: ActionDef; bind?: Record<string, unknown>; agentId?: string
}

// Default agent id: `form:<action>` (+ `:<bind values>`). Several bind-less forms for the
// same action on one page need explicit agentIds; in dev the warp extractor warns when a
// repeated id carries different content (identical repeats are harmless and stay silent).
function formId(action: ActionDef, bind: Record<string, unknown> | undefined, agentId: string | undefined): string {
  if (agentId) return agentId
  const vals = Object.values(bind ?? {})
  if (vals.some((v) => typeof v !== 'string' && typeof v !== 'number')) {
    throw new Error(`tvine: <Form action="${action.id}"> bind has non-string/number values; pass an explicit agentId`)
  }
  return ['form', action.id, ...vals].join(':')
}

type ZodLike = { _def?: { typeName?: string; innerType?: ZodLike } }
function specsFor(schema: unknown): Spec[] {
  const shape = ((schema as { shape?: Record<string, ZodLike> } | null)?.shape) ?? {}
  return paramSpecs(schema).map((p) => {
    let t = shape[p.name]
    while (t?._def?.innerType) t = t._def.innerType
    return { ...p, array: t?._def?.typeName === 'ZodArray' }
  })
}

export function Form({ action, bind, disabled, agentId, id, className, children, scope }: Scoped & {
  action: ActionDef; bind?: Record<string, unknown>; disabled?: boolean; agentId?: string; id?: string
  className?: string; children: Kids
}) {
  const s = scope ?? {}
  const own = formId(action, bind, agentId)
  const fid = pid(s, own)
  const shape = (action.schema as { shape?: object } | null)?.shape
  const inner: Scope = { ...s, prefix: fid, form: { id: fid, action: action.id, fields: shape ? Object.keys(shape) : null } }
  let kids: ReactNode
  if (typeof children === 'function') kids = children(inner)
  else { const seen = newSeen(); kids = walk(children, inner, seen); warnOpaque(`<Form action="${action.id}">`, seen) }
  const buttons: ButtonProps[] = []
  scan(kids, (el) => { if (el.type === Button) buttons.push(el.props as ButtonProps) })
  // Honesty rule: a form humans can't submit exposes no ActionRef to agents.
  const off = !!disabled || (buttons.length > 0 && buttons.every((b) => b.disabled))
  const intent = buttons.find((b) => b.intent)?.intent ?? action.id
  const handle = off ? null : bindAction(action, bind)
  const form = <FormClient action={action.id} bind={handle?.bind ?? ''} specs={specsFor(action.schema)}
    disabled={off} id={id} className={className}>{kids}</FormClient>
  return (
    <>
      {quiet(s, register({ id: fid, type: 'form', data: { action: action.id, intent }, actions: off ? [] : [{ def: action, bindPayload: bind }] }))}
      {/* Silent forms (past a List's pageSize) still scope their client children, but list no control. */}
      <FormWidget seg={own} label={intent} handle={s.silent ? null : handle}>{form}</FormWidget>
    </>
  )
}

// --- Input ------------------------------------------------------------------------------
// type 'file' renders a native file input; upload wiring lands with media (Task 17).
export function Input({ name, type = 'text', options, defaultValue, className, error, scope }: Scoped & {
  name: string; type?: 'text' | 'number' | 'email' | 'date' | 'checkbox' | 'file'
  options?: { value: string; label: string }[]; defaultValue?: unknown; className?: string
  error?: ComponentType<{ message: string }>   // a client component under RSC
}) {
  const f = scope?.form
  if (dev()) {
    if (!f) console.error(`tvine: <Input name="${name}"> has no <Form> scope: it is outside a Form, or inside a component the Form can't see — agents won't see it. Use {(scope) => <Custom scope={scope} />}.`)
    else if (f.fields && !f.fields.includes(name)) console.warn(`tvine: <Input name="${name}"> is not a param of ${f.action}; schema fields: ${f.fields.join(', ')}`)
  }
  const dv = defaultValue as string | number | undefined
  const field = options
    ? <select name={name} defaultValue={dv as string} className={className}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    : <input name={name} type={type} className={className}
        {...(type === 'checkbox' ? { defaultChecked: !!defaultValue } : { defaultValue: dv })} />
  return (
    <>
      {f && quiet(scope, register({ id: pid(scope, `input:${name}`), type: 'input', data: { name, type, ...(options && { options }) } }))}
      {field}
      <FieldError name={name} error={error} />
    </>
  )
}

// --- Button -----------------------------------------------------------------------------
export function Button({ intent, disabled, asChild, children, className, action, bind, agentId, scope }: ButtonProps) {
  if (action && !scope?.form) {
    // Single-action form sugar.
    return <Form action={action} bind={bind} agentId={agentId} scope={scope}><Button intent={intent} disabled={disabled} asChild={asChild} className={className}>{children}</Button></Form>
  }
  if (dev()) {
    if (action) console.warn(`tvine: <Button action="${action.id}"> is inside a <Form>; its own action is ignored (the Form's action submits)`)
    else if (!scope?.form) console.warn('tvine: <Button> outside a <Form> and without an action registers nothing (or the Form cannot see it — pass scope)')
  }
  if (asChild && isValidElement<{ className?: string }>(children)) {
    const cls = [children.props.className, className].filter(Boolean).join(' ')
    return cloneElement(children, { type: 'submit', ...(disabled && { disabled: true }), ...(cls && { className: cls }) } as object)
  }
  return <button type="submit" disabled={disabled || undefined} className={className}>{children}</button>
}

for (const p of [Data, Section, Page, Link, List, Form, Input, Button]) PRIMS.add(p)
