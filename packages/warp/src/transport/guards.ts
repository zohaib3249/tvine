// settings.guards for every entry that names a page (HTTP, MCP, the human <Form>): path globs →
// permissions. Any deny or throwing permission → forbidden.
import type { Permission, Request, Session, Settings } from '../core/types.js'
import { runPermissions } from '../security/permissions.js'

export const FORBIDDEN_ROUTE = 'forbidden: agents may not access this route'

// Glob → RegExp: `**` any depth (also the base itself: '/admin/**' guards '/admin'), `*` one segment.
const globRe = (g: string) => new RegExp('^' + g.split('/**').map((p) =>
  p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:/.*)?') + '$')

type Check = (path: string, request: Request, session?: Session) => Promise<boolean>
const built = new WeakMap<Settings, Check>()

// `path` is the decoded, canonical site path. true = allowed.
export function guardCheck(settings: Settings): Check {
  let check = built.get(settings)
  if (check) return check
  const guards = settings.guards.map((g) => ({ re: globRe(g.path), permissions: g.permissions }))
  check = async (path, request, session) => {
    const perms: Permission[] = guards.filter((g) => g.re.test(path)).flatMap((g) => g.permissions)
    if (!perms.length) return true
    const s = session ?? { sid: '', rev: 0, data: new Map(), createdAt: 0, lastSeen: 0 }
    try {
      await runPermissions(perms, { sid: s.sid, session: s, route: request.route, user: request.user, agent: request.agent, ip: request.ip })
      return true
    } catch { return false }
  }
  built.set(settings, check)
  return check
}
