import type { ReactNode } from 'react'
import { WeftRoot } from 'tvine/weft'

export const metadata = { title: 'Tvine App' }

// WeftRoot: the agent badge, WebMCP tools and tab control (after the user clicks Allow).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <WeftRoot>{children}</WeftRoot>
      </body>
    </html>
  )
}
