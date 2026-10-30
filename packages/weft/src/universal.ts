// What TypeScript sees for `@tvine/weft` under its default conditions. TS does not know `react-server`
// (a stock Next tsconfig sets no customConditions), so this carries the client API AND the server
// primitives, letting server components import them from the root. Types only: the exports map never
// sends a bundler here. Under react-server a primitive is the real one; in a client bundle it is absent.
import type { ReactElement } from 'react'
import { Link as LinkPrimitive } from './primitives.js'
import { useAgent as serverUseAgent } from './useAgent.js'
import type { AgentSpec, Link as LinkSpec } from './types.js'

export { AgentBadge, registerWebMcp, useTvineChannel, type TvineEvent } from './index.js'
export {
  ACTION_KINDS, defineWidget, signature, useWidget, useWidgetScope, WeftError,
  type ActionKind, type ActionOutcome, type AgentActionEvent, type AgentState, type AutoChild, type ChildPolicy, type Control,
  type ControlCtx, type ControlOverrides, type DefinedProps, type ErrCode, type Override, type ParamSpec, type Presence,
  type PresenceOptions, type UiStepResult, type Widget, type WidgetDef, type WidgetHandle, type WidgetKind,
} from './index.js'
export * from './server.js'   // useAgent and Link are re-declared below: they differ per condition
export const Link: typeof LinkPrimitive = LinkPrimitive
export type Link = LinkSpec
export const useAgent: (type: string, spec: AgentSpec) => ReactElement | null = serverUseAgent
