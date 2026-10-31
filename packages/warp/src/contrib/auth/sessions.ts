// auth.sessions (docs/design/contrib/auth.md §sessions): every signed-in session has a row (UserSession). The session
// data holds a random key; the row holds its sha256, which is also the id users see (never the sid). A session whose
// row is gone is signed out on its next request, so revoking works on every session store (memory, redis).
import type { ActionCtx, Session } from '../../core/types.js'
import { random62, sha256 } from './crypto.js'
import { UserSession } from './models.js'

export const SESSION_KEY = '_auth_session_key'
const SEEN_MS = 60_000

const keyOf = (s: Session) => { const k = s.data.get(SESSION_KEY); return typeof k === 'string' ? sha256(k) : undefined }

// at login (after the credential check, in the same transaction): a fresh row; the session's previous row goes
export async function recordSession(ctx: Pick<ActionCtx, 'session' | 'request'>, userId: number): Promise<void> {
  const old = keyOf(ctx.session)
  if (old) await UserSession.objects.filter({ key: old }).delete()
  const key = random62(32)
  ctx.session.data.set(SESSION_KEY, key)
  await UserSession.create({ userId, key: sha256(key), ip: ctx.request.ip, userAgent: (ctx.request.headers.get('user-agent') ?? '').slice(0, 300), lastSeen: new Date() })
}

// sessionUser: still listed for this user? A session from before this feature (no key) stays valid.
export async function sessionAlive(session: Session, userId: number): Promise<boolean> {
  const key = keyOf(session)
  if (!key) return true
  const row = await UserSession.objects.filter({ key }).first()
  if (!row || row.userId !== userId) return false
  // at most once a minute, outside the request's transaction; a failed stamp never fails the request
  if (Date.now() - row.lastSeen.getTime() > SEEN_MS) void UserSession.objects.filter({ id: row.id }).update({ lastSeen: new Date() }).catch(() => undefined)
  return true
}

export const forgetSession = async (session: Session) => { const k = keyOf(session); if (k) await UserSession.objects.filter({ key: k }).delete() }
// every session of the user except `keep` (logoutOthers, password change / reset)
export const dropOtherSessions = (userId: number, keep?: Session) =>
  UserSession.objects.filter({ userId }).exclude(keep && keyOf(keep) ? { key: keyOf(keep)! } : { id: -1 }).delete()

// 'Chrome on macOS' from a user agent (rough on purpose: it is a hint for a person, not a fingerprint)
export function uaSummary(ua: string): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : ua ? (ua.split(/[\s/]/)[0] ?? 'Unknown').slice(0, 30) : 'Unknown'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} on ${os}` : b
}

export async function listSessions(userId: number, current?: Session) {
  const cur = current && keyOf(current)
  return (await UserSession.objects.filter({ userId }).order('-lastSeen').all(200)).map((r) => ({
    id: r.key, createdAt: r.createdAt.toISOString(), lastSeen: r.lastSeen.toISOString(), ip: r.ip, device: uaSummary(r.userAgent), current: r.key === cur,
  }))
}
