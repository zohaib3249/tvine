// tvine.shield beat schedule (needs tvine.tasks + a beat): ipdb.update monthly, ranges.update daily, events.prune daily.
// Each is also a plain function the panel calls ("update now") and tests call with a fake fetcher.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineTask } from '../tasks/task.js'
import { loadedSettings } from '../../security/signing.js'
import { safeFetch } from '../../security/safe-fetch.js'
import type { Settings } from '../../core/types.js'
import { ASN_FILE, COUNTRY_FILE, loadIpdb, rangesSeed, setRanges, type RangesFile } from './data.js'
import { ShieldEvent } from './models.js'
import { runtimeOf } from './engine.js'

type Fetcher = (url: string, maxBytes: number) => Promise<Response>
const fetcher: Fetcher = (url, maxBytes) => safeFetch(url, { timeoutMs: 120_000, maxBytes, maxRedirects: 3 })
const conf = () => (loadedSettings() as Settings | undefined)?.shield

// DB-IP Lite (CC BY 4.0): this month's file, else last month's (published at the start of the month)
export async function updateIpdb(dir = conf()?.ipdb.dir ?? './data/shield', f: Fetcher = fetcher, now = new Date()): Promise<{ country: number; asn: number }> {
  await mkdir(resolve(dir), { recursive: true })
  const months = [0, 1].map((back) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })
  for (const [kind, file] of [['country', COUNTRY_FILE], ['asn', ASN_FILE]] as const) {
    let ok = false
    for (const m of months) {
      const res = await f(`https://download.db-ip.com/free/dbip-${kind}-lite-${m}.csv.gz`, 200 * 1024 * 1024).catch(() => undefined)
      if (!res?.ok) continue
      const tmp = join(resolve(dir), `${file}.tmp`)
      await writeFile(tmp, Buffer.from(await res.arrayBuffer()))
      await rename(tmp, join(resolve(dir), file))   // atomic: a reader never sees half a file
      ok = true
      break
    }
    if (!ok) throw new Error(`ipdb.update: could not download dbip-${kind}-lite (${months.join(', ')})`)
  }
  return loadIpdb(resolve(dir))
}

// published AI-crawler ranges (Google-style { prefixes: [{ ipv4Prefix | ipv6Prefix }] }) + the Tor bulk exit list
export async function updateRanges(dir = conf()?.ipdb.dir ?? './data/shield', f: Fetcher = fetcher): Promise<{ sources: number; torExits: number }> {
  const seed = rangesSeed()
  const out: RangesFile = { ...seed, prefixes: {}, torExits: [], updatedAt: new Date().toISOString() }
  for (const [name, url] of Object.entries(seed.sources)) {
    try {
      const body = await (await f(url, 2 * 1024 * 1024)).json() as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] }
      out.prefixes[name] = (body.prefixes ?? []).map((p) => p.ipv4Prefix ?? p.ipv6Prefix).filter((x): x is string => typeof x === 'string' && x.length < 50)
    } catch { /* one source down: the others still update */ }
  }
  try { out.torExits = (await (await f(seed.tor, 2 * 1024 * 1024)).text()).split('\n').map((l) => l.trim()).filter((l) => /^[\d.:a-f]+$/i.test(l)) } catch { /* keep none */ }
  await mkdir(resolve(dir), { recursive: true })
  await writeFile(join(resolve(dir), 'ranges.json'), JSON.stringify(out))
  setRanges(out)
  return { sources: Object.keys(out.prefixes).length, torExits: out.torExits.length }
}

// batched like contrib/audit/prune.ts
export async function pruneEvents(days = conf()?.events.retentionDays ?? 14, now = Date.now(), batch = 5000): Promise<number> {
  const old = ShieldEvent.objects.filter({ ts__lt: new Date(now - days * 86_400_000) })
  let n = 0
  for (;;) {
    const ids = await old.order('id').limit(batch).valuesList('id', { flat: true }).all() as number[]
    if (!ids.length) return n
    n += await ShieldEvent.objects.filter({ id__in: ids }).delete()
  }
}

export const ipdbUpdate = defineTask('ipdb_update', async () => updateIpdb(), { schedule: { cron: '0 4 3 * *' } })
export const rangesUpdate = defineTask('ranges_update', async () => updateRanges(), { schedule: { cron: '30 4 * * *' } })
// shield rollups (admin_stat keys shield*) older than stats.retentionDays, batched
export async function pruneStats(days: number, now = Date.now(), batch = 5000): Promise<number> {
  const s = loadedSettings() as Settings | undefined
  if (!s?.installedApps.includes('tvine.admin')) return 0
  const { AdminStat } = await import('../admin/models.js')
  const old = AdminStat.objects.filter({ key__in: ['shield', 'shield_score', 'shield_country', 'shield_asn', 'shield_rule'], bucket__lt: new Date(now - days * 86_400_000) })
  let n = 0
  for (;;) {
    const ids = await old.order('id').limit(batch).valuesList('id', { flat: true }).all() as number[]
    if (!ids.length) return n
    n += await AdminStat.objects.filter({ id__in: ids }).delete()
  }
}
// the cron is read once when tasks load (settings.shield.cleanup.schedule); cleanup.enabled / retention are read each run
export const cleanup = defineTask('cleanup', async () => {
  const s = loadedSettings() as Settings | undefined
  if (!s) return { skipped: true }
  const rt = runtimeOf(s)
  if (!rt.cleanup.enabled) return { skipped: true }
  return { events: await pruneEvents(rt.events.retentionDays), stats: await pruneStats(rt.stats.retentionDays) }
}, { schedule: { cron: conf()?.cleanup.schedule ?? '30 3 * * *' } })
