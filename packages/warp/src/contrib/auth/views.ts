// tvine.auth actions (docs/design/contrib/auth.md §3): every flow runs through dispatch — permissions, rate
import { securityEvent } from '../../core/audit.js'
// limits, one transaction. Secrets are only ever returned once, by the action that creates them.
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, Permission, TvineUser } from '../../core/types.js'
import { onCommit } from '../../data/engine.js'
import { sendMail } from '../../mail/index.js'
import { denyAgents, isAuthenticated } from '../../security/permissions.js'
import {
  AuthUser, checkResetToken, checkSecondFactor, hasSecondFactor, INVALID, login, logout, makeResetToken, newRecoveryCodes,
  newToken, newTotpSecret, normCode, recentlyAuthenticated, revokeTokens, safeUser, totpStep, totpUri, uidOf, userOfUid, type SafeUser,
} from './backend.js'
import { base32, sha256 } from './crypto.js'
import { RecoveryCode, Token, Totp, User, UserSession } from './models.js'
import { dropOtherSessions, forgetSession, listSessions } from './sessions.js'
import { checkNewDevice, securityNotice } from './notify.js'
import { exportToMedia } from './privacy.js'
import { checkPassword, dummyCheck, makePassword, MAX_PASSWORD, validateNewPassword } from './passwords.js'
import { throttleOf } from './throttle.js'
import type { Limiter } from '../../security/ratelimit.js'
import { limiterFor } from '../../backends/index.js'
import type { Settings } from '../../core/types.js'

const resetRates = new WeakMap<Settings, Limiter>()
const resetRate = (s: Settings) => { let r = resetRates.get(s); if (!r) resetRates.set(s, (r = limiterFor(s, { limit: 3, windowMs: 3_600_000 }))); return r }   // settings.limits.backend
const accountRates = new WeakMap<Settings, Limiter>()
const accountRate = (s: Settings) => { let r = accountRates.get(s); if (!r) accountRates.set(s, (r = limiterFor(s, { limit: 10, windowMs: 3_600_000 }))); return r }

const pw = () => z.string().min(1).max(MAX_PASSWORD)
const me = (ctx: ActionCtx) => ctx.request.user as AuthUser

// the session user (not a token): token holders cannot mint tokens or change credentials
function sessionOnly(ctx: ActionCtx): AuthUser {
  const u = ctx.request.user
  if (!(u instanceof AuthUser) || u.via !== 'session') throw new DomainError('forbidden', 'forbidden: sign in with a password for this')
  return u
}

const reject = (problems: string[], field: string) => {
  if (problems.length) throw new DomainError('invalid_param', problems.join(' '), field)
}

// sudo mode for secret-minting actions: a fresh login, or the current password now (throttled like login)
async function reauth(ctx: ActionCtx, u: AuthUser, password: string | undefined): Promise<void> {
  if (password === undefined) {
    if (recentlyAuthenticated(ctx)) return
    throw new DomainError('reauth_required', 'confirm your password (send password) to do this', 'password')
  }
  await locked(ctx, u.username)
  const row = (await User.get(Number(u.id)))!
  if (!(await checkPassword(password, row.password, ctx.settings)).ok) {
    await throttleOf(ctx.settings).fail(u.username, ctx.request.ip)
    throw new DomainError('invalid_credentials', 'the password is not correct', 'password')
  }
}

async function locked(ctx: ActionCtx, username: string): Promise<void> {
  if (await throttleOf(ctx.settings).locked(username, ctx.request.ip)) {
    securityEvent('lockout', { username: username.slice(0, 150) }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid })
    throw new DomainError('locked', 'too many failed attempts; try again later')
  }
}
const loginFailed = (ctx: ActionCtx, username: string, why: string) =>
  securityEvent('login_failed', { username: username.slice(0, 150), why }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid })

// secreview L1: an agent acting in the human's tab (the tab channel, WebMCP, the inspector) never signs that browser in
// or out. An agent on its own sid (HTTP/MCP) still may: that session is its own.
const notInTab: Permission = (ctx) => !(ctx.agent?.is && ['channel', 'webmcp', 'inspector'].includes(String(ctx.agent.via)))

export const loginAction = defineAction('login', z.object({
  username: z.string().min(1).max(150),
  password: pw(),
  otp: z.string().max(32).optional(),
}), async ({ username, password, otp }, ctx): Promise<SafeUser> => {
  const t = throttleOf(ctx.settings), ip = ctx.request.ip
  await locked(ctx, username)
  const row = await User.objects.filter({ username: username.normalize('NFKC') }).first()
  const { ok, upgrade } = row?.isActive ? await checkPassword(password, row.password, ctx.settings) : { ok: await dummyCheck(password, ctx.settings), upgrade: false }
  if (!row || !ok) { await t.fail(username, ip); loginFailed(ctx, username, 'password'); throw INVALID() }
  if (await hasSecondFactor(row.id)) {
    if (!otp) throw new DomainError('otp_required', 'enter the code from your authenticator app (or a recovery code) as otp')
    if (!(await checkSecondFactor(ctx.settings, row.id, otp))) { await t.fail(username, ip); loginFailed(ctx, username, 'otp'); throw INVALID() }
  }
  await t.succeed(username, ip)
  securityEvent('login_ok', { userId: row.id }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid })
  const current = upgrade ? await User.update(row.id, { password: await makePassword(password, ctx.settings) }) : row
  await checkNewDevice(ctx.settings, row, ctx.request)
  return safeUser(await login(ctx, current))
}, { rate: { limit: 10, windowMs: 60_000 }, permissions: [notInTab] })

export const logoutAction = defineAction('logout', z.object({}), async (_p, ctx) => { await forgetSession(ctx.session); logout(ctx); return null }, { permissions: [notInTab] })

export const meAction = defineAction('me', z.object({}), async (_p, ctx): Promise<SafeUser | null> => {
  const u: TvineUser = ctx.request.user
  return u instanceof AuthUser ? safeUser(u) : null
}, { readOnly: true })

export const changePassword = defineAction('changePassword', z.object({ oldPassword: pw(), newPassword: pw() }), async ({ oldPassword, newPassword }, ctx) => {
  const u = sessionOnly(ctx)
  await locked(ctx, u.username)
  const row = (await User.get(Number(u.id)))!
  if (!(await checkPassword(oldPassword, row.password, ctx.settings)).ok) {
    await throttleOf(ctx.settings).fail(u.username, ctx.request.ip)
    throw new DomainError('invalid_credentials', 'the current password is not correct', 'oldPassword')
  }
  reject(await validateNewPassword(newPassword, ctx.settings, row), 'newPassword')
  const fresh = await User.update(row.id, { password: await makePassword(newPassword, ctx.settings) })
  await revokeTokens(row.id)
  // update_session_auth_hash: this session is re-bound to the new hash (on a new sid); every other one is now stale
  await login(ctx, fresh)
  await dropOtherSessions(row.id, ctx.session)
  securityNotice(ctx.settings, 'passwordChanged', row, ctx.request)
  return null
}, { permissions: [isAuthenticated, denyAgents] })

// Always ok: the answer (and its timing: sending happens after commit, not awaited) never says whether the email exists.
export const requestPasswordReset = defineAction('requestPasswordReset', z.object({ email: z.string().email().max(254) }), async ({ email }, ctx) => {
  const send = ctx.settings.auth?.sendPasswordReset
  const want = email.normalize('NFKC').trim().toLowerCase()
  // silent caps (the answer stays the same, so they say nothing either): 3/hour per email from one client, so one client
  // cannot use up a victim's resets (secreview L5), and 10/hour per account from everyone (no mail-bombing)
  if (!(await resetRate(ctx.settings).check({ sid: `reset:${want}:${ctx.request.ip}` })).ok) return null
  if (!(await accountRate(ctx.settings).check({ sid: `reset:${want}` })).ok) return null
  // case-insensitive (Django get_users: email__iexact): contains narrows in SQL, the exact match is here
  const rows = (await User.objects.filter([{ field: 'email', op: 'contains', value: want }, { field: 'isActive', op: 'eq', value: true }]).all(100))
    .filter((r) => r.email?.normalize('NFKC').trim().toLowerCase() === want && r.password && !r.password.startsWith('!'))
  if (!rows.length) return null
  const out = rows.map((r) => ({ user: { id: String(r.id), username: r.username, email: r.email! }, email: r.email!, uid: uidOf(r), token: makeResetToken(ctx.settings, r), request: ctx.request }))
  // settings.auth.sendPasswordReset wins; otherwise the default mail through settings.email (sendMail)
  const sender = send ?? ((e: (typeof out)[number]) => sendResetMail(e, ctx.settings.auth?.resetUrl))
  onCommit(() => {
    setImmediate(() => { for (const e of out) void Promise.resolve().then(() => sender(e)).catch(() => console.error('tvine.auth: sending the password reset failed')) })
  })
  return null
}, { rate: { limit: 5, windowMs: 60_000 } })

export const resetPassword = defineAction('resetPassword', z.object({ uid: z.string().max(40), token: z.string().max(200), newPassword: pw() }), async ({ uid, token, newPassword }, ctx) => {
  const bad = () => new DomainError('invalid_token', 'the reset link is invalid or has expired')
  const id = userOfUid(uid)
  const row = id === undefined ? undefined : await User.get(id)
  if (!row?.isActive || !checkResetToken(ctx.settings, row, token)) throw bad()
  reject(await validateNewPassword(newPassword, ctx.settings, row), 'newPassword')
  // the guard: the update matches the hash the token was made for, so two concurrent uses cannot both win
  const n = await User.objects.filter({ id: row.id, password: row.password }).update({ password: await makePassword(newPassword, ctx.settings) })
  if (n !== 1) throw bad()
  await revokeTokens(row.id)
  await dropOtherSessions(row.id)
  securityNotice(ctx.settings, 'passwordChanged', row, ctx.request)
  return null
}, { rate: { limit: 10, windowMs: 60_000 } })

// ---- sessions (signed-in browsers / clients) ------------------------------------------------------------
// the id is an opaque hash, never the sid; revoking signs that session out on its next request
export const sessionsAction = defineAction('sessions', z.object({}), async (_p, ctx) => listSessions(Number(sessionOnly(ctx).id), ctx.session),
  { permissions: [isAuthenticated], readOnly: true })

export const revokeSession = defineAction('revokeSession', z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }), async ({ id }, ctx) => {
  const u = sessionOnly(ctx)
  const own = (await listSessions(Number(u.id), ctx.session)).find((s) => s.id === id)
  if (!own) throw new DomainError('not_found', 'no such session')
  if (own.current) { await forgetSession(ctx.session); logout(ctx) }
  else await UserSession.objects.filter({ key: id, userId: Number(u.id) }).delete()
  securityEvent('session_revoked', { userId: u.id }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid, level: 'info' })
  return null
}, { permissions: [isAuthenticated, notInTab] })

export const logoutOthers = defineAction('logoutOthers', z.object({}), async (_p, ctx) => {
  const u = sessionOnly(ctx)
  const n = await dropOtherSessions(Number(u.id), ctx.session)
  securityEvent('sessions_revoked', { userId: u.id, count: n }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid, level: 'info' })
  return { revoked: n }
}, { permissions: [isAuthenticated, notInTab] })

// ---- privacy: my data ---------------------------------------------------------------------------------
// a JSON file of everything the app holds on me (models opt in with Meta.personalData), as a private media file:
// the answer and an email carry a signed link that only this user can open, for 24 h. A human confirms; twice an hour.
export const exportMyData = defineAction('exportMyData', z.object({}), async (_p, ctx) => {
  const u = sessionOnly(ctx)
  const path = await exportToMedia(Number(u.id), ctx.settings)
  const url = ctx.settings.siteUrl ? new URL(path, ctx.settings.siteUrl).href : path
  if (u.email) onCommit(() => void sendMail({ subject: 'Your data export is ready', to: u.email!, message: `Hi ${u.username},\n\nDownload your data (signed in, within 24 hours):\n\n${url}\n` }, { background: true }).catch(() => undefined))
  securityEvent('data_export', { userId: u.id }, { settings: ctx.settings, request: ctx.request, sid: ctx.sid, level: 'info' })
  return { url }
}, { permissions: [isAuthenticated, denyAgents], rate: { limit: 2, windowMs: 3_600_000 }, confirm: { by: 'human' } })

// ---- TOTP ----------------------------------------------------------------------------------------
export const totpBegin = defineAction('totpBegin', z.object({ password: pw().optional() }), async ({ password }, ctx) => {
  const u = sessionOnly(ctx)
  await reauth(ctx, u, password)
  const id = Number(u.id)
  const existing = await Totp.objects.filter({ userId: id }).first()
  if (existing?.confirmed) throw new DomainError('totp_enabled', 'two-factor is already on; disable it first')
  const { raw, sealed } = newTotpSecret(ctx.settings, id)
  if (existing) await Totp.update(existing.id, { secret: sealed, lastStep: 0 })
  else await Totp.create({ userId: id, secret: sealed })
  const issuer = ctx.settings.auth?.totp?.issuer ?? ctx.settings.site.name
  return { secret: base32(raw), uri: totpUri(raw, issuer, u.username) }   // shown this once
}, { permissions: [isAuthenticated, denyAgents], secretResult: true })

export const totpConfirm = defineAction('totpConfirm', z.object({ otp: z.string().max(10) }), async ({ otp }, ctx) => {
  const u = sessionOnly(ctx)
  const t = await Totp.objects.filter({ userId: Number(u.id) }).first()
  if (!t || t.confirmed) throw new DomainError('totp_not_pending', 'start two-factor setup first')
  const step = totpStep(ctx.settings, t, otp)
  if (step === undefined) throw new DomainError('invalid_credentials', 'that code is not valid', 'otp')
  await Totp.update(t.id, { confirmed: true, lastStep: step })
  await RecoveryCode.objects.filter({ userId: t.userId }).delete()
  const codes = newRecoveryCodes()
  for (const c of codes) await RecoveryCode.create({ userId: t.userId, digest: sha256(normCode(c)) })
  return { recoveryCodes: codes }
}, { permissions: [isAuthenticated, denyAgents], secretResult: true })

// secreview L4: the password AND a current code (or a recovery code): a stolen session plus a phished password is not enough
export const totpDisable = defineAction('totpDisable', z.object({ password: pw(), otp: z.string().max(32) }), async ({ password, otp }, ctx) => {
  const u = sessionOnly(ctx)
  await locked(ctx, u.username)
  const row = (await User.get(Number(u.id)))!
  if (!(await checkPassword(password, row.password, ctx.settings)).ok) {
    await throttleOf(ctx.settings).fail(u.username, ctx.request.ip)
    throw new DomainError('invalid_credentials', 'the password is not correct', 'password')
  }
  if (!(await checkSecondFactor(ctx.settings, row.id, otp))) {
    await throttleOf(ctx.settings).fail(u.username, ctx.request.ip)
    throw new DomainError('invalid_credentials', 'that code is not valid', 'otp')
  }
  await Totp.objects.filter({ userId: row.id }).delete()
  await RecoveryCode.objects.filter({ userId: row.id }).delete()
  securityNotice(ctx.settings, 'twoFactorDisabled', row, ctx.request)
  return null
}, { permissions: [isAuthenticated, denyAgents] })

// ---- personal access tokens ---------------------------------------------------------------------
const SCOPE = /^(\*|read|[a-z][a-z0-9_]*\.(\*|[A-Za-z_$][\w$.]*))$/
export const createToken = defineAction('createToken', z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().regex(SCOPE, "a scope is '*', 'read', '<app>.*' or '<app>.<action>'")).min(1).max(50),
  expiresInDays: z.number().int().positive().optional(),
  password: pw().optional(),
}), async ({ name, scopes, expiresInDays, password }, ctx) => {
  const u = sessionOnly(ctx)
  await reauth(ctx, u, password)
  const max = ctx.settings.auth?.tokens?.maxDays ?? 365
  const days = expiresInDays ?? ctx.settings.auth?.tokens?.defaultDays ?? 90
  if (days > max) throw new DomainError('invalid_param', `a token lives at most ${max} days`, 'expiresInDays')
  const { token, key, digest } = newToken()
  const expiresAt = new Date(Date.now() + days * 86_400_000)
  await Token.create({ userId: Number(u.id), name, key, digest, scopes: [...new Set(scopes)], expiresAt })
  securityNotice(ctx.settings, 'tokenCreated', u, ctx.request, `Token name: ${name}`)
  return { token, key, name, scopes: [...new Set(scopes)], expiresAt: expiresAt.toISOString() }   // the token: shown this once
}, { permissions: [isAuthenticated, denyAgents], secretResult: true })

// secreview L2: an agent sees and revokes only the token it runs on (an agent on a session: none); a human, all of theirs
const ownOnly = (ctx: ActionCtx) => (ctx.request.agent.is ? { key: me(ctx).tokenKey ?? '' } : {})
export const listTokens = defineAction('listTokens', z.object({}), async (_p, ctx) =>
  (await Token.objects.filter({ userId: Number(me(ctx).id), revoked: false, ...ownOnly(ctx) }).order('-createdAt').all(200)).map((t) => ({
    key: t.key, name: t.name, scopes: t.scopes, createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null, lastUsed: t.lastUsed?.toISOString() ?? null,
  })), { permissions: [isAuthenticated], readOnly: true })

export const revokeToken = defineAction('revokeToken', z.object({ key: z.string().max(20) }), async ({ key }, ctx) => {
  const u = sessionOnly(ctx)   // M5: a token never revokes tokens
  const own = ownOnly(ctx)
  if (own.key !== undefined && own.key !== key) throw new DomainError('not_found', 'no such token')
  const n = await Token.objects.filter({ userId: Number(u.id), key, revoked: false }).update({ revoked: true })
  if (!n) throw new DomainError('not_found', 'no such token')
  return null
}, { permissions: [isAuthenticated] })

// Django PasswordResetForm's default mail: the link from settings.auth.resetUrl ('{uid}', '{token}'), else uid + token
function sendResetMail(e: { email: string; uid: string; token: string; user: { username: string } }, resetUrl?: string) {
  const link = resetUrl?.replaceAll('{uid}', encodeURIComponent(e.uid)).replaceAll('{token}', encodeURIComponent(e.token))
  const how = link ? `Open this link to choose a new password:\n\n${link}` : `Reset code: uid ${e.uid}, token ${e.token}`
  return sendMail({ subject: 'Password reset', to: e.email,
    message: `You asked to reset the password of ${e.user.username}.\n\n${how}\n\nIf you did not ask for this, ignore this email.\n` })
}
