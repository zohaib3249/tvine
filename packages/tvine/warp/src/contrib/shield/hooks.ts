// tvine.shield app lifecycle: ready() checks the panel access condition, loads the rules / lists / config snapshot
// (seeding the default rule set into an empty table), the ipdb + ranges, and flushes rule hit counts every 30 s.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ServerCtx } from '../../core/dispatch.js'
import { conditionProblem } from './conditions.js'
import { loadIpdb, rangesSeed, setRanges, type RangesFile } from './data.js'
import { defaultRules, setRules } from './engine.js'
import { flushHits, loadAll } from './store.js'
import { flushEvents } from './events.js'

export async function ready(server: ServerCtx): Promise<void> {
  const s = server.settings
  const bad = conditionProblem(s.shield.panel.access)
  if (bad) throw new Error(`settings.shield.panel.access: ${bad}`)
  try { await loadAll(s) } catch (e) {
    // not migrated yet: run on the default rules (in memory) until `tvine migrate`
    setRules(defaultRules(s.shield.aiDefaults))
    server.log('warn', `tvine.shield: rules table not readable (${(e as Error).message.slice(0, 120)}); using the default rules. Run tvine migrate.`)
  }
  const dir = resolve(s.shield.ipdb.dir)
  void loadIpdb(dir).catch(() => undefined)   // in the background: a big CSV never delays boot
  let ranges: RangesFile = rangesSeed()
  try { ranges = JSON.parse(await readFile(join(dir, 'ranges.json'), 'utf8')) as RangesFile } catch { /* the bundled seed */ }
  setRanges(ranges)
  const t = setInterval(() => void flushHits().catch(() => undefined), 30_000)
  t.unref()
  server.onClose(async () => { clearInterval(t); await flushHits().catch(() => undefined); await flushEvents() })
}
