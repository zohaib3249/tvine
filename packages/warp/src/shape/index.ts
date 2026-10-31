// @tvine/warp/shape — the browser-safe shaper (Warp on SSR fragments, Weft on the in-tab registry).
// JSON: a Shaped minus `view` IS the v2 JSON body (snapshot-format.md); notation: notationBody().
export { toTree, disclose, expand, level, est, signature, kindOfWidget, entityType } from './disclose.js'
export type { Shaped, SnapNode, SnapTree, ShapeSource, WidgetFrag, CtlFrag, ParamSpec, ActionRef, V1Node, V1Link, NavLink, View } from './disclose.js'
export { notationBody, cell, quote, bare, UNTRUSTED, UNTRUSTED_TOOL } from './notation.js'
export { sanitizeHtml, safeHref } from './rich.js'
