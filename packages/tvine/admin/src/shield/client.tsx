// Browser entry of the Shield panel bundle (dist/shield/shield.js), served by Warp at settings.shield.panel.path
// through shieldHandler (serve.ts). Data only through api.* (shield.*, auth.*).
import { createRoot } from 'react-dom/client'
import { WeftRoot } from '../../../weft/dist/index.js'
import { panelBase, panelDevReload, panelHeader, panelQuery, panelRoot } from '../panel-boot.js'
import { ShieldApp, segmentsOf } from './app.js'

const el = panelRoot('tvs-root')
panelDevReload(el)
const base = panelBase(el, '/shield')
createRoot(el).render(<WeftRoot header={panelHeader()}><ShieldApp base={base} segments={segmentsOf(location.pathname.slice(base.length))} query={panelQuery()} /></WeftRoot>)
