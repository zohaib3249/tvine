// NOT a Tvine feature: Tvine has no built-in cluster / WEB_CONCURRENCY mode (it only reads WEB_CONCURRENCY to warn
// that memory backends are per process). This wrapper forks N copies of `tvine start` with node:cluster so they
// share one port. Sessions / rate limits / snapshot cache stay per process (memory backends).
import cluster from 'node:cluster'
if (cluster.isPrimary) { for (let i = 0; i < Number(process.env.WORKERS ?? 8); i++) cluster.fork() }
else {
  const { main } = await import('tvine/warp/dist/cli.js').catch(() => import('./node_modules/tvine/warp/dist/cli.js'))
  await main(process.argv.slice(2))
}
