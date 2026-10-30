import { Children, Fragment, cloneElement, isValidElement, type ComponentType, type ElementType, type ReactElement, type ReactNode } from 'react'
import { bindFor, pageFragment, paramSpecs, register, registerLink } from './runtime/registry.js'
import { FieldError, FormClient } from './runtime/form.client.js'
import { idFor } from './useAgent.js'
import type { ActionDef, Paginated } from './types.js'

// --- Scope ------------------------------------------------------------------------------
// React.createContext does not exist in the react-server build, so primitives cannot read
// an enclosing Section/Form/Page through context. Instead each scoping primitive walks the
// element tree it was handed (its children, and the `children` of any element inside them)
// and passes `scope` to every primitive it finds. That is plain element cloning: identical
// under RSC, SSR, Suspense and streaming.
// Ceiling: elements a custom component creates internally are not visible to the walk. For
// those, use render-prop children `{(scope) => <Custom scope={scope} />}` and forward
// `scope` to the primitives inside (every primitive takes a public `scope` prop).
export interface Scope {
  prefix?: string                                   // id prefix: `section:cart > ...`
  page?: boolean                                    // inside a <Page>
  silent?: boolean                                  // past List pageSize: render, don't register
  form?: { id: string; action: string; fields: string[] | null; disabled: boolean }
}
type Scoped = { scope?: Scope }
type Kids = ReactNode | ((scope: Scope) => ReactNode)

const PRIMS = new Set<unknown>()
const dev = () => process.env.NODE_ENV !== 'production'
const pid = (s: Scope | undefined, id: string) => (s?.prefix ? `${s.prefix} > ${id}` : id)
const quiet = (s: Scope | undefined, el: ReactElement) => (s?.silent ? null : el)

function walk(node: ReactNode, scope: Scope, visit?: (el: ReactElement<Scoped>) => void): ReactNode {
  return Children.map(node, (c) => {
    if (!isValidElement<Scoped & { children?: ReactNode }>(c)) return c
    if (PRIMS.has(c.type)) {
      visit?.(c)
      return c.props.scope ? c : cloneElement(c, { scope })
    }
    const kids = c.props.children
    if (kids == null || typeof kids === 'function') return c
    return cloneElement(c, undefined, walk(kids, scope, visit))
  }) ?? null
}
const scoped = (kids: Kids, scope: Scope, visit?: (el: ReactElement<Scoped>) => void) =>
  typeof kids === 'function' ? kids(scope) : walk(kids, scope, visit)

// --- Data -------------------------------------------------------------------------------
export function Data({ type, value, id, personal, children, scope }: Scoped & {
  type: string; value: Record<string, unknown>; id?: string; personal?: boolean; children?: ReactNode
}) {
  const s = scope ?? {}
  return <>{quiet(s, register({ id: pid(s, idFor(type, { id, data: value })), type, data: value, personal }))}{walk(children, s)}</>
}

// --- Section ----------------------------------------------------------------------------
export function Section({ name, as: As = 'section', className, children, scope }: Scoped & {
  name: string; as?: ElementType; className?: string; children: Kids
}) {
  const id = pid(scope, `section:${name}`)
  return <>{quiet(scope, register({ id, type: 'section', data: { name } }))}<As className={className}>{scoped(children, { ...scope, prefix: id })}</As></>
}

// --- Page -------------------------------------------------------------------------------
// Detects nesting the walk can see (literal nesting). A Page in a layout plus one in the
// page segment is separate trees and is not detected here.
export function Page({ name, title, personal, children, scope }: Scoped & {
  name: string; title?: string; personal?: boolean; children: Kids
}) {
  if (scope?.page && dev()) throw new Error(`tvine: nested <Page name="${name}"> — a route has exactly one Page`)
  return <>{pageFragment({ page: name, title: title ?? name, personal })}{scoped(children, { ...scope, page: true })}</>
}

// --- Link -------------------------------------------------------------------------------
// No dependency on next: pass `as={NextLink}` to get client navigation.
export function Link({ href, label, params, personal, id, as: As = 'a', children, scope, ...rest }: Scoped & {
  href: string; label?: string; params?: string[]; personal?: boolean; id?: string; as?: ElementType; children?: ReactNode
  [k: string]: unknown
}) {
  const text = label ?? (typeof children === 'string' || typeof children === 'number' ? String(children) : undefined)
  if (text === undefined) throw new Error(`tvine: <Link href="${href}"> needs a label (children are not plain text)`)
  const link = { id: pid(scope, id ?? `link:${href}`), href, label: text, ...(params && { params }) }
  return <>{quiet(scope, registerLink(link, { personal }))}<As href={href} {...rest}>{children}</As></>
}

// --- List -------------------------------------------------------------------------------
export function List<T>({ name, items, children, as: As = 'ul', className, scope }: Scoped & {
  name: string; items: T[] | Paginated<T>; children: (item: T, i: number) => ReactNode; as?: ElementType; className?: string
}) {
  const s = scope ?? {}
  const page = Array.isArray(items) ? undefined : items
  const rows = page ? page.items : (items as T[])
  const data = page
    ? { name, count: page.total ?? rows.length, pageSize: page.pageSize, ...(page.nextCursor && { nextCursor: page.nextCursor }) }
    : { name, count: rows.length }
  const id = pid(s, `list:${name}`)
  return (
    <>
      {quiet(s, register({ id, type: 'list', data }))}
      {page?.nextCursor && quiet(s, registerLink({ id: `${id}:next`, href: `?cursor=${encodeURIComponent(page.nextCursor)}`, label: 'next', params: ['cursor'] }))}
      <As className={className}>
        {rows.map((item, i) => (
          // Agent rows are capped at pageSize; humans still see every row.
          <Fragment key={i}>{walk(children(item, i), page && i >= page.pageSize ? { ...s, silent: true } : s)}</Fragment>
        ))}
      </As>
    </>
  )
}

// --- Form -------------------------------------------------------------------------------
type ButtonProps = Scoped & {
  intent?: string; disabled?: boolean; asChild?: boolean; children: ReactNode; className?: string
  action?: ActionDef; bind?: Record<string, unknown>; id?: string
}

export function Form({ action, bind, disabled, id, className, children, scope }: Scoped & {
  action: ActionDef; bind?: Record<string, unknown>; disabled?: boolean; id?: string; className?: string; children: Kids
}) {
  const s = scope ?? {}
  const formId = pid(s, id ?? ['form', action.id, ...Object.values(bind ?? {})].join(':'))
  const shape = (action.schema as { shape?: object } | null)?.shape
  const buttons: ButtonProps[] = []
  const inner: Scope = { ...s, prefix: formId, form: { id: formId, action: action.id, fields: shape ? Object.keys(shape) : null, disabled: !!disabled } }
  const kids = scoped(children, inner, (el) => { if (el.type === Button) buttons.push(el.props as ButtonProps) })
  // Honesty rule: a form humans can't submit exposes no ActionRef to agents.
  const off = !!disabled || (buttons.length > 0 && buttons.every((b) => b.disabled))
  const intent = buttons.find((b) => b.intent)?.intent ?? action.id
  return (
    <>
      {quiet(s, register({ id: formId, type: 'form', data: { action: action.id, intent }, actions: off ? [] : [{ def: action, bindPayload: bind }] }))}
      <FormClient action={action.id} bind={off ? '' : bindFor(bind)} specs={paramSpecs(action.schema)} disabled={off} className={className}>{kids}</FormClient>
    </>
  )
}

// --- Input ------------------------------------------------------------------------------
// type 'file' renders a native file input; upload wiring lands with media (Task 17).
export function Input({ name, type = 'text', options, defaultValue, className, error, scope }: Scoped & {
  name: string; type?: 'text' | 'number' | 'email' | 'date' | 'checkbox' | 'file'
  options?: { value: string; label: string }[]; defaultValue?: unknown; className?: string
  error?: ComponentType<{ message: string }>
}) {
  const f = scope?.form
  if (f?.fields && !f.fields.includes(name) && dev()) {
    console.warn(`tvine: <Input name="${name}"> is not a param of ${f.action}; schema fields: ${f.fields.join(', ')}`)
  }
  const dv = defaultValue as string | number | undefined
  const field = options
    ? <select name={name} defaultValue={dv as string} className={className} disabled={f?.disabled || undefined}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    : <input name={name} type={type} className={className} disabled={f?.disabled || undefined}
        {...(type === 'checkbox' ? { defaultChecked: !!defaultValue } : { defaultValue: dv })} />
  return (
    <>
      {f && quiet(scope, register({ id: pid(scope, `input:${name}`), type: 'input', data: { name, type, ...(options && { options }) } }))}
      {field}
      {f && <FieldError name={name} error={error} />}
    </>
  )
}

// --- Button -----------------------------------------------------------------------------
export function Button({ intent, disabled, asChild, children, className, action, bind, id, scope }: ButtonProps) {
  if (action && !scope?.form) {
    // Single-action form sugar.
    return <Form action={action} bind={bind} id={id} scope={scope}><Button intent={intent} disabled={disabled} asChild={asChild} className={className}>{children}</Button></Form>
  }
  const off = disabled || scope?.form?.disabled || undefined
  if (asChild && isValidElement<Record<string, unknown>>(children)) {
    return cloneElement(children, { type: 'submit', ...(off && { disabled: true }), ...(className && { className }) })
  }
  return <button type="submit" disabled={off} className={className}>{children}</button>
}

for (const p of [Data, Section, Page, Link, List, Form, Input, Button]) PRIMS.add(p)
