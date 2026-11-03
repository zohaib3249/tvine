// Express 5 + better-sqlite3 + node-redis. Same logic and response envelope as the Tvine app ({ ok, data }).
import express from 'express'
import Database from 'better-sqlite3'
import { createClient } from 'redis'

const db = new Database(process.env.DB ?? './app.db')
db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000')
const getOne = db.prepare('SELECT id, name, price, category, created_at FROM items WHERE id = ?')
const pageQ = db.prepare('SELECT id, name, price, category, created_at FROM items ORDER BY id LIMIT ? OFFSET ?')
const ins = db.prepare('INSERT INTO items (name, price, category, created_at) VALUES (?, ?, ?, ?) RETURNING id, name, price, category, created_at')
const out = (r) => r && ({ ...r, created_at: new Date(r.created_at).toISOString() })

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6391' })
await redis.connect()

const app = express()
app.disable('x-powered-by'); app.set('etag', false)
app.use(express.json())
app.get('/api/ping', (_q, res) => res.json({ ok: true, data: null }))
app.get('/api/items/:id', (q, res) => {
  const r = getOne.get(Number(q.params.id))
  r ? res.json({ ok: true, data: out(r) }) : res.status(404).json({ ok: false, code: 'domain', reason: 'not_found' })
})
app.get('/api/items', (q, res) => {
  const limit = Math.min(Math.max(Number(q.query.limit ?? 20) | 0, 1), 100), offset = Math.max(Number(q.query.offset ?? 0) | 0, 0)
  res.json({ ok: true, data: pageQ.all(limit, offset).map(out) })
})
app.post('/api/items', (q, res) => {
  const { name, price, category } = q.body ?? {}
  if (typeof name !== 'string' || typeof price !== 'number' || typeof category !== 'string') return res.status(400).json({ ok: false, code: 'invalid_param' })
  res.status(201).json({ ok: true, data: out(ins.get(name, price, category, Date.now())) })
})
app.get('/api/cached/:id', async (q, res) => {
  const key = `item:${Number(q.params.id)}`
  const hit = await redis.get(key)
  if (hit !== null) return res.json({ ok: true, data: JSON.parse(hit) })
  const r = out(getOne.get(Number(q.params.id)))
  if (!r) return res.status(404).json({ ok: false, code: 'domain', reason: 'not_found' })
  await redis.set(key, JSON.stringify(r), { EX: 60 })
  res.json({ ok: true, data: r })
})
app.listen(Number(process.env.PORT ?? 5152), '127.0.0.1')
