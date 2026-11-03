// Browser entry of the Shield panel bundle (dist/shield/shield.js), served by Warp at settings.shield.panel.path
// through shieldHandler (serve.ts). Data only through api.* (shield.*, auth.*).
import { createRoot } from 'react-dom/client'
import { devReload } from '../../../weft/dist/runtime/devReload.js'
import { WeftRoot } from '../../../weft/dist/index.js'
import { ShieldApp, segmentsOf } from './app.js'

const el = document.getElementById('tvs-root')!
if (el.dataset.devReload) devReload(el.dataset.devReload)   // tvine dev only: the shell sets it (serve.ts)
const base = (el.dataset.base ?? '/shield').replace(/\/$/, '')
createRoot(el).render(<WeftRoot><ShieldApp base={base} segments={segmentsOf(location.pathname.slice(base.length))} query={Object.fromEntries(new URLSearchParams(location.search))} /></WeftRoot>)
