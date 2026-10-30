// Client-safe entry (default condition). Must never import runtime/registry or server-only.
export { useAgent } from './useAgent.client.js'
export type { ActionDef, ActionRef, AgentSpec, Link, Node } from './types.js'
export { useTvineChannel } from './runtime/socket.js'
export { AgentBadge } from './runtime/AgentBadge.js'
export type { TvineEvent } from './types.js'
export { registerWebMcp } from './runtime/webmcp.js'
// Weft v2 widget contract (W1).
export { useWidget } from './widget/useWidget.js'
export { defineWidget, type DefinedProps, type WidgetDef } from './widget/defineWidget.js'
export { WidgetScope, useWidgetScope } from './widget/scope.js'
export { WeftRoot } from './runtime/WeftRoot.js'
export { WeftError } from './widget/hooks.js'
export { ACTION_KINDS, signature } from './widget/vocabulary.js'
export type {
  ActionHandle, ActionKind, ActionOutcome, AgentActionEvent, AgentState, AutoChild, ChildPolicy, Control, ControlCtx,
  ControlOverrides, ErrCode, HeadlessMap, Json, Override, ParamSpec, Presence, PresenceOptions, UiStepResult,
  Widget, WidgetHandle, WidgetHooks, WidgetKind, WidgetSpec,
} from './widget/types.js'
