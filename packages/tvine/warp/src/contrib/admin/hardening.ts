// Staff hardening for every admin action (settings.admin): allowIps (also an IpFilter on the panel path, settings.ts),
// require2fa (staff without a confirmed TOTP must set it up first) and idleMs (a shorter idle timeout for admin use).
import { securityEvent } from '../../core/audit.js'
import { DomainError } from '../../core/errors.js'
import type { Permission, Settings } from '../../core/types.js'
import { blockList, ipIn } from '../../middleware/index.js'
import { isStaff } from '../../security/permissions.js'
import { loadedSettings } from '../../security/signing.js'

const ADMIN_SEEN = '_admin_seen'
// same compiled list as IpFilter (middleware.blockList); WeakMap keyed by the settings array reference
const lists = new WeakMap<string[], ReturnType<typeof blockList>>()
export function ipAllowed(ip: string, list: string[]): boolean {
  let b = lists.get(list)
  if (!b) {
    b = blockList(list, 'admin.allowIps')
    lists.set(list, b)
  }
  return ipIn(b, ip)
}

export const staffGuard: Permission = async (ctx) => {
  if (!(await isStaff(ctx))) return false
  const a = (loadedSettings() as Settings | undefined)?.admin
  if (!a) return true
  if (a.allowIps?.length && !ipAllowed(ctx.ip, a.allowIps)) {
    securityEvent('ip_refused', { ip: ctx.ip, path: a.path, layer: 'admin' }, { settings: loadedSettings() as Settings })
    return false
  }
  const s = ctx.session, now = Date.now()
  if (a.idleMs && s) {
    // the later of the last admin use and the last sign-in (a fresh login always resets the clock)
    const at = (k: string) => { const v = s.data.get(k); return typeof v === 'number' ? v : 0 }
    const seen = Math.max(at(ADMIN_SEEN), at('_auth_login_at'))
    if (seen && now - seen > a.idleMs) throw new DomainError('reauth_required', 'the admin session timed out; sign in again')
    s.data.set(ADMIN_SEEN, now)
  }
  if (a.require2fa && ctx.user.id !== undefined) {
    const { hasSecondFactor } = await import('../auth/backend.js')
    if (!(await hasSecondFactor(Number(ctx.user.id)))) throw new DomainError('two_factor_required', 'staff must turn on two-factor authentication first (auth.totpBegin, auth.totpConfirm)')
  }
  return true
}

// the admin's live channel groups (transport/channel.ts): admin:live = staffGuard, admin:logs = staffGuard + superuser.
// Checked on a copy of the session: an open stream must not count as admin use (idleMs keeps running).
export async function adminGroupAllowed(group: string, ctx: Parameters<Permission>[0]): Promise<boolean> {
  const session = { ...ctx.session, data: new Map(ctx.session.data) }
  try {
    if (!(await staffGuard({ ...ctx, session }))) return false
  } catch { return false }   // reauth_required / two_factor_required
  return group !== 'admin:logs' || (ctx.user.isSuperuser === true && ctx.user.isActive !== false)
}
