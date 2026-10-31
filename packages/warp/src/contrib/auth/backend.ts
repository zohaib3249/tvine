// request.user for tvine.auth (docs/design/contrib/auth.md §4–6): AuthUser, the session binding (user id +
// password-bound hash), bearer tokens, login/logout, reset tokens, TOTP.
import { randomBytes } from 'node:crypto'
import { cycleSession, type AuthBackend } from '../../core/auth.js'
import { DomainError } from '../../core/errors.js'
import { ANONYMOUS, type ActionCtx, type Request, type Session, type Settings, type TvineUser } from '../../core/types.js'
import { MAX_IN, type Where } from '../../data/queryset.js'
import { base32, checksum, hotp, mac, macOk, random62, same, seal, sha256, unseal } from './crypto.js'
import { recordSession, sessionAlive } from './sessions.js'
import { Group, GroupPermission, Permission, RecoveryCode, Token, Totp, User, UserGroup, UserPermission } from './models.js'

export type UserRow = NonNullable<Awaited<ReturnType<typeof User.get>>>
export interface SafeUser { id: string; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }

export const SESSION_USER = '_auth_user_id', SESSION_HASH = '_auth_user_hash', SESSION_AT = '_auth_login_at'

// one generic error per failure class; never which part was wrong
export const INVALID = () => new DomainError('invalid_credentials', 'invalid username or password')

const inChunks = async <R>(ids: unknown[], fn: (chunk: unknown[]) => Promise<R[]>): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < ids.length; i += MAX_IN) out.push(...(await fn(ids.slice(i, i + MAX_IN))))
  return out
}
const where = (field: string, value: unknown[]): Where[] => [{ field, op: 'in', value }]

// Django's User on request.user. Never holds the password hash. Permission/group sets load once per object
// (= per request), like Django's _perm_cache.
export class AuthUser implements TvineUser {
  readonly isAuthenticated = true
  readonly id: string
  readonly name: string
  readonly username: string
  readonly email: string | null
  readonly isActive: boolean
  readonly isStaff: boolean
  readonly isSuperuser: boolean
  #perms?: Promise<Set<string>>
  #groups?: Promise<string[]>
  #settings: Settings

  tokenKey?: string   // via 'token': the key of the token this request runs on
  constructor(row: UserRow, settings: Settings, readonly via: 'session' | 'token', readonly scopes?: readonly string[]) {
    this.id = String(row.id); this.name = this.username = row.username; this.email = row.email
    this.isActive = row.isActive; this.isStaff = row.isStaff; this.isSuperuser = row.isSuperuser
    this.#settings = settings
    if (!scopes) delete (this as { scopes?: unknown }).scopes   // `'scopes' in user` stays false for session users
  }

  groups(): Promise<string[]> {
    return (this.#groups ??= (async () => {
      const ids = (await UserGroup.objects.filter({ userId: Number(this.id) }).all()).map((r) => r.groupId)
      return (await inChunks(ids, (c) => Group.objects.filter(where('id', c)).all())).map((g) => g.name).sort()
    })())
  }

  // every codename granted through the user or its groups (Django get_all_permissions); inactive → none
  allPermissions(): Promise<Set<string>> {
    return (this.#perms ??= (async () => {
      if (!this.isActive) return new Set<string>()
      if (this.isSuperuser) return new Set((await Permission.objects.all()).map((p) => p.codename))
      const own = (await UserPermission.objects.filter({ userId: Number(this.id) }).all()).map((r) => r.permissionId)
      const gids = (await UserGroup.objects.filter({ userId: Number(this.id) }).all()).map((r) => r.groupId)
      const viaGroups = (await inChunks(gids, (c) => GroupPermission.objects.filter(where('groupId', c)).all())).map((r) => r.permissionId)
      const ids = [...new Set([...own, ...viaGroups])]
      return new Set((await inChunks(ids, (c) => Permission.objects.filter(where('id', c)).all())).map((p) => p.codename))
    })())
  }

  // Django semantics: active superuser → everything; with an object only settings.auth.objectPermission answers
  async hasPerm(perm: string, obj?: unknown): Promise<boolean> {
    if (!this.isActive) return false
    if (obj !== undefined) {
      if (this.isSuperuser) return true
      const f = this.#settings.auth?.objectPermission
      return f ? !!(await f(this, perm, obj)) : false
    }
    return this.isSuperuser || (await this.allPermissions()).has(perm)
  }
  async hasPerms(perms: string[], obj?: unknown): Promise<boolean> {
    for (const p of perms) if (!(await this.hasPerm(p, obj))) return false
    return true
  }

  // the BYO convention (request.user.claims) carries the same flags, so code written against either reads them
  get claims(): Record<string, unknown> { return { username: this.username, email: this.email, isStaff: this.isStaff, isSuperuser: this.isSuperuser, isActive: this.isActive } }

  toJSON(): SafeUser { return safeUser(this) }
}

export const safeUser = (u: { id: string | number; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }): SafeUser =>
  ({ id: String(u.id), username: u.username, email: u.email, isStaff: u.isStaff, isSuperuser: u.isSuperuser })

// ---- session binding ---------------------------------------------------------------------------------
// Django HASH_SESSION_KEY: bound to the password hash, so a password change logs out every other session.
export const sessionHash = (s: Settings, passwordHash: string) => mac(s, 'session', passwordHash)

export async function sessionUser(settings: Settings, session: Session): Promise<UserRow | undefined> {
  const id = session.data.get(SESSION_USER), hash = session.data.get(SESSION_HASH)
  if (id === undefined) return undefined
  const row = typeof id === 'string' && /^\d+$/.test(id) ? await User.get(Number(id)) : undefined
  if (row && row.isActive && typeof hash === 'string' && macOk(settings, 'session', row.password, hash) && await sessionAlive(session, row.id)) return row
  session.data.delete(SESSION_USER); session.data.delete(SESSION_HASH)   // stale binding: flushed like Django
  return undefined
}

// After a successful credential check, in the handler: bind, rotate (fixation), stamp lastLogin.
export async function login(ctx: ActionCtx, row: UserRow): Promise<AuthUser> {
  // Django login(): another user's session data (a cart, a draft) never carries over to this user
  const prev = ctx.session.data.get(SESSION_USER)
  if (prev !== undefined && prev !== String(row.id)) ctx.session.data.clear()
  ctx.session.data.set(SESSION_USER, String(row.id))
  ctx.session.data.set(SESSION_AT, Date.now())
  ctx.session.data.set(SESSION_HASH, sessionHash(ctx.settings, row.password))
  cycleSession(ctx)
  await recordSession(ctx, row.id)   // auth.sessions: listed, revocable
  const fresh = await User.update(row.id, { lastLogin: new Date() })
  const user = new AuthUser(fresh, ctx.settings, 'session')
  ctx.request.user = user
  return user
}

// Django logout(): flush everything, new sid
// sudo mode: a password typed in this session within RECENT_MS (login, change, or the action's own `password` param)
export const RECENT_MS = 10 * 60_000
export const recentlyAuthenticated = (ctx: ActionCtx, now = Date.now()) => {
  const at = ctx.session.data.get(SESSION_AT)
  return typeof at === 'number' && now - at <= RECENT_MS && now >= at
}

// Django update_session_auth_hash: after this session's own user changed the password, keep this session (new sid);
// every other session of the user is already stale (bound to the old hash)
export function updateSessionAuthHash(ctx: Pick<ActionCtx, 'session' | 'settings'>, row: { id: number; password: string }): void {
  if (ctx.session?.data.get(SESSION_USER) !== String(row.id)) return
  ctx.session.data.set(SESSION_HASH, sessionHash(ctx.settings, row.password))
  cycleSession(ctx)
}

// every token of a user stops working (password reset / change: a token made by an attacker dies with it)
export const revokeTokens = (userId: number) => Token.objects.filter({ userId, revoked: false }).update({ revoked: true })

export function logout(ctx: ActionCtx): void {
  ctx.session.data.clear()
  cycleSession(ctx)
  ctx.request.user = ANONYMOUS
}

// ---- personal access tokens ----------------------------------------------------------------------
// tvp_<key 8>_<secret 32>_<crc32 base62 6>: the checksum rejects typos (and lets scanners find leaks) with no DB hit
const TOKEN_RE = /^tvp_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})_([0-9A-Za-z]{6})$/
export function newToken(): { token: string; key: string; digest: string } {
  const key = random62(8), body = `tvp_${key}_${random62(32)}`
  const token = `${body}_${checksum(body)}`
  return { token, key, digest: sha256(token) }
}

const LAST_USED_MS = 60_000
export async function tokenUser(settings: Settings, token: string): Promise<AuthUser | undefined> {
  const m = TOKEN_RE.exec(token)
  if (!m || checksum(token.slice(0, token.lastIndexOf('_'))) !== m[3]) return undefined
  const row = await Token.objects.filter({ key: m[1] }).first()
  if (!row || !same(sha256(token), row.digest) || row.revoked || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined
  const user = await User.get(row.userId)
  if (!user?.isActive) return undefined
  // at most once a minute, outside the request's transaction; a failed stamp never fails the request
  if (!row.lastUsed || Date.now() - row.lastUsed.getTime() > LAST_USED_MS) void Token.objects.filter({ id: row.id }).update({ lastUsed: new Date() }).catch(() => undefined)
  const u = new AuthUser(user, settings, 'token', Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [])
  u.tokenKey = row.key
  return u
}

export function backendFor(settings: Settings): AuthBackend {
  return {
    async fromRequest(request: Request) {
      const h = request.headers.get('authorization')
      const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null
      return (m && (await tokenUser(settings, m[1]!))) || null
    },
    async fromSession(_request: Request, session: Session) {
      const row = await sessionUser(settings, session)
      return row ? new AuthUser(row, settings, 'session') : null
    },
  }
}

// ---- password reset tokens -------------------------------------------------------------------------
// <ts base36>-<hmac>: bound to the password hash (single use: a reset changes it), lastLogin and email.
const resetData = (r: UserRow, ts: number) => [r.id, r.password, r.lastLogin?.getTime() ?? '', r.email ?? '', ts].join('|')
export const uidOf = (r: UserRow) => Buffer.from(String(r.id)).toString('base64url')
export const userOfUid = (uid: string) => { const id = Buffer.from(uid, 'base64url').toString(); return /^\d{1,15}$/.test(id) ? Number(id) : undefined }
export function makeResetToken(s: Settings, r: UserRow, now = Date.now()): string {
  const ts = Math.floor(now / 1000)
  return `${ts.toString(36)}-${mac(s, 'reset', resetData(r, ts))}`
}
export function checkResetToken(s: Settings, r: UserRow, token: string, now = Date.now()): boolean {
  const i = token.indexOf('-'), t = token.slice(0, i), sig = token.slice(i + 1)   // the MAC is base64url: it may hold '-' too
  const ts = i > 0 && /^[0-9a-z]{1,10}$/.test(t) ? parseInt(t, 36) : NaN
  if (!/^[\w-]{43}$/.test(sig) || !Number.isFinite(ts)) return false
  const age = now / 1000 - ts
  if (age > (s.auth?.resetTimeoutMs ?? 3_600_000) / 1000 || age < -60) return false
  return macOk(s, 'reset', resetData(r, ts), sig)
}

// ---- TOTP (RFC 6238) ----------------------------------------------------------------------------------
const STEP_MS = 30_000
export const totpAad = (userId: number | string) => `auth_totp:${userId}`
export function newTotpSecret(s: Settings, userId: number): { raw: Buffer; sealed: string } {
  const raw = randomBytes(20)
  return { raw, sealed: seal(s, 'totp', raw, totpAad(userId)) }
}
export const totpUri = (raw: Buffer, issuer: string, username: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${base32(raw)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`

// the matched step (> lastStep: a code is good once), or undefined; ±1 step of clock drift
export function totpStep(s: Settings, t: { secret: string; lastStep: number; userId: number | string }, code: string, now = Date.now()): number | undefined {
  const { lastStep } = t
  if (!/^\d{6}$/.test(code)) return undefined
  const raw = unseal(s, 'totp', t.secret, totpAad(t.userId))
  if (!raw) return undefined
  const step = Math.floor(now / STEP_MS)
  let hit: number | undefined
  for (const d of [-1, 0, 1]) if (step + d > lastStep && same(hotp(raw, step + d), code)) hit ??= step + d
  return hit
}

// recovery codes: XXXXX-XXXXX (base32, 50 bits), stored as sha256 of the normalized form
export const normCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, '')
export const newRecoveryCodes = (n = 10) => Array.from({ length: n }, () => { const c = base32(randomBytes(7)).slice(0, 10); return `${c.slice(0, 5)}-${c.slice(5)}` })

// login second factor: a TOTP code, or an unused recovery code (then spent)
export async function checkSecondFactor(s: Settings, userId: number, otp: string): Promise<boolean> {
  const t = await Totp.objects.filter({ userId: userId }).first()
  if (!t?.confirmed) return true
  const step = totpStep(s, t, otp.trim())
  if (step !== undefined) {
    // the guard: only one concurrent use of a step wins (the update matches lastStep as it was read)
    return (await Totp.objects.filter({ id: t.id, lastStep: t.lastStep }).update({ lastStep: step })) === 1
  }
  const n = normCode(otp)
  if (!/^[A-Z2-7]{10}$/.test(n)) return false
  const rc = await RecoveryCode.objects.filter({ userId: userId, digest: sha256(n), usedAt: null }).first()
  return !!rc && (await RecoveryCode.objects.filter({ id: rc.id, usedAt: null }).update({ usedAt: new Date() })) === 1
}
export const hasSecondFactor = async (userId: number) => !!(await Totp.objects.filter({ userId: userId, confirmed: true }).first())
