#!/usr/bin/env node
// Committed (not built) so `pnpm install` links the `tvine` bin on a fresh clone, before dist/ exists.
import { main } from '../dist/cli.js'

main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code) })
