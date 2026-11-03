// redisBroker: the multi-host job store (docs/design/contrib/tasks.md §Brokers). The connection is the named one
// `settings.tasks.redis ?? 'default'` (packages/warp/src/redis: getRedis / getSubscriber / redisKey). Every state change is ONE Lua script, so it is atomic:
//
// - job: hash `j:<id>` (scalar fields as strings; args / result / chain kept as opaque JSON text, never decoded in Lua)
// - ready: one STREAM per queue × priority (`s:<queue>:<prio>`, consumer group `w`); `qs` orders them (higher
//   priority first). A claim XREADGROUPs them in order; the entry stays in the worker's PEL until the job settles
//   (XACK + XDEL). Within a priority: FIFO by when the job became ready.
// - delayed / retry backoff: sorted set `delayed` (score runAt), moved into its stream inside the claim script
// - lease: sorted set `lease` (score leaseUntil) = what the reaper reads (exact per job); a heartbeat also XCLAIMs
//   the entry to its worker (resets its idle time). cleanup() runs XAUTOCLAIM over every stream to adopt PEL entries
//   idle past 2 leases: orphans (job gone / settled) are acked away, a running job missing from `lease` is re-added.
// - fencing: every write after a claim checks the job's token + status='running' inside its script
// - unique: `SET l:<key> <jobId> PX window` (taken in the enqueue script), released when the job is final
// - chord: `HINCRBY g:<id> remaining -1` in the member's success script; the one reaching 0 marks the group
//   'firing' and gets the results; the callback (built in JS: it needs the task registry) goes in with a
//   compare-and-set firing → fired, so it fires once. A process that dies between the two leaves 'firing':
//   any worker's cleanup rebuilds and fires it (still once, same CAS) after 30 s.
// - beat: leader lock `l:beat` (compare-owner script), schedule CAS on `schedn` + the jobs in one script
// - wake-ups: PUBLISH `wake`; progress / status: PUBLISH `moved` (rows with an owner session), so web servers push
//   progress without polling. Pub/sub is at-most-once: workers also poll every 5 s; a lost progress event is
//   superseded by the next one, and the final status is always readable (tasks.status).
// All keys share the hash tag `{tasks}`, so the scripts' keys live in one cluster slot.
// Durability is the server's: run it with `appendonly yes` + `appendfsync everysec` (or `always`).
import { createHash, randomUUID } from 'node:crypto'
import { getRedis, getSubscriber, redisKey, type RedisClient } from '../../redis/index.js'
import type { Broker, Claim, ChordSpec, Final, NewJob, QueueStats, SigJSON, WorkerInfo } from './broker.js'
import type { JobRow, JobStatus } from './models.js'
import { bus, checkClaim, shown, type Moved, type StoreStatus } from './shared.js'

// keys go through the alias's prefix only (settings.redis.<alias>.prefix): a separate namespace = a separate alias
export interface RedisBrokerOpts { alias?: string; leaseMs?: number; safetyMs?: number }

const INT = new Set(['priority', 'attempts', 'maxRetries', 'runAt', 'leaseUntil', 'expiresAt', 'groupIndex', 'createdAt', 'startedAt', 'finishedAt', 'purgeAt', 'updatedAt'])
const BOOL = new Set(['acksLate', 'cancel'])
const JSONF = new Set(['args', 'result', 'chain'])
const COLS = ['id', 'task', 'queue', 'priority', 'status', 'args', 'result', 'error', 'attempts', 'maxRetries', 'runAt', 'leaseUntil', 'worker', 'token', 'acksLate',
  'expiresAt', 'progress', 'message', 'sid', 'userId', 'groupId', 'groupIndex', 'chain', 'parentId', 'dupOf', 'uniqueKey', 'cancel', 'createdAt',
  'startedAt', 'finishedAt', 'purgeAt', 'updatedAt']

function encRow(j: NewJob | Record<string, unknown>): Record<string, string> {
  const o: Record<string, string> = {}
  const row = { attempts: 0, cancel: false, ...({ maxRetries: 3, acksLate: true } as object), ...j } as Record<string, unknown>
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || !COLS.includes(k)) continue
    o[k] = JSONF.has(k) ? JSON.stringify(v) : BOOL.has(k) ? (v ? '1' : '0') : String(v)
  }
  return o
}
function decRow(h: Record<string, string>): JobRow | undefined {
  if (!h.id) return undefined
  const o: Record<string, unknown> = {}
  for (const c of COLS) {
    const v = h[c]
    o[c] = v === undefined ? (BOOL.has(c) ? false : null) : JSONF.has(c) ? JSON.parse(v) : BOOL.has(c) ? v === '1' : INT.has(c) ? Number(v) : c === 'progress' ? Number(v) : v
  }
  o.status = shown(o.status as StoreStatus)
  return o as JobRow
}

// ---- Lua ------------------------------------------------------------------------------------------------
// ARGV[1] = key base (the alias prefix + '{tasks}:'), KEYS[1] = base .. 'meta' (routes the script to the tag's slot)
const PRELUDE = `
local B = ARGV[1]
local wake = false
local function jk(id) return B .. 'j:' .. id end
local function setStatus(id, from, to, created)
  if from then redis.call('ZREM', B .. 'st:' .. from, id) end
  redis.call('ZADD', B .. 'st:' .. to, created, id)
  redis.call('HSET', jk(id), 'status', to)
end
local function moved(id)
  local f = redis.call('HMGET', jk(id), 'id', 'task', 'status', 'progress', 'message', 'sid', 'userId', 'attempts')
  if f[6] then
    redis.call('PUBLISH', B .. 'moved', cjson.encode({ id = f[1], task = f[2], status = f[3], progress = f[4], message = f[5], sid = f[6], userId = f[7], attempts = f[8] }))
  end
end
local function ready(id, q, prio)
  local m = q .. '|' .. prio
  local s = B .. 's:' .. m
  if not redis.call('ZSCORE', B .. 'qs', m) then
    pcall(redis.call, 'XGROUP', 'CREATE', s, 'w', '0', 'MKSTREAM')
    redis.call('ZADD', B .. 'qs', -tonumber(prio), m)
  end
  local e = redis.call('XADD', s, '*', 'id', id)
  redis.call('HSET', jk(id), 'entry', e, 'stream', s)
  wake = true
end
local function insert(row, now)
  local id = row.id
  if row.status == 'queued' and tonumber(row.runAt) > now then row.status = 'scheduled' end
  local a = {}
  for k, v in pairs(row) do a[#a + 1] = k; a[#a + 1] = v end
  redis.call('HSET', jk(id), unpack(a))
  redis.call('ZADD', B .. 'st:' .. row.status, row.createdAt, id)
  redis.call('ZADD', B .. 'all', row.createdAt, id)
  if row.status == 'queued' then ready(id, row.queue, row.priority)
  elseif row.status == 'scheduled' then redis.call('ZADD', B .. 'delayed', row.runAt, id); wake = true end
  if row.purgeAt then redis.call('ZADD', B .. 'purge', row.purgeAt, id) end
  if row.groupId then redis.call('ZADD', B .. 'gm:' .. row.groupId, tonumber(row.groupIndex or '0'), id) end
  moved(id)
end
local function live(id, token, expiredBefore)
  local f = redis.call('HMGET', jk(id), 'status', 'token', 'createdAt', 'leaseUntil')
  if expiredBefore and expiredBefore ~= '' and not (tonumber(f[4] or '0') < tonumber(expiredBefore)) then return nil end
  if f[1] == 'running' and f[2] == token then return f[3] end
  return nil
end
local function ack(id)
  local f = redis.call('HMGET', jk(id), 'stream', 'entry')
  if f[1] and f[2] then redis.call('XACK', f[1], 'w', f[2]); redis.call('XDEL', f[1], f[2]) end
  redis.call('HDEL', jk(id), 'stream', 'entry', 'leaseUntil')
  redis.call('ZREM', B .. 'lease', id)
end
local function unlockJob(id)
  local uk = redis.call('HGET', jk(id), 'uniqueKey')
  if uk and redis.call('GET', B .. 'l:' .. uk) == id then redis.call('DEL', B .. 'l:' .. uk) end
end
local function afterFinal(id, status, purgeAt)
  unlockJob(id)
  local gid = redis.call('HGET', jk(id), 'groupId')
  if gid and status ~= 'success' and redis.call('HGET', B .. 'g:' .. gid, 'status') == 'pending' then
    redis.call('HSET', B .. 'g:' .. gid, 'status', 'failed', 'purgeAt', purgeAt)
    redis.call('ZADD', B .. 'gpurge', purgeAt, gid)
  end
end
local function delJob(id)
  local f = redis.call('HMGET', jk(id), 'status', 'stream', 'entry')
  if f[2] and f[3] then redis.call('XACK', f[2], 'w', f[3]); redis.call('XDEL', f[2], f[3]) end
  if f[1] then redis.call('ZREM', B .. 'st:' .. f[1], id) end
  for _, z in ipairs({ 'all', 'purge', 'delayed', 'lease' }) do redis.call('ZREM', B .. z, id) end
  redis.call('DEL', jk(id))
end
local function done(r)
  if wake then redis.call('PUBLISH', B .. 'wake', '1') end
  return r
end
`
const S = {
  // ARGV: B, now, rows json, chord json | ''
  enqueue: `
local now = tonumber(ARGV[2])
local rows = cjson.decode(ARGV[3])
if redis.call('EXISTS', jk(rows[1].id)) == 1 then return 0 end
if ARGV[4] ~= '' then
  local c = cjson.decode(ARGV[4])
  redis.call('HSET', B .. 'g:' .. c.id, 'remaining', c.remaining, 'callback', c.callback, 'status', 'pending', 'createdAt', now)
end
for _, r in ipairs(rows) do insert(r, now) end
return done(1)`,
  // ARGV: B, now, row json, key, windowMs, ttlMs
  enqueueUnique: `
local now = tonumber(ARGV[2])
local row = cjson.decode(ARGV[3])
if redis.call('EXISTS', jk(row.id)) == 1 then return 0 end
local lk = B .. 'l:' .. ARGV[4]
local held = redis.call('GET', lk)
if not held or held == row.id then
  redis.call('SET', lk, row.id, 'PX', ARGV[5])
  row.uniqueKey = ARGV[4]
else
  row.status = 'deduped'; row.dupOf = held; row.finishedAt = tostring(now); row.purgeAt = tostring(now + tonumber(ARGV[6]))
end
insert(row, now)
return done(1)`,
  // ARGV: B, now, worker, token, leaseUntil, n, queues json ('*' or list), skip json
  claim: `
local now, worker, token, leaseUntil, n = tonumber(ARGV[2]), ARGV[3], ARGV[4], ARGV[5], tonumber(ARGV[6])
local want = nil
if ARGV[7] ~= '*' then want = {}; for _, q in ipairs(cjson.decode(ARGV[7])) do want[q] = true end end
local skip = {}
for _, t in ipairs(cjson.decode(ARGV[8])) do skip[t] = true end
for _, id in ipairs(redis.call('ZRANGEBYSCORE', B .. 'delayed', '-inf', now, 'LIMIT', 0, 1000)) do
  redis.call('ZREM', B .. 'delayed', id)
  local f = redis.call('HMGET', jk(id), 'status', 'queue', 'priority', 'createdAt')
  if f[1] == 'scheduled' then setStatus(id, 'scheduled', 'queued', f[4]); ready(id, f[2], f[3]) end
end
wake = false
local out, aside = {}, {}
for _, m in ipairs(redis.call('ZRANGE', B .. 'qs', 0, -1)) do
  if #out >= n then break end
  local q, prio = string.match(m, '^(.*)|(-?%d+)$')
  if not want or want[q] then
    local s = B .. 's:' .. m
    while #out < n do
      local r = redis.call('XREADGROUP', 'GROUP', 'w', worker, 'COUNT', n - #out, 'STREAMS', s, '>')
      if not r or not r[1] or #r[1][2] == 0 then break end
      for _, e in ipairs(r[1][2]) do
        local eid, id = e[1], e[2][2]
        local f = redis.call('HMGET', jk(id), 'status', 'task', 'entry', 'createdAt', 'runAt')
        if f[1] ~= 'queued' or f[3] ~= eid then
          redis.call('XACK', s, 'w', eid); redis.call('XDEL', s, eid)   -- stale: cancelled / purged / re-queued since
        elseif skip[f[2]] or tonumber(f[5]) > now then
          redis.call('XACK', s, 'w', eid); redis.call('XDEL', s, eid); aside[#aside + 1] = { id, q, prio }
        else
          -- stays in this worker's PEL until the job settles (XACK + XDEL there)
          setStatus(id, 'queued', 'running', f[4])
          redis.call('HSET', jk(id), 'worker', worker, 'token', token, 'leaseUntil', leaseUntil, 'startedAt', now, 'updatedAt', now)
          redis.call('HINCRBY', jk(id), 'attempts', 1)
          redis.call('ZADD', B .. 'lease', leaseUntil, id)
          out[#out + 1] = id
          moved(id)
        end
      end
    end
  end
end
for _, a in ipairs(aside) do ready(a[1], a[2], a[3]) end
wake = false
local nx = redis.call('ZRANGE', B .. 'delayed', 0, 0, 'WITHSCORES')
return { out, nx[2] or false }`,
  // ARGV: B, now, leaseUntil, id1, token1, id2, token2, …
  heartbeat: `
local lost, cancelled = {}, {}
for i = 4, #ARGV, 2 do
  local id, token = ARGV[i], ARGV[i + 1]
  local f = redis.call('HMGET', jk(id), 'status', 'token', 'cancel', 'stream', 'entry', 'worker')
  if f[1] == 'running' and f[2] == token then
    redis.call('HSET', jk(id), 'leaseUntil', ARGV[3])
    redis.call('ZADD', B .. 'lease', ARGV[3], id)
    if f[4] and f[5] and f[6] then redis.call('XCLAIM', f[4], 'w', f[6], 0, f[5], 'JUSTID') end
    if f[3] == '1' then cancelled[#cancelled + 1] = id end
  else lost[#lost + 1] = id end
end
return { lost, cancelled }`,
  // ARGV: B, now, id, token, pct, hasMsg, msg
  progress: `
if not live(ARGV[3], ARGV[4]) then return 0 end
redis.call('HSET', jk(ARGV[3]), 'progress', ARGV[5], 'updatedAt', ARGV[2])
if ARGV[6] == '1' then redis.call('HSET', jk(ARGV[3]), 'message', ARGV[7]) else redis.call('HDEL', jk(ARGV[3]), 'message') end
moved(ARGV[3])
return 1`,
  // ARGV: B, now, id, token, result json, purgeAt, next row json | ''
  succeed: `
local now, id = tonumber(ARGV[2]), ARGV[3]
local created = live(id, ARGV[4])
if not created then return { 0 } end
ack(id)
setStatus(id, 'running', 'success', created)
redis.call('HSET', jk(id), 'result', ARGV[5], 'progress', '100', 'finishedAt', ARGV[2], 'purgeAt', ARGV[6], 'updatedAt', ARGV[2])
redis.call('HDEL', jk(id), 'error')
redis.call('ZADD', B .. 'purge', ARGV[6], id)
if ARGV[7] ~= '' then insert(cjson.decode(ARGV[7]), now) end
unlockJob(id)
moved(id)
local gid = redis.call('HGET', jk(id), 'groupId')
if gid and redis.call('HGET', B .. 'g:' .. gid, 'status') == 'pending' then
  if redis.call('HINCRBY', B .. 'g:' .. gid, 'remaining', -1) <= 0 then
    redis.call('HSET', B .. 'g:' .. gid, 'status', 'firing', 'firingAt', ARGV[2], 'firingBy', id)
    redis.call('ZADD', B .. 'firing', now, gid)
    local res = {}
    for _, m in ipairs(redis.call('ZRANGE', B .. 'gm:' .. gid, 0, -1)) do res[#res + 1] = redis.call('HGET', jk(m), 'result') or 'null' end
    return done({ 1, gid, redis.call('HGET', B .. 'g:' .. gid, 'callback'), res })
  end
end
return done({ 1 })`,
  // ARGV: B, now, groupId, callback row json | '', purgeAt — firing → fired, once
  chordFire: `
local g = B .. 'g:' .. ARGV[3]
if redis.call('HGET', g, 'status') ~= 'firing' then return 0 end
redis.call('HSET', g, 'status', 'fired', 'purgeAt', ARGV[5])
redis.call('ZREM', B .. 'firing', ARGV[3])
redis.call('ZADD', B .. 'gpurge', ARGV[5], ARGV[3])
if ARGV[4] ~= '' then insert(cjson.decode(ARGV[4]), tonumber(ARGV[2])) end
return done(1)`,
  // ARGV: B, now, id, token, status, hasError, error, purgeAt, expiredBefore | ''
  finish: `
local id = ARGV[3]
local created = live(id, ARGV[4], ARGV[9])
if not created then return 0 end
ack(id)
setStatus(id, 'running', ARGV[5], created)
redis.call('HSET', jk(id), 'finishedAt', ARGV[2], 'purgeAt', ARGV[8], 'updatedAt', ARGV[2])
if ARGV[6] == '1' then redis.call('HSET', jk(id), 'error', ARGV[7]) elseif ARGV[6] == 'null' then redis.call('HDEL', jk(id), 'error') end
redis.call('ZADD', B .. 'purge', ARGV[8], id)
afterFinal(id, ARGV[5], ARGV[8])
moved(id)
return 1`,
  // ARGV: B, now, id, token, runAt, hasError, error, refund, expiredBefore | ''
  requeue: `
local now, id = tonumber(ARGV[2]), ARGV[3]
local created = live(id, ARGV[4], ARGV[9])
if not created then return 0 end
ack(id)
redis.call('HDEL', jk(id), 'worker', 'token')
redis.call('HSET', jk(id), 'runAt', ARGV[5], 'updatedAt', ARGV[2])
if ARGV[6] == '1' then redis.call('HSET', jk(id), 'error', ARGV[7]) elseif ARGV[6] == 'null' then redis.call('HDEL', jk(id), 'error') end
if ARGV[8] == '1' then redis.call('HINCRBY', jk(id), 'attempts', -1) end
if tonumber(ARGV[5]) > now then
  setStatus(id, 'running', 'scheduled', created)
  redis.call('ZADD', B .. 'delayed', ARGV[5], id); wake = true
else
  setStatus(id, 'running', 'queued', created)
  local f = redis.call('HMGET', jk(id), 'queue', 'priority')
  ready(id, f[1], f[2])
end
moved(id)
return done(1)`,
  // ARGV: B, now, id, ttlMs
  cancel: `
local now, id = tonumber(ARGV[2]), ARGV[3]
local f = redis.call('HMGET', jk(id), 'status', 'createdAt')
if not f[1] then return false end
if f[1] == 'queued' or f[1] == 'scheduled' then
  local purgeAt = now + tonumber(ARGV[4])
  redis.call('ZREM', B .. 'delayed', id)
  setStatus(id, f[1], 'cancelled', f[2])
  redis.call('HSET', jk(id), 'finishedAt', now, 'purgeAt', purgeAt, 'updatedAt', now)
  redis.call('ZADD', B .. 'purge', purgeAt, id)
  afterFinal(id, 'cancelled', purgeAt)
  moved(id)
  return 'cancelled'
end
if f[1] == 'running' then redis.call('HSET', jk(id), 'cancel', '1', 'updatedAt', now) end
return f[1]`,
  // ARGV: B, now, id
  retry: `
local id = ARGV[3]
local f = redis.call('HMGET', jk(id), 'status', 'createdAt', 'queue', 'priority')
if not f[1] then return false end
if f[1] ~= 'dead' and f[1] ~= 'expired' and f[1] ~= 'cancelled' then return f[1] end
redis.call('HDEL', jk(id), 'error', 'finishedAt', 'purgeAt', 'expiresAt', 'worker', 'token', 'leaseUntil')
redis.call('HSET', jk(id), 'attempts', '0', 'runAt', ARGV[2], 'cancel', '0', 'updatedAt', ARGV[2])
redis.call('ZREM', B .. 'purge', id)
setStatus(id, f[1], 'queued', f[2])
ready(id, f[3], f[4])
moved(id)
return done('requeued')`,
  // ARGV: B, status — deletes up to 1000
  purge: `
local ids = redis.call('ZRANGE', B .. 'st:' .. ARGV[2], 0, 999)
for _, id in ipairs(ids) do delJob(id) end
return #ids`,
  // ARGV: B, key, owner, ttlMs
  lock: `
local k = B .. 'l:' .. ARGV[2]
local held = redis.call('GET', k)
if held and held ~= ARGV[3] then return 0 end
redis.call('SET', k, ARGV[3], 'PX', ARGV[4])
return 1`,
  unlock: `
local k = B .. 'l:' .. ARGV[2]
if redis.call('GET', k) == ARGV[3] then redis.call('DEL', k) end
return 1`,
  // ARGV: B, name, spec, first
  schedule: `
local spec = redis.call('HGET', B .. 'sched', ARGV[2])
if spec == ARGV[3] then return { 0, redis.call('HGET', B .. 'schedn', ARGV[2]) } end
redis.call('HSET', B .. 'sched', ARGV[2], ARGV[3])
redis.call('HSET', B .. 'schedn', ARGV[2], ARGV[4])
return { 1, ARGV[4] }`,
  // ARGV: B, now, name, due, next, rows json
  fire: `
if redis.call('HGET', B .. 'schedn', ARGV[3]) ~= ARGV[4] then return 0 end
redis.call('HSET', B .. 'schedn', ARGV[3], ARGV[5])
redis.call('HSET', B .. 'schedl', ARGV[3], ARGV[2])
for _, r in ipairs(cjson.decode(ARGV[6])) do insert(r, tonumber(ARGV[2])) end
return done(1)`,
  // ARGV: B, now — result TTL, ≤1000 a call; members of a pending chord stay
  cleanup: `
local now = tonumber(ARGV[2])
local ids = redis.call('ZRANGEBYSCORE', B .. 'purge', '-inf', now, 'LIMIT', 0, 1000)
local n = 0
for _, id in ipairs(ids) do
  local gid = redis.call('HGET', jk(id), 'groupId')
  local st = gid and redis.call('HGET', B .. 'g:' .. gid, 'status')
  if st ~= 'pending' and st ~= 'firing' then delJob(id); n = n + 1 end
end
for _, gid in ipairs(redis.call('ZRANGEBYSCORE', B .. 'gpurge', '-inf', now, 'LIMIT', 0, 1000)) do
  redis.call('DEL', B .. 'g:' .. gid, B .. 'gm:' .. gid)
  redis.call('ZREM', B .. 'gpurge', gid)
end
return { #ids, n }`,
  // ARGV: B, minIdleMs — adopt PEL entries idle past 2 leases (see the header)
  repair: `
local fixed = 0
for _, m in ipairs(redis.call('ZRANGE', B .. 'qs', 0, -1)) do
  local s = B .. 's:' .. m
  local r = redis.call('XAUTOCLAIM', s, 'w', 'reaper', ARGV[2], '0-0', 'COUNT', 100)
  for _, e in ipairs(r[2]) do
    local eid, id = e[1], e[2] and e[2][2]
    local f = id and redis.call('HMGET', jk(id), 'status', 'entry', 'leaseUntil') or {}
    if f[1] == 'running' and f[2] == eid then
      if not redis.call('ZSCORE', B .. 'lease', id) then redis.call('ZADD', B .. 'lease', f[3] or 0, id); fixed = fixed + 1 end
    else
      redis.call('XACK', s, 'w', eid); redis.call('XDEL', s, eid); fixed = fixed + 1
    end
  end
  for _, eid in ipairs(r[3] or {}) do redis.call('XACK', s, 'w', eid); fixed = fixed + 1 end
end
return fixed`,
}
type ScriptName = keyof typeof S
const SHA = Object.fromEntries(Object.entries(S).map(([k, lua]) => [k, { lua: PRELUDE + lua, sha: createHash('sha1').update(PRELUDE + lua).digest('hex') }])) as Record<ScriptName, { lua: string; sha: string }>
type Arg = string | number
const flat = (r: unknown): Record<string, string> => {   // HGETALL: RESP2 [k, v, …] or RESP3 map
  if (Array.isArray(r)) { const o: Record<string, string> = {}; for (let i = 0; i < r.length; i += 2) o[String(r[i])] = String(r[i + 1]); return o }
  return (r ?? {}) as Record<string, string>
}

export function redisBroker(o: RedisBrokerOpts = {}): RedisBroker { return new RedisBroker(o) }

export class RedisBroker implements Broker {
  readonly base: string
  private alias: string
  private safetyMs: number
  private leaseMs: number
  private wakeFns = new Set<() => void>()
  private movedFns = new Set<(m: Moved) => void>()
  private timer?: NodeJS.Timeout
  private subscribed?: Promise<void>

  constructor(o: RedisBrokerOpts = {}) {
    this.alias = o.alias ?? 'default'
    this.base = `${redisKey(this.alias, '{tasks}')}:`
    this.safetyMs = o.safetyMs ?? 5_000
    this.leaseMs = o.leaseMs ?? 30_000
  }

  // one raw command on the alias's shared client (node-redis pipelines concurrent calls on its own)
  async cmd<T = unknown>(args: Arg[]): Promise<T> { return (await getRedis(this.alias)).sendCommand<T>(args.map(String)) }

  // EVALSHA, loading the script on NOSCRIPT (a restarted / failed-over server)
  private async call(name: ScriptName, ...args: Arg[]): Promise<unknown> {
    const s = SHA[name], c = await getRedis(this.alias)
    const a = ['1', `${this.base}meta`, this.base, ...args.map(String)]
    try { return await c.sendCommand(['EVALSHA', s.sha, ...a]) } catch (e) {
      if (!String((e as Error)?.message).includes('NOSCRIPT')) throw e
      return c.sendCommand(['EVAL', s.lua, ...a])
    }
  }
  private now() { return Date.now() }
  private local(e: 'enqueued' | 'moved') { setImmediate(() => bus.emit(e)) }

  async enqueue(jobs: NewJob[], chord?: ChordSpec) {
    if (!jobs.length) return
    const ch = chord ? JSON.stringify({ id: chord.id, remaining: String(chord.remaining), callback: JSON.stringify(chord.callback) }) : ''
    if (await this.call('enqueue', this.now(), JSON.stringify(jobs.map(encRow)), ch)) this.local('enqueued')
  }

  async enqueueUnique(job: NewJob, key: string, windowMs: number, ttlMs: number) {
    if (await this.call('enqueueUnique', this.now(), JSON.stringify(encRow(job)), key, windowMs, ttlMs)) this.local('enqueued')
  }

  async get(id: string) { return decRow(flat(await this.cmd(['HGETALL', `${this.base}j:${id}`]))) }

  private async rows(ids: string[]): Promise<JobRow[]> {
    const all = await Promise.all(ids.map((id) => this.cmd(['HGETALL', `${this.base}j:${id}`])))
    return all.map((h) => decRow(flat(h))).filter((j): j is JobRow => !!j)
  }

  async list({ status, queue, limit }: { status?: string; queue?: string; limit: number }) {
    const keys = !status ? ['all'] : status === 'queued' ? ['st:queued', 'st:scheduled'] : [`st:${status}`]
    const out: JobRow[] = []
    for (let off = 0; out.length < limit; off += 500) {
      const ids: { id: string; at: number }[] = []
      for (const k of keys) {
        const z = await this.cmd<unknown[]>(['ZREVRANGE', `${this.base}${k}`, off, off + 499, 'WITHSCORES'])
        // RESP2: [member, score, …]; RESP3: [[member, score], …]
        if (Array.isArray(z[0])) for (const [id, at] of z as [string, string][]) ids.push({ id, at: Number(at) })
        else for (let i = 0; i < z.length; i += 2) ids.push({ id: String(z[i]), at: Number(z[i + 1]) })
      }
      if (!ids.length) break
      ids.sort((a, b) => b.at - a.at)
      for (const j of await this.rows(ids.map((x) => x.id))) if (!queue || j.queue === queue) out.push(j)
      if (keys.length > 1) break   // ponytail: a merged two-key listing reads one page of each
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  async claim({ worker, queues, n, leaseMs, now = this.now(), skipTasks = [] }: Claim) {
    checkClaim(n, queues)
    const token = randomUUID()
    const [ids, next] = (await this.call('claim', now, worker, token, now + leaseMs, n, queues === '*' ? '*' : JSON.stringify(queues), JSON.stringify(skipTasks.slice(0, 100)))) as [string[], string | null]
    const jobs = (await this.rows(ids)).filter((j) => j.token === token)
    jobs.sort((a, b) => b.priority - a.priority || a.runAt - b.runAt)
    return { token, jobs, ...(jobs.length < n && next && { nextAt: Number(next) }) }
  }

  async heartbeat(runs: { id: string; token: string }[], leaseMs: number) {
    if (!runs.length) return { lost: [], cancelled: [] }
    const now = this.now()
    const [lost, cancelled] = (await this.call('heartbeat', now, now + leaseMs, ...runs.flatMap((r) => [r.id, r.token]))) as [string[], string[]]
    return { lost, cancelled }
  }

  async progress(id: string, token: string, pct: number, message: string | null) {
    return (await this.call('progress', this.now(), id, token, pct, message === null ? '0' : '1', message ?? '')) === 1
  }

  async succeed(job: JobRow, token: string, o: Parameters<Broker['succeed']>[2]) {
    const r = (await this.call('succeed', this.now(), job.id, token, JSON.stringify(o.result ?? null), o.purgeAt, o.next ? JSON.stringify(encRow(o.next)) : '')) as [number, string?, string?, string[]?]
    if (r[0] !== 1) return false
    if (o.next) this.local('enqueued')
    if (r[1]) {
      const cb = o.callback?.(JSON.parse(r[2]!) as SigJSON, r[3]!.map((x) => JSON.parse(x)))
      await this.call('chordFire', this.now(), r[1], cb ? JSON.stringify(encRow(cb)) : '', job.purgeAt ?? o.purgeAt)
      if (cb) this.local('enqueued')
    }
    return true
  }

  private err(e: string | null | undefined): [string, string] { return e === undefined ? ['0', ''] : e === null ? ['null', ''] : ['1', e] }

  async finish(job: JobRow, token: string, status: Final, o: { error?: string | null; purgeAt: number; expiredBefore?: number }) {
    return (await this.call('finish', this.now(), job.id, token, status, ...this.err(o.error), o.purgeAt, o.expiredBefore ?? '')) === 1
  }

  async requeue(id: string, token: string, o: { runAt: number; error?: string | null; refund?: boolean; expiredBefore?: number }) {
    const ok = (await this.call('requeue', this.now(), id, token, o.runAt, ...this.err(o.error), o.refund ? '1' : '0', o.expiredBefore ?? '')) === 1
    if (ok) this.local('enqueued')
    return ok
  }

  async expired(now: number, limit: number) {
    const ids = await this.cmd<string[]>(['ZRANGEBYSCORE', `${this.base}lease`, '-inf', `(${now}`, 'LIMIT', 0, limit])
    return (await this.rows(ids)).filter((j) => j.status === 'running')
  }

  async cancel(id: string, ttlMs: number) {
    const s = (await this.call('cancel', this.now(), id, ttlMs)) as StoreStatus | null
    return s ? shown(s) : undefined
  }

  async retry(id: string) {
    const s = (await this.call('retry', this.now(), id)) as StoreStatus | 'requeued' | null
    if (s === 'requeued') this.local('enqueued')
    return !s ? undefined : s === 'requeued' ? s : shown(s)
  }

  async purge(status: JobStatus) {
    let total = 0
    for (const st of status === 'queued' ? ['queued', 'scheduled'] : [status]) {
      for (;;) { const n = (await this.call('purge', st)) as number; total += n; if (n < 1000) break }
    }
    return total
  }

  // ponytail: redis locks run on the server's clock (PX); the `now` argument (tests, beat) is not used here
  async lock(key: string, owner: string, ttlMs: number) { return (await this.call('lock', key, owner, ttlMs)) === 1 }
  async unlock(key: string, owner: string) { await this.call('unlock', key, owner) }

  async schedule(name: string, spec: string, first: () => number) {
    const [fresh, next] = (await this.call('schedule', name, spec, first())) as [number, string]
    return { nextRunAt: Number(next), fresh: fresh === 1 }
  }

  async fire(name: string, due: number, next: number, jobs: NewJob[]) {
    const ok = (await this.call('fire', this.now(), name, due, next, JSON.stringify(jobs.map(encRow)))) === 1
    if (ok && jobs.length) this.local('enqueued')
    return ok
  }

  async register(w: WorkerInfo) { const now = this.now(); await this.cmd(['HSET', `${this.base}w`, w.name, JSON.stringify({ ...w, startedAt: now, beatAt: now, running: 0, processed: 0 })]) }
  async beat(name: string, running: number, processed: number) {
    const cur = await this.cmd<string | null>(['HGET', `${this.base}w`, name])
    if (cur) await this.cmd(['HSET', `${this.base}w`, name, JSON.stringify({ ...JSON.parse(cur), beatAt: this.now(), running, processed })])
  }
  async unregister(name: string) { await this.cmd(['HDEL', `${this.base}w`, name]) }
  private async workerRows() {
    return Object.values(flat(await this.cmd(['HGETALL', `${this.base}w`]))).map((v) => JSON.parse(v) as WorkerInfo & { beatAt: number; running: number; processed: number })
  }

  async cleanup(now: number, o: Parameters<Broker['cleanup']>[1] = {}) {
    for (;;) { const [scanned] = (await this.call('cleanup', now)) as [number, number]; if (scanned < 1000) break }
    for (const w of await this.workerRows()) if (w.beatAt < now - 86_400_000) await this.unregister(w.name)
    await this.call('repair', 2 * this.leaseMs)
    // chords a crashed member left 'firing': rebuild the callback and fire it (the CAS keeps it once)
    for (const gid of await this.cmd<string[]>(['ZRANGEBYSCORE', `${this.base}firing`, '-inf', now - 30_000, 'LIMIT', 0, 100])) {
      const g = flat(await this.cmd(['HGETALL', `${this.base}g:${gid}`]))
      if (g.status !== 'firing') { await this.cmd(['ZREM', `${this.base}firing`, gid]); continue }
      const parent = g.firingBy ? await this.get(g.firingBy) : undefined
      const members = await this.rows(await this.cmd<string[]>(['ZRANGE', `${this.base}gm:${gid}`, 0, -1]))
      let cb: NewJob | undefined
      try { cb = parent && o.callback?.(JSON.parse(g.callback!) as SigJSON, members.map((m) => m.result), parent) } catch { cb = undefined }
      await this.call('chordFire', this.now(), gid, cb ? JSON.stringify(encRow(cb)) : '', parent?.purgeAt ?? now + 86_400_000)
    }
  }

  async stats(leaseMs: number): Promise<QueueStats> {
    const now = this.now()
    const [queued, scheduled, running, dead] = await Promise.all(['queued', 'scheduled', 'running', 'dead'].map((s) => this.cmd<number>(['ZCARD', `${this.base}st:${s}`])))
    const workers = (await this.workerRows()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
    const beat = await this.cmd<string | null>(['GET', `${this.base}l:beat`])
    return {
      queued: Number(queued), scheduled: Number(scheduled), running: Number(running), dead: Number(dead), ...(beat && { beat }),
      workers: workers.map((w) => ({ name: w.name, queues: w.queues, running: w.running, processed: w.processed, beatAgoMs: now - w.beatAt, stale: now - w.beatAt > leaseMs })),
    }
  }

  // the alias's shared subscriber connection: `wake` for workers, `moved` for the progress relay
  private subscribe(): void {
    if (this.subscribed) return
    const wakeAll = () => { for (const f of [...this.wakeFns]) { try { f() } catch { /* listener */ } } }
    this.subscribed = (async () => {
      const sub = await getSubscriber(this.alias)
      await sub.SUBSCRIBE(`${this.base}wake`, () => wakeAll())
      await sub.SUBSCRIBE(`${this.base}moved`, (msg) => {
        let m: Record<string, unknown>
        try { m = JSON.parse(msg) as Record<string, unknown> } catch { return }
        const v = (x: unknown) => (x === false || x === undefined ? null : x)
        const mv: Moved = { id: String(m.id), task: String(m.task), status: shown(m.status as StoreStatus), progress: v(m.progress) === null ? null : Number(m.progress), message: v(m.message) as string | null, sid: v(m.sid) as string | null, userId: v(m.userId) as string | null, attempts: Number(m.attempts ?? 0) }
        for (const f of [...this.movedFns]) { try { f(mv) } catch { /* a watcher's own failure */ } }
      })
    })()
    this.subscribed.catch(() => { this.subscribed = undefined })   // redis down: the safety poll keeps workers going
    this.timer = setInterval(wakeAll, this.safetyMs)
    this.timer.unref()
  }

  watch(fn: (j: Moved) => void) {
    this.subscribe()
    this.movedFns.add(fn)
    return () => { this.movedFns.delete(fn) }
  }

  onWake(fn: () => void) {
    this.subscribe()
    this.wakeFns.add(fn)
    return () => { this.wakeFns.delete(fn) }
  }

  // ready: subscribed (tests wait for it before relying on a push)
  async ready(): Promise<void> { this.subscribe(); await this.subscribed }

  async close() {
    clearInterval(this.timer)
    this.wakeFns.clear(); this.movedFns.clear()
    if (this.subscribed) {
      await this.subscribed.catch(() => undefined)
      const sub = await getSubscriber(this.alias).catch(() => undefined)
      await sub?.UNSUBSCRIBE([`${this.base}wake`, `${this.base}moved`]).catch(() => undefined)
    }
    this.subscribed = undefined
  }
}
