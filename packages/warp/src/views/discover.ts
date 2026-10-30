// Boot-time scan of apps/*/views.ts (+ rules.ts, serializers.ts) into an ActionManifest.
// Pass settings.limits.rate as defaults.rate. Exported View subclasses are instantiated once
// and register their generated + @action actions.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ActionManifest, APP_RE, isActionDef, type Rate } from '../core/actions.js'
import type { ActionDef } from '../core/types.js'
import { bindRegistered, isViewClass, viewActions } from './generic.js'

const exists = (f: string) => stat(f).catch(() => null)

export async function discover(appsDir: string, defaults: { rate?: Rate } = {}): Promise<ActionManifest> {
  const m = new ActionManifest(defaults)
  for (const app of (await readdir(appsDir)).sort()) {
    const dir = join(appsDir, app)
    if (!(await stat(dir)).isDirectory()) continue
    const views = join(dir, 'views.ts')
    if (!(await exists(views))) continue
    if (!APP_RE.test(app)) throw new Error(`${views}: folder name "${app}" must match ${APP_RE}`)
    const mod = await import(pathToFileURL(views).href)
    const rulesFile = join(dir, 'rules.ts')
    const rules = (await exists(rulesFile)) ? await import(pathToFileURL(rulesFile).href) : {}
    const serFile = join(dir, 'serializers.ts')
    const shapers = (await exists(serFile)) ? (await import(pathToFileURL(serFile).href)).serializers : undefined
    const found: [string, ActionDef][] = []
    for (const [exp, v] of Object.entries(mod)) {
      if (isActionDef(v)) found.push([exp, v])
      else if (isViewClass(v)) {
        try { for (const d of viewActions(v, { shapers })) found.push([exp, d]) }
        catch (e) { throw new Error(`${views} export ${exp}: ${(e as Error).message}`) }
      }
    }
    // generic-views.md: a view action name used by several classes becomes <Class>.<name>
    const viewNames = found.filter(([e]) => isViewClass(mod[e])).map(([, d]) => d.id)
    for (const [exp, d] of found) {
      const view = isViewClass(mod[exp]) ? mod[exp] : undefined
      if (view && viewNames.filter((n) => n === d.id).length > 1) d.id = `${exp}.${d.id}`
      try {
        m.register(app, d, rules)
      } catch (e) {
        throw new Error(`${views} export ${exp}: ${(e as Error).message}`)
      }
      if (view) bindRegistered(view, d, m.get(d.id)!)   // the merged-rules def the page helper must use
    }
  }
  return m
}
