// Raw node:http baseline (no framework): same 5 endpoints, same SQL, same { ok, data } envelope.
import http from 'node:http'
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

const send = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) }).end(s) }
const nf = (res) => send(res, 404, { ok: false, code: 'domain', reason: 'not_found' })

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  let m
  if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, data: null })
  if (req.method === 'GET' && (m = p.match(/^\/api\/items\/(\d+)$/))) { const r = getOne.get(Number(m[1])); return r ? send(res, 200, { ok: true, data: out(r) }) : nf(res) }
  if (p === '/api/items' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit') ?? 20) | 0, 1), 100), offset = Math.max(Number(u.searchParams.get('offset') ?? 0) | 0, 0)
    return send(res, 200, { ok: true, data: pageQ.all(limit, offset).map(out) })
  }
  if (p === '/api/items' && req.method === 'POST') {
    let b = ''; for await (const c of req) b += c
    let j; try { j = JSON.parse(b) } catch { return send(res, 400, { ok: false, code: 'invalid_param' }) }
    if (typeof j?.name !== 'string' || typeof j.price !== 'number' || typeof j.category !== 'string') return send(res, 400, { ok: false, code: 'invalid_param' })
    return send(res, 201, { ok: true, data: out(ins.get(j.name, j.price, j.category, Date.now())) })
  }
  if (req.method === 'GET' && (m = p.match(/^\/api\/cached\/(\d+)$/))) {
    const key = `item:${m[1]}`, hit = await redis.get(key)
    if (hit !== null) return send(res, 200, { ok: true, data: JSON.parse(hit) })
    const r = out(getOne.get(Number(m[1]))); if (!r) return nf(res)
    await redis.set(key, JSON.stringify(r), { EX: 60 })
    return send(res, 200, { ok: true, data: r })
  }
  nf(res)
}).listen(Number(process.env.PORT ?? 5162), '127.0.0.1')
