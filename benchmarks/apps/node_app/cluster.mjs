import cluster from 'node:cluster'
if (cluster.isPrimary) { for (let i = 0; i < Number(process.env.WORKERS ?? 8); i++) cluster.fork() }
else await import('./server.mjs')
