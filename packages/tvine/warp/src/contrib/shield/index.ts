// tvine/contrib/shield — tvine.shield: Cloudflare-style bot protection (docs/design/contrib/shield.md).
// installedApps: [..., 'tvine.shield'] + middleware 'tvine.middleware.Shield'. App code adds custom rules:
//   import { shield } from 'tvinejs/contrib/shield/index'; shield.registerRule('vip', (req, s) => s.country === 'IS' ? { type: 'allow' } : undefined)
import { registerRule } from './engine.js'
export { evaluate } from './conditions.js'
export { ShieldConfig, ShieldEvent, ShieldList, ShieldRule } from './models.js'
export type * from './types.js'
export const shield = { registerRule }
