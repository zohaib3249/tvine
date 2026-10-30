// react-server entry: registry + server useAgent + primitives.
export { pageFragment, register, registerLink, setSigner,
  type RegisteredAction, type RegisterInput, type Signer } from './runtime/registry.js'
export { registerAgent, useAgent } from './useAgent.js'
export { Button, Data, Form, Input, Link, List, Page, Section, type Scope } from './primitives.js'
export { setDispatcher, type Dispatcher, type FormResult } from './runtime/dispatcher.js'
export type { ActionDef, ActionRef, AgentSpec, Command, Link as LinkSpec, Node, Paginated } from './types.js'
// v2: client components a server component renders directly ('use client' boundaries).
export { WeftRoot } from './runtime/WeftRoot.js'
export { WidgetScope } from './widget/scope.js'
export type { ActionHandle, HeadlessMap, Json, WidgetHooks, WidgetSpec } from './widget/types.js'
