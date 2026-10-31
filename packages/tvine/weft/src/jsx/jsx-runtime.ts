// `jsxImportSource: "tvine/weft"` (jsx-runtime.md). Thin wrappers over React's runtime: a
// non-qualifying element is React's own result; a qualifying intrinsic becomes <AutoEl> with the
// same props and key. The same module serves RSC: AutoEl is a 'use client' reference there.
import type { JSX as R } from 'react'
import { Fragment, jsx as rjsx, jsxs as rjsxs } from 'react/jsx-runtime'
import { AutoEl } from './AutoEl.js'
import { wraps, type AgentProps, type Props } from './qualify.js'

export { Fragment }
export type { AgentProps }

export const jsx: typeof rjsx = (type, props, key) =>
  typeof type === 'string' && wraps(type, props as Props)
    ? rjsx(AutoEl, { ...(props as Props), $tag: type, $key: key } as never, key)
    : rjsx(type, props, key)

export const jsxs: typeof rjsxs = (type, props, key) =>
  typeof type === 'string' && wraps(type, props as Props)
    ? rjsxs(AutoEl, { ...(props as Props), $tag: type, $key: key, $s: true } as never, key)
    : rjsxs(type, props, key)

// React's JSX namespace with the agent-only props on every intrinsic element.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JSX {
  export type ElementType = R.ElementType
  export interface Element extends R.Element {}
  export interface ElementClass extends R.ElementClass {}
  export interface ElementAttributesProperty extends R.ElementAttributesProperty {}
  export interface ElementChildrenAttribute extends R.ElementChildrenAttribute {}
  export type LibraryManagedAttributes<C, P> = R.LibraryManagedAttributes<C, P>
  export interface IntrinsicAttributes extends R.IntrinsicAttributes {}
  export interface IntrinsicClassAttributes<T> extends R.IntrinsicClassAttributes<T> {}
  export type IntrinsicElements = { [K in keyof R.IntrinsicElements]: R.IntrinsicElements[K] & AgentProps }
}
