// Data export and erase (GDPR art. 15 / 17). Models opt in through Meta:
//   personalData: ['field', …]          what export(user) collects from rows whose fk points at the user
//   onErase: 'delete' | 'anonymize' | fn  what erase(user) does to those rows (default 'anonymize' when personalData is set)
// The user's own row is always part of both: export lists its profile; erase anonymizes it (inactive, unusable password,
// username deleted-<id>, no email) and drops its sessions, tokens, devices and second factor. One transaction, one audit row.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { securityEvent } from '../../core/audit.js'
import type { Request, Settings } from '../../core/types.js'
import { atomic } from '../../data/engine.js'
import { modelRegistry, type Model } from '../../data/model.js'
import type { Field, Fields } from '../../data/fields/index.js'
import { DiskStorage, media } from '../../media/index.js'
import { KnownDevice, RecoveryCode, Token, Totp, User, UserSession } from './models.js'

type AnyModel = Model<any, any>
const userFks = (m: AnyModel) => Object.entries(m.fields as Fields)
  .filter(([, f]) => f.kind === 'fk' && f.target!().name === User.name).map(([n, f]) => f.key(n))
const optedIn = () => modelRegistry().filter((m) => m.name !== User.name && (m.meta.personalData || m.meta.onErase) && userFks(m).length)
const rowsOf = async (m: AnyModel, userId: number) => {
  const out: Record<string, unknown>[] = []
  for (const k of userFks(m)) out.push(...await m.objects.filter({ [k]: userId }).fetchAll())
  return out
}

export async function exportData(userId: number): Promise<Record<string, unknown>> {
  const u = await User.get(userId)
  if (!u) throw new Error('privacy.export: no such user')
  const out: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    user: { id: u.id, username: u.username, email: u.email, dateJoined: u.dateJoined, lastLogin: u.lastLogin },
    sessions: (await UserSession.objects.filter({ userId }).all(1000)).map((s) => ({ ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeen: s.lastSeen })),
    tokens: (await Token.objects.filter({ userId }).all(1000)).map((t) => ({ name: t.name, createdAt: t.createdAt, lastUsed: t.lastUsed, revoked: t.revoked })),
  }
  for (const m of optedIn()) {
    const fields = m.meta.personalData ?? []
    if (!fields.length) continue
    const keys = fields.map((f) => (m.fields as Fields)[f]!.key(f))
    out[m.name] = (await rowsOf(m, userId)).map((r) => Object.fromEntries([['id', r.id], ...keys.map((k) => [k, r[k]])]))
  }
  return out
}

// a blank for a personal field that cannot be null
const blank = (f: Field) => (f.opts.optional ? null : ['text', 'email', 'slug', 'url', 'encrypted'].includes(f.kind) ? (f.kind === 'email' ? 'erased@invalid' : '') : undefined)

export async function eraseData(userId: number, o: { settings?: Settings; request?: Request } = {}): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  await atomic(async () => {
    if (!(await User.get(userId))) throw new Error('privacy.erase: no such user')
    for (const m of optedIn()) {
      const how = m.meta.onErase ?? 'anonymize'
      if (typeof how === 'function') { await how(userId); counts[m.name] = -1; continue }
      let n = 0
      for (const k of userFks(m)) {
        const qs = m.objects.filter({ [k]: userId })
        if (how === 'delete') { n += await qs.delete(); continue }
        const patch = Object.fromEntries((m.meta.personalData ?? []).map((f) => [(m.fields as Fields)[f]!.key(f), blank((m.fields as Fields)[f]!)]).filter(([, v]) => v !== undefined))
        if (Object.keys(patch).length) n += await qs.update(patch)
      }
      counts[m.name] = n
    }
    for (const M of [UserSession, KnownDevice, Token, Totp, RecoveryCode] as AnyModel[]) await M.objects.filter({ userId }).delete()
    await User.update(userId, { username: `deleted-${userId}`, email: null, password: '!', isActive: false, isStaff: false, isSuperuser: false })
  })
  if (o.settings) await removeExports(o.settings, { userId })   // earlier exports of this user are personal data too
  securityEvent('privacy_erase', { userId: String(userId), models: Object.keys(counts) }, { settings: o.settings, request: o.request, level: 'info' })
  return counts
}

// the export as a private media file: a signed link (24 h, bound to the user) is what the user gets
// files: <media>/privacy/u<id>_<random>.export; older than the link (24 h) are swept on every new export
export const EXPORT_TTL_S = 86_400
const exportDir = (s: Settings) => join(s.media.dir, 'privacy')
export async function removeExports(settings: Settings, o: { userId?: number; olderThanMs?: number } = {}): Promise<number> {
  const dir = exportDir(settings), store = new DiskStorage(settings.media.dir, settings.media.route)
  let n = 0
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith('.export') || (o.userId !== undefined && !f.startsWith(`u${o.userId}_`))) continue
    if (o.olderThanMs !== undefined && Date.now() - ((await stat(join(dir, f)).catch(() => undefined))?.mtimeMs ?? 0) < o.olderThanMs) continue
    await store.delete(`privacy/${f}`); n++
  }
  return n
}

export async function exportToMedia(userId: number, settings: Settings): Promise<string> {
  await removeExports(settings, { olderThanMs: EXPORT_TTL_S * 1000 })
  const data = Buffer.from(JSON.stringify(await exportData(userId), null, 2))
  const key = `privacy/u${userId}_${nanoid()}.export`
  await new DiskStorage(settings.media.dir, settings.media.route).put(key, data, { type: 'application/json', size: data.length, private: true })
  return media.url(key, { user: userId, expiresIn: EXPORT_TTL_S, route: settings.media.route })
}

export const privacy = { export: exportData, erase: eraseData, exportToMedia }
