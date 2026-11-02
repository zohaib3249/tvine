// Browser entry of the Shield panel bundle (dist/shield/shield.js), served by Warp at settings.shield.panel.path
// through shieldHandler (serve.ts). Data only through api.* (shield.*, auth.*).
import { createRoot } from 'react-dom/client'
import { WeftRoot } from '../../../weft/dist/index.js'
import { ShieldApp, segmentsOf } from './app.js'

const el = document.getElementById('tvs-root')!
const base = (el.dataset.base ?? '/shield').replace(/\/$/, '')
createRoot(el).render(<WeftRoot><ShieldApp base={base} segments={segmentsOf(location.pathname.slice(base.length))} query={Object.fromEntries(new URLSearchParams(location.search))} /></WeftRoot>)
