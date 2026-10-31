import type { NextConfig } from 'next'

export default {
  serverExternalPackages: ['@tvine/warp'],   // Warp is Node-only: Next loads it from node_modules, never bundles it
  compress: false,                            // Warp compresses (with its BREACH rule); Next must not gzip twice
} satisfies NextConfig
