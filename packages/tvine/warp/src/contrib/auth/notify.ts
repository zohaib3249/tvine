// Security notifications (settings.auth.notify): a short mail to the account's address when something security-relevant
// happens to it. Each kind is on by default whenever mail can go out (settings.email.backend is not 'dummy'). Sent in the
// background (tvine.tasks' tasks.sendMail when installed, else after commit) so a slow mail server never slows the
// request, and never fails it.
import type { Request, Settings } from '../../core/types.js'
import { sendMail } from '../../mail/index.js'
import { ipNetOf } from '../../security/ratelimit.js'
import { mac } from './crypto.js'
import { authLog } from './log.js'
import { KnownDevice } from './models.js'
import { uaSummary } from './sessions.js'

export type NoticeKind = 'newLogin' | 'passwordChanged' | 'twoFactorDisabled' | 'tokenCreated' | 'emailChanged'
const TEXT: Record<NoticeKind, [string, string]> = {
  newLogin: ['New sign-in to your account', 'Your account was just signed in to from a device we have not seen before.'],
  passwordChanged: ['Your password was changed', 'The password of your account was changed. Every other session was signed out.'],
  twoFactorDisabled: ['Two-factor authentication was turned off', 'Two-factor authentication was turned off for your account.'],
  tokenCreated: ['A new API token was created', 'A new personal API token was created for your account.'],
  emailChanged: ['Your email address was changed', 'The email address of your account was changed. This notice goes to the old address.'],
}

export const notifies = (s: Settings, kind: NoticeKind) => s.email?.backend !== 'dummy' && (s.auth?.notify?.[kind] ?? true)

export function securityNotice(s: Settings, kind: NoticeKind, to: { username?: string; email?: string | null }, request?: Request, extra = ''): void {
  if (!to.email || !notifies(s, kind)) return
  const [subject, body] = TEXT[kind]
  const where = request ? `\n\nWhen: ${new Date().toUTCString()}\nDevice: ${uaSummary(request.headers.get('user-agent') ?? '')}\nIP address: ${request.ip}` : ''
  const message = `Hi ${to.username ?? to.email},\n\n${body}${extra ? `\n${extra}` : ''}${where}\n\nIf this was not you, change your password now and review your signed-in sessions.\n`
  void sendMail({ subject, to: to.email, message }, { background: true }).catch(() => authLog.error('a security notice failed to send'))
}

// ip /24 (IPv4) or /64 (IPv6): a phone moving between cells of one network stays the same device
export const netOf = ipNetOf

// at login: a device (browser + OS + network) this user never signed in from → newLogin notice. Stored only as an HMAC.
// The very first sign-in of an account is not "new" (nothing to compare with).
export async function checkNewDevice(s: Settings, user: { id: number; username: string; email: string | null }, request: Request): Promise<void> {
  const digest = mac(s, 'device', `${user.id}|${uaSummary(request.headers.get('user-agent') ?? '')}|${netOf(request.ip)}`)
  const first = !(await KnownDevice.objects.filter({ userId: user.id }).exists())
  const [row, made] = await KnownDevice.objects.getOrCreate({ userId: user.id, digest }, { lastSeen: new Date() })   // race-safe
  if (!made) { await KnownDevice.objects.filter({ id: row.id }).update({ lastSeen: new Date() }); return }
  if (!first) securityNotice(s, 'newLogin', user, request)
}
