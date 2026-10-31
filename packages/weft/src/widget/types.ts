// Widget contract types (docs/design/frontend/v2/core/widget-contract.md, custom-logic.md,
// headless-parity.md, control-protocol.md). Client-safe: no runtime code here.
import type { ReactElement, ReactNode } from 'react'
import type { ActionRef } from '../types.js'

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export type ActionKind =
  | 'click' | 'input' | 'clear' | 'select' | 'toggle' | 'set' | 'open' | 'close'
  | 'submit' | 'navigate' | 'scroll' | 'focus' | 'move' | 'upload'

// Built-in widget kinds (one per widgets/*.md). Custom kinds use the `x-` prefix.
export type WidgetKind =
  | 'section' | 'data' | 'card' | 'cart-badge' | 'button' | 'link' | 'pagination' | 'menu' | 'context-menu'
  | 'form' | 'input' | 'textarea' | 'select' | 'combobox' | 'checkbox' | 'radio' | 'switch' | 'slider'
  | 'date' | 'file' | 'quantity' | 'rating' | 'tabs' | 'accordion' | 'stepper' | 'dialog' | 'drawer'
  | 'popover' | 'tooltip' | 'toast' | 'list' | 'table' | 'tree' | 'carousel'

// Mirror of warp core/types ErrCode (weft does not import warp).
export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal' | 'human_only'

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'date' | 'file' | 'json'
  enum?: readonly string[]
  min?: number; max?: number; step?: number
  maxLength?: number; pattern?: string
  multiple?: boolean
  optional?: boolean
  secret?: boolean
}

// Server → client seam: produced by bindAction (W6) in RSC; plain JSON.
export interface ActionHandle {
  id: string; params: ActionRef['params']
  bind: string
  agent: boolean
  ro?: true; danger?: true
  attention?: true | string
  humanOnly?: true | string       // the action has rules.humanOnly (dispatch refuses agents); dev warning only
}
export type ActionOutcome = { ok: true; result?: Json; goto?: string } | { ok: false; code: ErrCode; field?: string; message: string }

export type HeadlessMap =
  | { url: string; values?: 'enum' | 'any' }
  | { rendered: true }
  | { params: ActionHandle; field?: string }
  | { session: string; enum?: string[] }

// Presence surface a control may drive (implemented by W4; no-op until then).
export interface Presence {
  point(el: HTMLElement | null): Promise<void>
  type(el: HTMLElement | null, text: string): Promise<void>
  say(text: string): void
}
export interface PresenceOptions {
  outline?: boolean; cursor?: boolean; label?: boolean
  typing?: 'animate' | 'instant'; cps?: number; holdMs?: number
  labels?: (e: { verb: ActionKind; label: string; control: string }) => string
}

export interface WidgetHandle { id: string; kind: string; state: Json; call(control: string, args?: object): Promise<Json | void> }

export interface ControlCtx {
  source: 'agent' | 'gallery'
  via: 'webmcp' | 'tab' | 'inspector'
  cmdId: string
  signal: AbortSignal
  el: HTMLElement | null
  presence: Presence
  run(action: ActionHandle, params?: Record<string, unknown>): Promise<ActionOutcome>
  navigate(href: string): Promise<void>
  child(localOrFullId: string): WidgetHandle | undefined
  veto(reason: string): never
}

export interface Control<A extends Record<string, unknown> = Record<string, unknown>, R = Json | void> {
  kind: ActionKind
  params?: { [K in keyof A]: ParamSpec }
  run(args: A, ctx: ControlCtx): R | Promise<R>
  enabled?: boolean
  label?: string
  confirm?: boolean | string
  headless?: HeadlessMap
}

export type UiStepResult =
  | { i: number; target: string; ok: true; state?: Json; result?: Json }
  | { i: number; target: string; ok: false; code: ErrCode; reason?: string; field?: string; message: string; maybeApplied?: true }

export interface AgentActionEvent {
  target: string; control: string; args: Readonly<Record<string, unknown>>; via: ControlCtx['via']; cmdId: string
  danger?: true
  attention?: true | string
  agent?: { name: string; verified: false }
}
export interface WidgetHooks {
  // false → veto with a generic reason; string → veto with that reason
  onAgentAction?(e: AgentActionEvent): void | false | string | Promise<void | false | string>
  afterAgentAction?(e: AgentActionEvent & { outcome: UiStepResult }): void
  onAgentFocus?(active: boolean): void
}

// jsx-runtime.md (W3 applies it).
export interface AutoChild { id: string; role: string; name: string; label: string; href?: string; tag: string; props: Readonly<Record<string, unknown>> }
export type ChildPolicy = (c: AutoChild) => AutoChild | Partial<Pick<WidgetSpec, 'label' | 'controls' | 'hooks' | 'presence'>> | false | 'group'

export interface WidgetSpec<S extends Json = Json> {
  id?: string                                  // local segment; default `${kind}:${name ?? data.id ?? data.key}`
  name?: string
  kind: WidgetKind | `x-${string}`
  label: string
  sum?: string                                 // L0 one-liner (progressive-disclosure.md)
  state?: S
  controls?: Record<string, Control<any, any>>
  data?: Record<string, unknown>
  entity?: string                              // global id, e.g. 'product:12' — the widget's id IS this
  summary?: string[]
  detail?: string[]
  hidden?: string[]
  collapsed?: boolean
  changesContent?: boolean
  disabled?: boolean
  personal?: boolean
  sensitive?: boolean
  humanOnly?: string                           // set by <HumanOnly reason>: shown locked, no controls, agents refused
  presence?: false | PresenceOptions
  hooks?: WidgetHooks
  children?: ChildPolicy
  rows?: { count: number; get(offset: number, limit: number): Json[] }
}

export interface AgentState { active: boolean; verb?: ActionKind }

export interface Widget {
  id: string
  ref: (el: HTMLElement | null) => void
  props: { 'data-tvine-id': string; 'data-agent-active'?: ''; 'data-agent-verb'?: ActionKind }
  embed: ReactElement | null
  Scope: (p: { children: ReactNode }) => ReactElement
  agent: AgentState
}

export type Override = false | Partial<Control<any, any>> | ((args: any, ctx: ControlCtx, next: (args?: any) => Promise<any>) => any)
export type ControlOverrides<C> = { [K in keyof C]?: Override } & Record<string, Override | Control<any, any> | undefined>
