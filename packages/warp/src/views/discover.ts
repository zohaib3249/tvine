// Boot-time scan of apps/*/views (+ rules, serializers; .ts/.js/.mjs, core/actions appModule) into an ActionManifest.
// Pass settings.limits.rate as defaults.rate. Exported View subclasses are instantiated once
// and register their generated + @action actions.
import { ActionManifest, APP_RE, appModule, importApp, isActionDef, type Rate } from '../core/actions.js'
import { installedApps } from '../core/apps.js'
import type { ActionDef } from '../core/types.js'
import { bindRegistered, isViewClass, viewActions, type Shapers } from './generic.js'

// installed: settings.installedApps (contrib apps register under their label, after the project's apps).
export async function discover(appsDir: string, defaults: { rate?: Rate; installed?: readonly string[] } = {}): Promise<ActionManifest> {
  const m = new ActionManifest({ rate: defaults.rate })
  for (const { label: app, dir } of installedApps(appsDir, defaults.installed)) {
    const views = appModule(dir, 'views')
    if (!views) continue
    if (!APP_RE.test(app)) throw new Error(`${views}: folder name "${app}" must match ${APP_RE}`)
    const mod = await importApp(views)
    const rulesFile = appModule(dir, 'rules')
    const rules = rulesFile ? await importApp(rulesFile) : {}
    const serFile = appModule(dir, 'serializers')
    const shapers = serFile ? (await importApp(serFile)).serializers as Shapers | undefined : undefined
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
      if (view) bindRegistered(view, d, m.get(d.id)!, m.views)   // the merged-rules def the page helpers must use
    }
  }
  return m
}
