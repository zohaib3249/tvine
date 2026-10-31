// tvine.tasks models (docs/design/contrib/tasks.md §Queue). Times are epoch-ms ints: one comparison form on
// every engine, so the broker's claim statements bind plain numbers.
import { defineModel, field, type Infer } from '../../index.js'

export const STATUSES = ['queued', 'running', 'success', 'dead', 'expired', 'cancelled', 'deduped'] as const
export type JobStatus = (typeof STATUSES)[number]
export const FINAL: readonly JobStatus[] = ['success', 'dead', 'expired', 'cancelled', 'deduped']

export const Job = defineModel('tasks_job', {
  id: field.uuid(),
  task: field.text(),
  queue: field.text({ index: true }),
  priority: field.int({ default: 0 }),
  status: field.enum(STATUSES, { default: 'queued' }),
  args: field.json({ optional: true }),
  result: field.json({ optional: true }),
  error: field.text({ optional: true }),
  attempts: field.int({ default: 0 }),
  maxRetries: field.int({ default: 3 }),
  runAt: field.int(),
  leaseUntil: field.int({ optional: true }),
  worker: field.text({ optional: true }),
  token: field.text({ optional: true, hidden: true }),   // lease fencing token: never shown (admin, serializers)
  acksLate: field.bool({ default: true }),
  expiresAt: field.int({ optional: true }),
  progress: field.float({ optional: true }),
  message: field.text({ optional: true }),
  // the owner's live session id (the relay routes progress to it): hidden, never in admin values or serializer output
  sid: field.text({ optional: true, hidden: true }),
  userId: field.text({ optional: true }),
  groupId: field.uuid({ optional: true, index: true }),
  groupIndex: field.int({ optional: true }),
  chain: field.json({ optional: true }),
  parentId: field.uuid({ optional: true }),
  dupOf: field.uuid({ optional: true }),
  uniqueKey: field.text({ optional: true }),
  cancel: field.bool({ default: false }),
  createdAt: field.int(),
  startedAt: field.int({ optional: true }),
  finishedAt: field.int({ optional: true }),
  purgeAt: field.int({ optional: true, index: true }),
  updatedAt: field.int({ index: true }),
}, { indexes: [{ fields: ['status', 'queue', 'priority', 'runAt'], name: 'tasks_job_claim_idx' }] })   // the worker's claim scan

// chord state: members decrement `remaining` in their success transaction; 0 fires the callback (CAS on status)
export const Group = defineModel('tasks_group', {
  id: field.uuid(),
  remaining: field.int(),
  callback: field.json({ optional: true }),
  status: field.enum(['pending', 'fired', 'failed'] as const, { default: 'pending' }),
  createdAt: field.int(),
  purgeAt: field.int({ optional: true }),
})

// unique-dedupe locks (`unique:<hash>`) and the beat leader (`beat`)
export const Lock = defineModel('tasks_lock', {
  id: field.id(),
  key: field.text({ unique: true }),
  owner: field.text(),
  expiresAt: field.int(),
})

export const Schedule = defineModel('tasks_schedule', {
  id: field.id(),
  name: field.text({ unique: true }),
  spec: field.text(),
  nextRunAt: field.int(),
  lastRunAt: field.int({ optional: true }),
})

export const WorkerRow = defineModel('tasks_worker', {
  id: field.id(),
  name: field.text({ unique: true }),
  queues: field.text(),
  concurrency: field.int(),
  pid: field.int(),
  host: field.text(),
  startedAt: field.int(),
  beatAt: field.int(),
  running: field.int({ default: 0 }),
  processed: field.int({ default: 0 }),
})

// durable enqueue (task opt `durable: true`): one tiny row written in the CALLER's transaction, pushed to the
// broker by the outbox relay after commit (never lost). Lives in the main database, unlike the broker's tables.
export const Outbox = defineModel('tasks_outbox', {
  id: field.uuid(),
  payload: field.json(),
  createdAt: field.int({ index: true }),
})

export type JobRow = Infer<typeof Job>
