// Dev twin of jsx-runtime.ts: same swap, React's jsxDEV underneath (keeps source/owner/key checks).
import { Fragment, jsxDEV as rjsxDEV } from 'react/jsx-dev-runtime'
import { AutoEl } from './AutoEl.js'
import { wraps, type Props } from './qualify.js'

export { Fragment }
export type { AgentProps, JSX } from './jsx-runtime.js'

export const jsxDEV: typeof rjsxDEV = (type, props, key, isStatic, source, self) =>
  typeof type === 'string' && wraps(type, props as Props)
    ? rjsxDEV(AutoEl, { ...(props as Props), $tag: type, $key: key, ...(isStatic && { $s: true }) } as never, key, isStatic, source, self)
    : rjsxDEV(type, props, key, isStatic, source, self)
