// `tvine tasks bench`: the configured broker's raw speed (no handler work), on a private copy of the store —
// file: a sibling temp file on the same disk; redis: the same server through a throwaway alias (its own prefix); memory: a fresh one.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { Settings } from '../../core/types.js'
import { configureRedis } from '../../redis/index.js'
import type { Broker, NewJob } from './broker.js'
import { fileBroker } from './file.js'
import { memoryBroker } from './memory.js'
import { redisBroker } from './redis.js'

export interface BenchOpts { jobs: number; workers: number; batch: number }
export interface BenchResult { broker: string; jobs: number; enqueuePerSec: number; jobsPerSec: number; claimP50Ms: number; claimP99Ms: number; busyRetries?: number }

const row = (now: number): NewJob => ({
  id: randomUUID(), task: 'bench.noop', queue: 'bench', priority: 0, status: 'queued', args: { n: 1, pad: 'x'.repeat(100) },
  maxRetries: 0, acksLate: true, runAt: now, expiresAt: null, createdAt: now, updatedAt: now, sid: null, userId: null,
  groupId: null, groupIndex: null, chain: null, parentId: null, dupOf: null, uniqueKey: null,
})
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0 }

export async function runBench(b: Broker, name: string, o: BenchOpts): Promise<BenchResult> {
  let t0 = performance.now()
  for (let i = 0; i < o.jobs; i++) await b.enqueue([row(Date.now())])   // one transaction per job, like .delay()
  const enqueuePerSec = o.jobs / ((performance.now() - t0) / 1000)
  const lat: number[] = []
  let done = 0
  t0 = performance.now()
  await Promise.all(Array.from({ length: o.workers }, async (_, w) => {
    for (;;) {
      const c0 = performance.now()
      const { token, jobs } = await b.claim({ worker: `bench-${w}`, queues: ['bench'], n: o.batch, leaseMs: 60_000 })
      lat.push(performance.now() - c0)
      if (!jobs.length) return
      for (const j of jobs) if (await b.succeed(j, token, { result: null, purgeAt: Date.now() })) done++
    }
  }))
  const jobsPerSec = done / ((performance.now() - t0) / 1000)
  return { broker: name, jobs: done, enqueuePerSec: Math.round(enqueuePerSec), jobsPerSec: Math.round(jobsPerSec), claimP50Ms: +pct(lat, 50).toFixed(3), claimP99Ms: +pct(lat, 99).toFixed(3) }
}

export async function benchConfigured(settings: Pick<Settings, 'tasks' | 'redis'>, o: BenchOpts): Promise<BenchResult> {
  const t = settings.tasks
  if (t.broker === 'db') throw new Error("tvine tasks bench measures the file / memory / redis brokers; 'db' is the app's own database")
  if (t.broker === 'memory') return runBench(memoryBroker(), 'memory', o)
  if (t.broker === 'redis') {
    const conn = settings.redis[t.redis ?? 'default']
    if (!conn) throw new Error(`settings.redis.${t.redis ?? 'default'} is not configured`)
    const alias = `bench-${randomUUID()}`
    configureRedis({ redis: { [alias]: { ...conn, prefix: `${conn.prefix ?? 'tvine:'}${alias}:` } } })
    const b = redisBroker({ alias })
    try { return await runBench(b, 'redis', o) } finally {
      let cur = '0'
      do { const [next, keys] = await b.cmd<[string, string[]]>(['SCAN', cur, 'MATCH', `${b.base}*`, 'COUNT', 1000]); cur = next; if (keys.length) await b.cmd(['DEL', ...keys]) } while (cur !== '0')
      await b.close()
    }
  }
  const path = `${t.file}.bench-${process.pid}`
  const b = fileBroker({ path, durable: t.durable })
  try { return { ...(await runBench(b, `file${t.durable ? ' (durable)' : ''}`, o)), busyRetries: b.busyRetries } } finally {
    await b.close()
    for (const f of ['', '-wal', '-shm', '.wake', '.moved']) fs.rmSync(`${path}${f}`, { force: true })
  }
}
