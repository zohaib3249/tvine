import type { NextConfig } from 'next'

export default {
  compress: false,                            // Warp compresses (with its BREACH rule); Next must not gzip twice
  devIndicators: false,                       // no Next.js dev badge: Weft draws its own agent badge
  turbopack: { root: "/" },   // --local: the linked clone must sit inside the root
} satisfies NextConfig
