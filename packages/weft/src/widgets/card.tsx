import { createElement } from 'react'
import { CardClient, type CardProps } from './card.client.js'
export type { CardProps } from './card.client.js'

// Server-safe (no 'use client'): drops `hidden` keys from `data` BEFORE the client part, so a field the
// agent must not see never travels in the RSC payload either (props of a client component are serialized).
export function Card({ hidden, data, ...rest }: CardProps) {
  const h = new Set(hidden)
  return createElement(CardClient, { ...rest, data: hidden ? Object.fromEntries(Object.entries(data).filter(([k]) => !h.has(k))) : data })
}
