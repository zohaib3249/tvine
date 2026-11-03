# FastAPI + uvicorn + stdlib sqlite3 (sync `def` endpoints -> Starlette threadpool, one connection per thread)
# + redis.asyncio for the cache endpoint. Same logic and { ok, data } envelope as the other apps.
import os, sqlite3, threading, time
from datetime import datetime, timezone
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import json

DB = os.environ.get('DB', './app.db')
COLS = 'id, name, price, category, created_at'
_local = threading.local()

def conn():
    c = getattr(_local, 'c', None)
    if c is None:
        c = sqlite3.connect(DB, check_same_thread=False, isolation_level=None)
        c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA busy_timeout=5000')
        _local.c = c
    return c

def iso(ms): return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
def row(t): return t and {'id': t[0], 'name': t[1], 'price': t[2], 'category': t[3], 'created_at': iso(t[4])}
def get_row(i): return row(conn().execute(f'SELECT {COLS} FROM items WHERE id = ?', (i,)).fetchone())

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
r = aioredis.from_url(os.environ.get('REDIS_URL', 'redis://127.0.0.1:6391'))

class NewItem(BaseModel):
    name: str
    price: float
    category: str

@app.get('/api/ping')
async def ping(): return {'ok': True, 'data': None}

@app.get('/api/items/{item_id}')
def get_item(item_id: int):
    t = get_row(item_id)
    if not t: raise HTTPException(404)
    return {'ok': True, 'data': t}

@app.get('/api/items')
def page(limit: int = 20, offset: int = 0):
    limit, offset = min(max(limit, 1), 100), max(offset, 0)
    rows = conn().execute(f'SELECT {COLS} FROM items ORDER BY id LIMIT ? OFFSET ?', (limit, offset)).fetchall()
    return {'ok': True, 'data': [row(t) for t in rows]}

@app.post('/api/items', status_code=201)
def create(it: NewItem):
    t = conn().execute(f'INSERT INTO items (name, price, category, created_at) VALUES (?,?,?,?) RETURNING {COLS}',
                       (it.name, it.price, it.category, int(time.time() * 1000))).fetchone()
    return {'ok': True, 'data': row(t)}

@app.get('/api/cached/{item_id}')
async def cached(item_id: int):
    key = f'item:{item_id}'
    hit = await r.get(key)
    if hit is not None: return {'ok': True, 'data': json.loads(hit)}
    t = await run_in_threadpool(get_row, item_id)
    if not t: raise HTTPException(404)
    await r.set(key, json.dumps(t), ex=60)
    return {'ok': True, 'data': t}
