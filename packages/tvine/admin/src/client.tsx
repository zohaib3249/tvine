// Browser entry of the prebuilt bundle (dist/static/admin.js) that Warp serves at settings.admin.path when the app
// has no admin page of its own (serve.ts). Same AdminApp as the Next mount; data comes through api.* only.
import { createRoot } from 'react-dom/client'
import { WeftRoot } from '../../weft/dist/index.js'
import { api } from '../../weft/dist/api/client.js'
import { AdminApp } from './app.js'
import { caller, loadSite } from './data.js'
import { panelBase, panelDevReload, panelHeader, panelQuery, panelRoot, panelSegments } from './panel-boot.js'

const el = panelRoot('tva-root')
panelDevReload(el)
const base = panelBase(el, '/admin')
const header = panelHeader()
void loadSite(caller(api)).then(({ site, user, error }) => {
  if (site?.title) document.title = site.title
  createRoot(el).render(<WeftRoot header={header}><AdminApp base={base} site={site} user={user} error={error} segments={panelSegments(base)} query={panelQuery()} /></WeftRoot>)
})
