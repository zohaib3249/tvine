// MCP visibility without pulling the MCP SDK (HTTP agent snapshots share this).
import type { ActionDef, ActionId, Settings, Snapshot } from '../core/types.js'
import type { ServerCtx } from '../core/dispatch.js'

const globs = new Map<string, RegExp>()
/** settings.mcp.exclude globs: `*` = one dotted segment, `**` = any depth. */
export function mcpExcludeGlob(p: string): RegExp {
  let re = globs.get(p)
  if (!re) {
    const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    globs.set(p, (re = new RegExp(`^${p.split('**').map((s) => s.split('*').map(esc).join('[^.]*')).join('.*')}$`)))
  }
  return re
}
const glob = mcpExcludeGlob

/** action rules.mcp > settings.mcp.exclude. */
export function mcpEnabled(def: ActionDef, settings: Settings): boolean {
  const own = def.rules?.mcp
  return own !== undefined ? own : !settings.mcp.exclude.some((p) => glob(p).test(def.id))
}

/** Drop actions disabled for MCP so agent snapshots / manifest match MCP tool listing (not agent-HTTP callability). */
export function filterMcpSnapshot(server: ServerCtx, s: Snapshot): Snapshot {
  const off = (id: ActionId) => { const d = server.actions.get(id); return !!d && !mcpEnabled(d, server.settings) }
  const out = { ...s, nodes: s.nodes.map((n) => ({ ...n, actions: n.actions.filter((a) => !off(a.id)) })) }
  const offCtl = (h: unknown) => { const x = h as { params?: { id?: unknown }; call?: unknown } | undefined; const id = x?.params?.id ?? x?.call; return typeof id === 'string' && off(id) }
  if (s.widgets) out.widgets = s.widgets.map((w) => ({
    ...w,
    ...(w.actions && { actions: w.actions.filter((a) => !off(a.id)) }),
    ...(w.ctl && { ctl: Object.fromEntries(Object.entries(w.ctl).filter(([, c]) => !offCtl(c.h))) }),
  }))
  return out
}
