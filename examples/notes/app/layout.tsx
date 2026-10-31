import type { ReactNode } from 'react'
import { WeftRoot } from '@tvine/weft'

export const metadata = { title: 'Notes' }

// WeftRoot: the agent badge, WebMCP tools and tab control (after the user clicks Allow).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '2rem auto' }}>
        <WeftRoot>{children}</WeftRoot>
      </body>
    </html>
  )
}
