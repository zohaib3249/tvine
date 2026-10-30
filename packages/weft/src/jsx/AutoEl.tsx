'use client'
import { createContext, isValidElement, useCallback, useContext, useLayoutEffect, useRef, type JSX, type ReactNode, type Ref } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { describeWidget, widgetFragment } from '../runtime/fragment.js'
import { getRegistry, type Entry } from '../runtime/registry.client.js'
import { applyOverrides, WeftError } from '../widget/hooks.js'
import { joinId, segmentOf } from '../widget/ids.js'
import { WidgetScopeCtx, useWidgetScope } from '../widget/scope.js'
import type { AgentState, AutoChild, Control, ControlCtx, Json, WidgetSpec } from '../widget/types.js'
import { inputType, labelOf, nameOf, offByProps, roleOf, safeHref, sensitive, textOf, type Props } from './qualify.js'

// jsx-runtime.md: the client wrapper the JSX runtime puts around every qualifying intrinsic (also
// from RSC: this module is a 'use client' reference). Renders the real element unchanged and
// registers it under the nearest widget scope. Meaning comes from props; the only DOM reads are
// visibility/disabled at snapshot + call time, and the agent's own actions.

const dev = () => process.env.NODE_ENV !== 'production'

// agent={false} subtrees, <WeftRoot auto={false}>, and built-ins that own their parts.
const Off = createContext(false)
export function AutoOff({ children }: { children?: ReactNode }) {
  return <Off.Provider value>{children}</Off.Provider>
}

const AUTO = new WeakSet<object>()
// For snapshot builders (W4): an auto entry that is currently not visible/usable must be left out entirely.
export const autoExcluded = (spec: WidgetSpec): boolean => AUTO.has(spec) && !!spec.disabled

// --- controls: dispatch through the element so its own handlers run -----------------------------
type C = Control<any, any>
const bad = (field: string, msg: string) => new WeftError('invalid_param', msg, undefined, field)
const fire = (el: Element, ...types: string[]) => { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })) }
// React tracks `value` on the instance; the prototype setter makes the change visible to onChange.
const setValue = (el: Element, v: string) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, v)
const elOf = async <T extends HTMLElement>(c: ControlCtx): Promise<T> => {
  if (!c.el) throw new WeftError('unknown_action', 'element is not mounted')
  await c.presence.point(c.el)
  return c.el as T
}
const click: C = { kind: 'click', run: async (_, c) => { (await elOf(c)).click() } }
const typing = (secret: boolean): Record<string, C> => ({
  input: {
    kind: 'input',
    params: { text: { type: 'string', ...(secret && { secret: true }) }, mode: { type: 'string', enum: ['replace', 'append'], optional: true } },
    run: async (a: { text: string; mode?: string }, c) => {
      const el = await elOf<HTMLInputElement>(c)
      setValue(el, a.mode === 'append' ? el.value + a.text : String(a.text))
      fire(el, 'input', 'change')
    },
  },
  clear: { kind: 'clear', run: async (_, c) => { const el = await elOf<HTMLInputElement>(c); setValue(el, ''); fire(el, 'input', 'change') } },
})
const setTo = (value: object): C => ({
  kind: 'set', params: { value } as never,
  run: async (a: { value: unknown }, c) => {
    const el = await elOf<HTMLInputElement>(c), v = String(a.value)
    setValue(el, v)
    if (el.value !== v && !(el.type === 'color' && el.value === v.toLowerCase())) throw bad('value', `${v} is not a valid ${el.type} value`)
    fire(el, 'input', 'change')
  },
})
const MAX_UPLOAD = 5 * 1024 * 1024
const upload = (multiple: boolean): C => ({
  kind: 'upload', params: { files: { type: 'file', multiple: true } },
  run: async (a: { files: { name: string; type: string; dataBase64: string }[] }, c) => {
    const el = await elOf<HTMLInputElement>(c)
    if (!Array.isArray(a.files) || !a.files.length || (!multiple && a.files.length > 1)) throw bad('files', multiple ? 'files: one or more' : 'files: exactly one')
    const files = a.files.map((f) => new File([Uint8Array.from(atob(f.dataBase64), (ch) => ch.charCodeAt(0))], f.name, { type: f.type }))
    if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD) throw bad('files', 'files exceed 5 MB')
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    el.files = dt.files
    fire(el, 'input', 'change')
  },
})
// Option values from props (children <option>/<optgroup>); enum only when short enough to print.
function optionsOf(children: unknown, out: string[] = []): string[] {
  if (Array.isArray(children)) for (const ch of children) optionsOf(ch, out)
  else if (isValidElement<Props>(children)) {
    if (children.type === 'option') out.push(String(children.props.value ?? textOf(children.props.children).trim()))
    else if (children.type === 'optgroup') optionsOf(children.props.children, out)
  }
  return out
}
const choose = (p: Props): C => {
  const opts = optionsOf(p.children), multiple = !!p.multiple
  const spec = { type: 'string', ...(opts.length && opts.length <= 20 && { enum: opts }), ...(multiple && { multiple: true }) }
  return {
    kind: 'select', params: (multiple ? { values: spec } : { value: spec }) as never,
    run: async (a: { value?: string; values?: string[] }, c) => {
      const el = await elOf<HTMLSelectElement>(c)
      const want = (a.values ?? [a.value]).map(String), all = [...el.options]
      const miss = want.find((v) => !all.some((o) => o.value === v))
      if (miss !== undefined) throw bad(multiple ? 'values' : 'value', `no option ${miss}`)
      if (el.multiple) for (const o of all) o.selected = want.includes(o.value)
      else setValue(el, want[0]!)
      fire(el, 'input', 'change')
    },
  }
}
const key = (k: string, el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

function controlsOf(tag: string, role: string, p: Props, secret: boolean): Record<string, C> {
  switch (tag) {
    case 'a': if (safeHref(p.href)) return { navigate: { kind: 'navigate', headless: { url: p.href }, run: click.run } }; break
    case 'textarea': return typing(secret)
    case 'select': return { select: choose(p) }
    case 'form': return { submit: { kind: 'submit', run: async (_, c) => { (await elOf<HTMLFormElement>(c)).requestSubmit() } } }
    case 'details': return {
      open: { kind: 'open', run: async (_, c) => { (await elOf<HTMLDetailsElement>(c)).open = true } },
      close: { kind: 'close', run: async (_, c) => { (await elOf<HTMLDetailsElement>(c)).open = false } },
    }
    case 'input': switch (role) {
      case 'checkbox': case 'switch': return { toggle: { kind: 'toggle', params: { on: { type: 'boolean', optional: true } },
        run: async (a: { on?: boolean }, c) => { const el = await elOf<HTMLInputElement>(c); if (a.on === undefined || el.checked !== a.on) el.click() } } }
      case 'radio': return { select: { kind: 'select', run: async (_, c) => { const el = await elOf<HTMLInputElement>(c); if (!el.checked) el.click() } } }
      case 'slider': return { set: setTo({ type: 'number', min: Number(p.min ?? 0), max: Number(p.max ?? 100), ...(p.step !== undefined && { step: Number(p.step) }) }) }
      case 'date': return { set: setTo({ type: 'date' }) }
      case 'color': return { set: setTo({ type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }) }
      case 'file': return { upload: upload(!!p.multiple) }
      case 'button': return { click }
      default: return typing(secret)
    }
  }
  if (role === 'slider' || role === 'spinbutton') return {
    set: { kind: 'set', params: { dir: { type: 'string', enum: ['up', 'down'] } },
      run: async (a: { dir: string }, c) => key(a.dir === 'down' ? 'ArrowDown' : 'ArrowUp', await elOf(c)) },
  }
  return { click }
}

// --- state: from the element when mounted, else from props --------------------------------------
const ARIA = ['pressed', 'expanded', 'selected', 'checked'] as const
function stateOf(tag: string, role: string, p: Props, el: HTMLElement | null): Json | undefined {
  const i = el as (HTMLInputElement & HTMLSelectElement & HTMLDetailsElement) | null
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (role === 'checkbox' || role === 'radio') return { checked: i ? i.checked : !!(p.checked ?? p.defaultChecked) }
    if (role === 'file') return { files: i?.files ? [...i.files].map((f) => f.name) : [] }
    if (tag === 'select' && p.multiple) return { values: i ? [...i.selectedOptions].map((o) => o.value) : [] }
    if (role === 'button') return undefined
    return { value: i ? i.value : String(p.value ?? p.defaultValue ?? '') }
  }
  if (tag === 'details') return { open: i ? i.open : !!p.open }
  const s: Record<string, boolean> = {}
  for (const k of ARIA) { const v = p[`aria-${k}`]; if (v !== undefined) s[k] = v === true || v === 'true' }
  return Object.keys(s).length ? s : undefined
}

// Visibility / disabled re-checked at snapshot and call time (portals, modal inert, fieldsets).
const domOff = (el: HTMLElement | null) => !!el && (el.closest('[inert],[aria-hidden="true"],[hidden]') !== null ||
  el.matches(':disabled') || (el as { checkVisibility?: () => boolean }).checkVisibility?.() === false)

interface Cur { tag: string; role: string; p: Props; name?: string; parent: string; id: string; el: HTMLElement | null }

// A spec whose fields are read live: props of the last commit, the element, the parent's ChildPolicy
// (applied lazily — the parent registers after its children in layout-effect order).
function autoSpec(r: { current: Cur }): WidgetSpec {
  const applied = () => {
    const { tag, role, p, name, parent, id } = r.current
    const label = labelOf(tag, p) || (tag === 'input' && (r.current.el as HTMLInputElement | null)?.labels?.[0]?.textContent?.trim().slice(0, 40)) || role
    let controls = controlsOf(tag, role, p, sensitive(tag, p))
    if (p.agentConfirm) controls = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, { ...c, confirm: p.agentConfirm as boolean | string }]))
    const base = { label, controls, hidden: false, hooks: undefined as WidgetSpec['hooks'], presence: undefined as WidgetSpec['presence'] }
    const policy = getRegistry().get(parent)?.spec.children
    if (!policy) return base
    const child: AutoChild = { id, role, name: name ?? '?', label, tag, props: p, ...(tag === 'a' && typeof p.href === 'string' && { href: p.href }) }
    const out = policy(child)
    if (out === false) return { ...base, hidden: true }
    if (!out || typeof out !== 'object') return base   // 'group': reserved (not applied yet)
    const o = out as Partial<Pick<WidgetSpec, 'label' | 'controls' | 'hooks' | 'presence'>>
    return { label: o.label || label, controls: o.controls ? applyOverrides(controls, o.controls as never) : controls, hidden: false, hooks: o.hooks, presence: o.presence }
  }
  const s: WidgetSpec = {
    get kind() { return r.current.role as WidgetSpec['kind'] },
    get name() { return r.current.name },
    get label() { return applied().label },
    get sensitive() { return sensitive(r.current.tag, r.current.p) },
    get state() { return stateOf(r.current.tag, r.current.role, r.current.p, r.current.el) },
    get controls() { return applied().controls },
    get hooks() { return applied().hooks },
    get presence() { return applied().presence },
    get disabled() { return applied().hidden || domOff(r.current.el) },
  }
  AUTO.add(s)
  return s
}

const SCOPES = new Set(['form', 'details'])
const hinted = new Set<string>()

type AutoProps = Props & { $tag: string; $key?: string; $s?: boolean; ref?: Ref<HTMLElement> }

export function AutoEl(props: AutoProps) {
  const { $tag: tag, $key, $s, ref: userRef, agent, agentId: _i, agentLabel: _l, agentConfirm: _c, agentSensitive: _x, ...rest } = props
  const p = props as Props   // names/labels/confirm read the agent props too
  const off = useContext(Off)
  const parent = useWidgetScope()
  const role = off || agent === false ? null : roleOf(tag, rest)
  const live = role !== null && !offByProps(rest)
  const name = live ? nameOf(tag, p, $key) : undefined
  const base = !live ? '' : name === undefined ? joinId(parent, `${role}:?`) : joinId(parent, segmentOf({ kind: role as WidgetSpec['kind'], name }))

  const cur = useRef<Cur>(null as unknown as Cur)
  cur.current ??= { tag, role: role ?? '', p, name, parent, id: base, el: null }
  const spec = useRef<WidgetSpec | null>(null)
  spec.current ??= autoSpec(cur)

  const ref = useCallback((node: HTMLElement | null) => {
    cur.current.el = node
    if (typeof userRef === 'function') {
      const cleanup = userRef(node)
      if (typeof cleanup === 'function') return () => { cur.current.el = null; cleanup() }
    } else if (userRef) (userRef as { current: HTMLElement | null }).current = node
  }, [userRef])

  // Every commit: pointer writes only (no subscribers, nothing re-renders).
  useLayoutEffect(() => { Object.assign(cur.current, { tag, role: role ?? '', p, name, parent }) })

  useLayoutEffect(() => {
    if (!base) return
    const reg = getRegistry()
    let id = base
    for (let n = 2; reg.get(id); n++) id = `${base}#${n}`
    if (dev()) {
      if (name === undefined) console.warn(`tvine: <${tag}> under "${parent || 'page'}" has no name for agents (listed as ${id}); add agentId, aria-label or text`)
      else if (id !== base) console.warn(`tvine: two ${role} "${name}" under "${parent || 'page'}" (now ${id}); add agentId or key`)
      if (tag === 'form' && typeof p.action === 'function' && !hinted.has(base)) {
        hinted.add(base)
        console.warn(`tvine: <form> ${base} posts to a raw server action: agents can submit it in the tab only, not headless. Use <Form action={…}> / defineAction for headless agents.`)
      }
    }
    cur.current.id = id
    const e: Entry = {
      id, parent, kind: role!, spec: spec.current!, el: cur.current.el, token: Symbol(id), order: 0,
      agent: (a: AgentState) => {
        const el = cur.current.el
        if (!el) return
        el.toggleAttribute('data-agent-active', a.active)
        if (a.active && a.verb) el.setAttribute('data-agent-verb', a.verb)
        else el.removeAttribute('data-agent-verb')
      },
    }
    Object.defineProperty(e, 'el', { get: () => cur.current.el, set: () => {} })   // always the live node
    return reg.register(e)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-register only when the address changes
  }, [base])

  const el = ($s ? jsxs : jsx)(tag as keyof JSX.IntrinsicElements, { ...rest, ref })
  if (agent === false) return <AutoOff>{el}</AutoOff>
  if (!live) return el
  const scoped = SCOPES.has(tag) ? <WidgetScopeCtx.Provider value={base}>{el}</WidgetScopeCtx.Provider> : el
  if (tag !== 'a' || !safeHref(rest.href)) return scoped
  // Plain links are headless too: a v2 fragment with a url map (pure props → identical on SSR and hydration).
  const frag = widgetFragment(describeWidget(base, parent, {
    kind: role as WidgetSpec['kind'], label: labelOf(tag, p) || rest.href as string,
    controls: { navigate: { kind: 'navigate', headless: { url: rest.href as string }, run: () => {} } },
  }))
  return <>{frag}{scoped}</>
}
