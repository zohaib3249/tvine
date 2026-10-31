// Mount: app/admin/[[...path]]/layout.tsx → `export { default } from 'tvine/admin/layout'`.
// Loads the package's compiled CSS (Tailwind already applied; the host needs no Tailwind config).
// The host's root layout keeps <WeftRoot> (tab control, WebMCP, presence) — the admin renders inside it.
import type { ReactNode } from 'react'
import './admin.css'

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
