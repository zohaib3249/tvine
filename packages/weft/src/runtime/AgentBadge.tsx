'use client'
import type { ReactNode } from 'react'

// Headless: pass `active` from useTvineChannel().agentActive. No styling imposed.
export function AgentBadge({ active, className, children }: { active: boolean; className?: string; children?: ReactNode }) {
  if (!active) return null
  return <span data-tvine-agent-badge className={className}>{children ?? 'agent active'}</span>
}
