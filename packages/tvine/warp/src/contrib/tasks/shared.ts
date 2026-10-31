// What every broker shares (no runtime import of broker.ts, so the brokers and the factory never form a cycle):
// the in-process bus, claim validation, and the row status a caller sees.
import { EventEmitter } from 'node:events'
import type { JobRow, JobStatus } from './models.js'

// in-process notifications: a write in this process wakes workers ('enqueued') and watchers ('moved') at once
export const bus = new EventEmitter()
bus.setMaxListeners(0)
export const notify = (e: 'enqueued' | 'moved' | 'outbox'): void => { setImmediate(() => bus.emit(e)) }

export const QUEUE_RE = /^[a-z0-9_-]{1,64}$/i
export const MAX_CLAIM = 100

export function checkClaim(n: number, queues: string[] | '*'): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLAIM) throw new Error(`claim: n must be 1-${MAX_CLAIM}`)
  if (queues !== '*' && (!queues.length || !queues.every((x) => QUEUE_RE.test(x)))) throw new Error('claim: bad queue names')
}

// file / memory / redis keep a delayed job as 'scheduled' (its own index: delayed jobs never slow a claim); callers
// see it as 'queued', like the db broker's rows
export type StoreStatus = JobStatus | 'scheduled'
export const shown = (s: StoreStatus): JobStatus => (s === 'scheduled' ? 'queued' : s)

// what the progress relay needs of a row that moved
export type Moved = Pick<JobRow, 'id' | 'task' | 'status' | 'progress' | 'message' | 'sid' | 'userId' | 'attempts'>

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
