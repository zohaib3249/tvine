// tvine.auth actions (docs/design/contrib/auth.md §3): every flow runs through dispatch — permissions, rate
// limits, one transaction. Secrets are only ever returned once, by the action that creates them.
import { z } from 'zod'
import { defineAction } from '../../core/actions.js'
import { DomainError } from '../../core/errors.js'
import type { ActionCtx, TvineUser } from '../../core/types.js'
import { onCommit } from '../../data/engine.js'
import { denyAgents, isAuthenticated } from '../../security/permissions.js'
import {
  AuthUser, checkResetToken, checkSecondFactor, hasSecondFactor, INVALID, login, logout, makeResetToken, newRecoveryCodes,
  newToken, newTotpSecret, normCode, recentlyAuthenticated, revokeTokens, safeUser, totpStep, totpUri, uidOf, userOfUid, type SafeUser,
} from './backend.js'
import { base32, sha256 } from './crypto.js'
import { RecoveryCode, Token, Totp, User } from './models.js'
import { checkPassword, dummyCheck, makePassword, MAX_PASSWORD, validatePassword } from './passwords.js'
import { throttleOf } from './throttle.js'
import type { Limiter } from '../../security/ratelimit.js'
import { limiterFor } from '../../backends/index.js'
import type { Settings } from '../../core/types.js'

const resetRates = new WeakMap<Settings, Limiter>()
const resetRate = (s: Settings) => { let r = resetRates.get(s); if (!r) resetRates.set(s, (r = limiterFor(s, { limit: 3, windowMs: 3_600_000 }))); return r }   // settings.limits.backend

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
  if (await throttleOf(ctx.settings).locked(username, ctx.request.ip)) throw new DomainError('locked', 'too many failed attempts; try again later')
}

export const loginAction = defineAction('login', z.object({
  username: z.string().min(1).max(150),
  password: pw(),
  otp: z.string().max(32).optional(),
}), async ({ username, password, otp }, ctx): Promise<SafeUser> => {
  const t = throttleOf(ctx.settings), ip = ctx.request.ip
  await locked(ctx, username)
  const row = await User.objects.filter({ username: username.normalize('NFKC') }).first()
  const { ok, upgrade } = row?.isActive ? await checkPassword(password, row.password, ctx.settings) : { ok: await dummyCheck(password, ctx.settings), upgrade: false }
  if (!row || !ok) { await t.fail(username, ip); throw INVALID() }
  if (await hasSecondFactor(row.id)) {
    if (!otp) throw new DomainError('otp_required', 'enter the code from your authenticator app (or a recovery code) as otp')
    if (!(await checkSecondFactor(ctx.settings, row.id, otp))) { await t.fail(username, ip); throw INVALID() }
  }
  await t.succeed(username, ip)
  const current = upgrade ? await User.update(row.id, { password: await makePassword(password, ctx.settings) }) : row
  return safeUser(await login(ctx, current))
}, { rate: { limit: 10, windowMs: 60_000 } })

export const logoutAction = defineAction('logout', z.object({}), async (_p, ctx) => { logout(ctx); return null })

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
  reject(validatePassword(newPassword, ctx.settings, row), 'newPassword')
  const fresh = await User.update(row.id, { password: await makePassword(newPassword, ctx.settings) })
  await revokeTokens(row.id)
  // update_session_auth_hash: this session is re-bound to the new hash (on a new sid); every other one is now stale
  await login(ctx, fresh)
  return null
}, { permissions: [isAuthenticated, denyAgents] })

// Always ok: the answer (and its timing: sending happens after commit, not awaited) never says whether the email exists.
export const requestPasswordReset = defineAction('requestPasswordReset', z.object({ email: z.string().email().max(254) }), async ({ email }, ctx) => {
  const send = ctx.settings.auth?.sendPasswordReset
  const want = email.normalize('NFKC').trim().toLowerCase()
  // per-email cap (3/hour): silently nothing more — the answer stays the same, so it says nothing either
  if (!(await resetRate(ctx.settings).check({ sid: `reset:${want}` })).ok) return null
  // case-insensitive (Django get_users: email__iexact): contains narrows in SQL, the exact match is here
  const rows = (await User.objects.filter([{ field: 'email', op: 'contains', value: want }, { field: 'isActive', op: 'eq', value: true }]).all(100))
    .filter((r) => r.email?.normalize('NFKC').trim().toLowerCase() === want && r.password && !r.password.startsWith('!'))
  if (!rows.length) return null
  const out = rows.map((r) => ({ user: { id: String(r.id), username: r.username, email: r.email! }, email: r.email!, uid: uidOf(r), token: makeResetToken(ctx.settings, r), request: ctx.request }))
  onCommit(() => {
    if (!send) { console.warn('tvine.auth: password reset requested but settings.auth.sendPasswordReset is not set'); return }
    setImmediate(() => { for (const e of out) void Promise.resolve().then(() => send(e)).catch(() => console.error('tvine.auth: sendPasswordReset failed')) })
  })
  return null
}, { rate: { limit: 5, windowMs: 60_000 } })

export const resetPassword = defineAction('resetPassword', z.object({ uid: z.string().max(40), token: z.string().max(200), newPassword: pw() }), async ({ uid, token, newPassword }, ctx) => {
  const bad = () => new DomainError('invalid_token', 'the reset link is invalid or has expired')
  const id = userOfUid(uid)
  const row = id === undefined ? undefined : await User.get(id)
  if (!row?.isActive || !checkResetToken(ctx.settings, row, token)) throw bad()
  reject(validatePassword(newPassword, ctx.settings, row), 'newPassword')
  // the guard: the update matches the hash the token was made for, so two concurrent uses cannot both win
  const n = await User.objects.filter({ id: row.id, password: row.password }).update({ password: await makePassword(newPassword, ctx.settings) })
  if (n !== 1) throw bad()
  await revokeTokens(row.id)
  return null
}, { rate: { limit: 10, windowMs: 60_000 } })

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

export const totpDisable = defineAction('totpDisable', z.object({ password: pw() }), async ({ password }, ctx) => {
  const u = sessionOnly(ctx)
  await locked(ctx, u.username)
  const row = (await User.get(Number(u.id)))!
  if (!(await checkPassword(password, row.password, ctx.settings)).ok) {
    await throttleOf(ctx.settings).fail(u.username, ctx.request.ip)
    throw new DomainError('invalid_credentials', 'the password is not correct', 'password')
  }
  await Totp.objects.filter({ userId: row.id }).delete()
  await RecoveryCode.objects.filter({ userId: row.id }).delete()
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
  return { token, key, name, scopes: [...new Set(scopes)], expiresAt: expiresAt.toISOString() }   // the token: shown this once
}, { permissions: [isAuthenticated, denyAgents], secretResult: true })

export const listTokens = defineAction('listTokens', z.object({}), async (_p, ctx) =>
  (await Token.objects.filter({ userId: Number(me(ctx).id), revoked: false }).order('-createdAt').all(200)).map((t) => ({
    key: t.key, name: t.name, scopes: t.scopes, createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null, lastUsed: t.lastUsed?.toISOString() ?? null,
  })), { permissions: [isAuthenticated], readOnly: true })

export const revokeToken = defineAction('revokeToken', z.object({ key: z.string().max(20) }), async ({ key }, ctx) => {
  const n = await Token.objects.filter({ userId: Number(sessionOnly(ctx).id), key, revoked: false }).update({ revoked: true })
  if (!n) throw new DomainError('not_found', 'no such token')
  return null
}, { permissions: [isAuthenticated] })
