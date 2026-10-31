// Browser entry of the prebuilt bundle (dist/static/admin.js) that Warp serves at settings.admin.path when the app
// has no admin page of its own (serve.ts). Same AdminApp as the Next mount; data comes through api.* only.
import { createRoot } from 'react-dom/client'
import { WeftRoot } from 'tvine/weft'
import { api } from 'tvine/api'
import { AdminApp } from './app.js'
import { caller, loadSite } from './data.js'

const el = document.getElementById('tva-root')!
const base = (el.dataset.base ?? '/admin').replace(/\/$/, '')
const segments = location.pathname.slice(base.length).split('/').filter(Boolean)
const query = Object.fromEntries(new URLSearchParams(location.search))
void loadSite(caller(api)).then(({ site, user, error }) => {
  if (site?.title) document.title = site.title
  createRoot(el).render(<WeftRoot><AdminApp base={base} site={site} user={user} error={error} segments={segments} query={query} /></WeftRoot>)
})
