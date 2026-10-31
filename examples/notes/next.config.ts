import type { NextConfig } from 'next'

export default {
  compress: false,                            // Warp compresses (with its BREACH rule); Next must not gzip twice
} satisfies NextConfig
