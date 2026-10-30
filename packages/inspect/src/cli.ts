#!/usr/bin/env node
// tvine-inspect [url=http://localhost:3000] [--port 7357]
import { startInspector } from './server.js'

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const port = i >= 0 ? Number(args.splice(i, 2)[1]) : 7357
const target = args[0] ?? 'http://localhost:3000'

try {
  const ins = await startInspector({ target, port })
  console.error(`tvine inspect: ${ins.url} → ${target} (the target app must call attachInspector(server) for the traffic log)`)
  const stop = () => void ins.close().then(() => process.exit(0))
  process.once('SIGINT', stop).once('SIGTERM', stop)
} catch (e) {
  console.error(`tvine inspect: ${(e as Error).message}`)
  process.exit(1)
}
