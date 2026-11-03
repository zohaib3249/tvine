# Benchmark: Tvine vs Express vs FastAPI vs Django, plus Tvine Shield

**Machine:** Apple M1 Pro (8 cores), 16 GB, macOS (Darwin 27), Node 26.0.0, Python 3.14.6 (GIL on), redis-server 7.2.5 on :6391.
The load client runs on the same machine as the server. Docker's VM, WindowServer and Cursor used about 0.5–0.8 of one core the whole time (`results.json → machine.background*`).
**Versions:** tvinejs 0.3.1 (repo at 752490f; `warp/dist` built 11:49, before the first run), Next 16.4.2, Express 5.3.0, better-sqlite3 13.0.3 (Tvine) / 12.11.1 (Express, raw Node), node-redis 6.3.1, FastAPI 0.162.0, uvicorn 0.54.0 with uvloop 0.23 and httptools 0.9, Django 5.2.18, gunicorn 26.2.0, redis-py 8.1.0, SQLite 3.53.3 (Python), autocannon 8.0.0.

## Setup (same everywhere)

- **Data:** one SQLite file per app, WAL mode, table `items(id, name, price, category, created_at)`.
  - All apps load the same 10,000 rows from `data/seed.json` (`seed.py`, fixed seed 42).
  - `created_at` is stored as epoch milliseconds (Tvine's SQLite datetime format). Every app returns it as an ISO string.
  - Each app's DB is reseeded and Redis is flushed before each server starts.
- **Same JSON:** every app returns `{"ok":true,"data":…}`, which is Tvine's `urls.ts` reply shape. `sanity` in results.json shows the bodies are byte-identical across Tvine, Express, FastAPI and Django for ping, get, list, cached (miss and hit) and POST (201).
- **Header:** every request carries `x-tvine-api: 1`. Tvine `urls.ts` routes need it; the other apps ignore it.
- **Load:** autocannon, one Node process per client, 50 connections, keep-alive, pipelining 1.
  - 5 s warm-up (thrown away), then 3 × 15 s measured runs, median by req/s. "Repeat twice" was read as 1 run + 2 repeats.
  - IDs cycle 1..10000; list offset = (i·20) mod 10000.
- **Server CPU % and RSS:** sampled every 1 s over the whole process tree, from cumulative CPU time in `ps`.
- **Cache endpoint:** before every measured run, all 10,000 keys are filled through the app itself. The hit ratio comes from Redis `INFO`.
- **Port pool:** every run waits until TIME_WAIT sockets < 2000, because macOS has only 16k ephemeral ports.

**Tvine app** (`apps/tvine_app`), idiomatic mix:
- Models: `apps/items/models.ts`.
- `DetailView` for GET `/api/items/<id>`, `CreateView` for POST `/api/items` (gives the 201).
- `defineAction` for `ping`, for the limit/offset list (the generic `ListView` only does cursor/page paging and rejects unknown params), and for `cached`, which uses `caches.redis` (Tvine cache API, redis backend; key `tvine:cache:redis::1:item:<id>`, EX 60).
- Routes in `apps/items/urls.ts`.
- Run with `tvine start` (NODE_ENV=production, Next built), 1 process, debug off, logging level warn.

**What was disabled in Tvine for the main runs:**
- `limits.rate = { limit: 1e9 }`: the general limit, which is also each action's default own rate.
- No `tvine.shield`. The `RateLimit` middleware is not listed (it is off by default).
- `admin.stats` off, `db.slowQueryMs: 0`.
- `SslRedirect` and `session.secure` removed from the generated `prod.ts` (plain http on loopback).
- `installedApps: ['items']` only.
- Middleware kept: the default RequestId, AllowedHosts, Security, Cors, GZip. Autocannon sends no Accept-Encoding, so nothing is compressed.

**Other apps:**
- **Express 5:** better-sqlite3 prepared statements + node-redis.
- **Raw node:http** (machine ceiling, added later): same SQL.
- **FastAPI:** stdlib sqlite3 with sync `def` endpoints in the threadpool (one connection per thread). `cached` is `async` with redis.asyncio, and runs the DB read on a miss in the threadpool. uvicorn `--workers 1 --loop uvloop --http httptools --log-level warning --no-access-log`.
- **Django:** ORM `.values()` queries, `JsonResponse`, middleware = Security + Common, DEBUG=False, redis-py. Run under gunicorn `-w 1` (sync) and `-w 1 --worker-class gthread --threads 8`.

## By endpoint (main: 1 process each, 50 connections, median of 3 × 15 s)

| endpoint | node | tvine | express | fastapi | django_sync | django_gthread |
|---|---|---|---|---|---|---|
| ping | 44525 (p99 2) | 11765 (p99 8) | 48884 (p99 1) | 17752 (p99 5) | 1617 (p99 4630) | 2339 (p99 43) |
| get | 42098 (p99 2) | 7417 (p99 14) | 33859 (p99 2) | 4751 (p99 17) | 920 (p99 5350) | 1251 (p99 109) |
| list | 9706 (p99 10) | 4621 (p99 22) | 9478 (p99 10) | 753 (p99 113) | 864 (p99 5600) | 850 (p99 129) |
| cached | 42156 (p99 2) | 7976 (p99 12) | 35337 (p99 3) | 7061 (p99 22) | 1072 (p99 5990) | 1546 (p99 87) |
| post | 13373 (p99 20) | 4844 (p99 20) | 12941 (p99 17) | 3936 (p99 202) | 1302 (p99 4830) | 1677 (p99 106) |

### Main runs, full detail

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine | ping | 50 | **11765** | 4 | 5 | 8 | 29 | 0 | 0 | 114 | 414 | 44 |
| tvine | get | 50 | **7417** | 6 | 8 | 14 | 140 | 0 | 0 | 109 | 388 | 30 |
| tvine | list | 50 | **4621** | 10 | 12 | 22 | 119 | 0 | 0 | 108 | 387 | 20 |
| tvine | cached | 50 | **7976** | 5 | 8 | 12 | 1369 | 0 | 0 | 121 | 2624 | 24 | hit 100.0%
| tvine | post | 50 | **4844** | 9 | 12 | 20 | 236 | 0 | 0 | 110 | 1778 | 21 |
| express | ping | 50 | **48884** | 0 | 1 | 1 | 34 | 0 | 0 | 96 | 141 | 100 |
| express | get | 50 | **33859** | 1 | 1 | 2 | 13 | 0 | 0 | 98 | 144 | 85 |
| express | list | 50 | **9478** | 5 | 6 | 10 | 65 | 0 | 0 | 98 | 132 | 31 |
| express | cached | 50 | **35337** | 1 | 1 | 3 | 94 | 0 | 0 | 101 | 563 | 79 | hit 100.0%
| express | post | 50 | **12941** | 2 | 5 | 17 | 131 | 0 | 0 | 75 | 126 | 41 |
| fastapi | ping | 50 | **17752** | 2 | 3 | 5 | 114 | 0 | 0 | 94 | 38 | 52 |
| fastapi | get | 50 | **4751** | 10 | 12 | 17 | 93 | 0 | 0 | 186 | 93 | 17 |
| fastapi | list | 50 | **753** | 66 | 90 | 113 | 176 | 0 | 0 | 294 | 91 | 5 |
| fastapi | cached | 50 | **7061** | 6 | 8 | 22 | 206 | 0 | 0 | 92 | 70 | 25 | hit 100.0%
| fastapi | post | 50 | **3936** | 2 | 7 | 202 | 2664 | 0 | 0 | 107 | 38 | 18 |
| django_gthread | ping | 50 | **2339** | 20 | 24 | 43 | 250 | 0 | 0 | 110 | 59 | 13 |
| django_gthread | get | 50 | **1251** | 36 | 47 | 109 | 340 | 0 | 0 | 117 | 48 | 9 |
| django_gthread | list | 50 | **850** | 55 | 66 | 129 | 373 | 0 | 0 | 178 | 49 | 6 |
| django_gthread | cached | 50 | **1546** | 28 | 41 | 87 | 219 | 0 | 0 | 110 | 48 | 11 | hit 100.0%
| django_gthread | post | 50 | **1677** | 25 | 35 | 106 | 1913 | 0 | 0 | 117 | 48 | 12 |
| django_sync | ping | 50 | **1617** | 2337 | 4128 | 4630 | 4689 | 0 | 0 | 65 | 30 | 27 |
| django_sync | get | 50 | **920** | 2661 | 4641 | 5350 | 5415 | 0 | 0 | 67 | 37 | 21 |
| django_sync | list | 50 | **864** | 2577 | 4984 | 5600 | 5663 | 0 | 0 | 71 | 38 | 20 |
| django_sync | cached | 50 | **1072** | 1902 | 4948 | 5990 | 6118 | 0 | 0 | 56 | 38 | 20 | hit 93.1%
| django_sync | post | 50 | **1302** | 2535 | 4543 | 4830 | 4883 | 0 | 0 | 70 | 34 | 22 |
| node | ping | 50 | **44525** | 0 | 1 | 2 | 56 | 0 | 0 | 79 | 106 | 97 |
| node | get | 50 | **42098** | 1 | 1 | 2 | 17 | 0 | 0 | 97 | 107 | 95 |
| node | list | 50 | **9706** | 4 | 6 | 10 | 136 | 0 | 0 | 96 | 95 | 33 |
| node | cached | 50 | **42156** | 1 | 1 | 2 | 62 | 0 | 0 | 98 | 309 | 95 | hit 100.0%
| node | post | 50 | **13373** | 2 | 5 | 20 | 137 | 0 | 0 | 74 | 131 | 42 |

### Client-bound check (2 autocannon processes)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| express | ping | 50 | **49057** | 0 | 1 | 1 | 34 | 0 | 0 | 98 | 142 | 62+60 |

### Scale: GET /api/items/<id> by connections (single run)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine | get | 10 | **7267** | 1 | 2 | 3 | 36 | 0 | 0 | 109 | 392 | 30 |
| tvine | get | 50 | **7471** | 6 | 8 | 14 | 78 | 0 | 0 | 108 | 391 | 30 |
| tvine | get | 200 | **6182** | 28 | 38 | 107 | 342 | 0 | 0 | 100 | 446 | 29 |
| tvine | get | 500 | **6314** | 77 | 88 | 162 | 192 | 0 | 0 | 105 | 418 | 34 |
| node | get | 10 | **39709** | 0 | 0 | 0 | 47 | 0 | 0 | 95 | 128 | 92 |
| node | get | 50 | **41981** | 1 | 1 | 2 | 39 | 0 | 0 | 97 | 130 | 95 |
| node | get | 200 | **40842** | 4 | 5 | 9 | 65 | 0 | 0 | 97 | 139 | 95 |
| node | get | 500 | **39873** | 12 | 14 | 22 | 65 | 0 | 0 | 96 | 135 | 103 |
| express | get | 10 | **34959** | 0 | 0 | 0 | 22 | 0 | 0 | 97 | 141 | 86 |
| express | get | 50 | **34973** | 1 | 1 | 2 | 36 | 0 | 0 | 97 | 141 | 86 |
| express | get | 200 | **34059** | 5 | 6 | 8 | 39 | 0 | 0 | 97 | 140 | 85 |
| express | get | 500 | **33297** | 14 | 16 | 27 | 76 | 0 | 0 | 96 | 135 | 94 |

### All cores v2 (8 server processes, 4 client processes, 200 conns, single run)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| node_x8 | ping | 200 | **99133** | 1 | 3 | 19 | 206 | 0 | 0 | 299 | 1092 | 67+67+69+65 |
| node_x8 | get | 200 | **89330** | 1 | 5 | 20 | 154 | 0 | 0 | 363 | 916 | 62+65+61+65 |
| tvine_x8 | ping | 200 | **33930** | 2 | 15 | 46 | 182 | 0 | 0 | 457 | 2578 | 42+42+41+43 |
| tvine_x8 | get | 200 | **17011** | 5 | 30 | 80 | 402 | 0 | 0 | 417 | 2342 | 25+26+24+25 |
| express_x8 | ping | 200 | **85582** | 1 | 5 | 17 | 301 | 0 | 0 | 297 | 1223 | 65+66+61+62 |
| express_x8 | get | 200 | **53921** | 1 | 8 | 42 | 256 | 0 | 0 | 298 | 998 | 44+44+44+45 |
| fastapi_x8 | ping | 200 | **40653** | 5 | 27 | 71 | 256 | 122 | 0 | 340 | 580 | 42+43+43+41 |
| fastapi_x8 | get | 200 | **15622** | 14 | 30 | 85 | 204 | 0 | 0 | 539 | 672 | 18+30+27+17 |
| django_x8 | ping | 200 | **8809** | 43 | 89 | 145 | 267 | 68 | 0 | 581 | 430 | 16+17+18+16 |
| django_x8 | get | 200 | **5666** | 40 | 73 | 167 | 423 | 0 | 0 | 521 | 345 | 15+12+13+13 |

### Profiled Tvine run

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine_prof | get | 50 | **7202** | 6 | 8 | 14 | 68 | 0 | 0 | 111 | 486 | 29 |

### Shield overhead (trustProxy 1, 20,000 rotating IPs)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine_proxy | ping | 50 | **10650** | 4 | 5 | 10 | 94 | 0 | 0 | 113 | 424 | 41 |
| tvine_proxy | get | 50 | **7154** | 6 | 8 | 15 | 57 | 0 | 0 | 108 | 404 | 28 |
| tvine_shield | ping | 50 | **8604** | 5 | 7 | 12 | 67 | 0 | 0 | 111 | 519 | 33 |
| tvine_shield | get | 50 | **6011** | 7 | 9 | 18 | 162 | 0 | 0 | 110 | 457 | 25 |

### Agent burst over MCP (single run)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine_shield | mcp_read | 50 | **3333** | 14 | 16 | 35 | 356 | 0 | 0 | 129 | 580 | 17 |
| tvine_shield | mcp_read | 200 | **2353** | 70 | 112 | 178 | 4558 | 0 | 0 | 117 | 695 | 13 |
| tvine_shield | mcp_tool | 50 | **1594** | 29 | 34 | 62 | 652 | 0 | 0 | 114 | 704 | 10 |
| tvine_shield | mcp_tool | 200 | **1348** | 124 | 161 | 439 | 9181 | 0 | 0 | 111 | 748 | 10 |
| tvine_proxy | mcp_read | 50 | **3748** | 12 | 15 | 28 | 279 | 0 | 0 | 125 | 545 | 18 |
| tvine_proxy | mcp_read | 200 | **2150** | 99 | 108 | 125 | 224 | 0 | 0 | 116 | 611 | 12 |
| tvine_proxy | mcp_tool | 50 | **1669** | 28 | 32 | 56 | 970 | 0 | 0 | 113 | 650 | 10 |
| tvine_proxy | mcp_tool | 200 | **1844** | 99 | 108 | 130 | 9071 | 0 | 0 | 114 | 646 | 11 |

### Floods (30 s, GET /api/items/<id>) + 5 req/s legit user

| scenario | conns | flood req/s | 200 | 429 | socket errors | share 429 | server CPU % | RSS MB | legit before p50/p99 ms | legit during success | legit during p50/p99 ms | legit codes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single-IP flood (12.0.0.1), Shield ON | 1000 | 19297 | 449 | 578448 | 13220 | 99.9% | 117 | 541 | 3.7 / 9.2 | 100% (102/102) | 73.1 / 111.8 | {"200":102} |
| distributed flood (1,000 rotating IPs), Shield ON | 1000 | 6304 | 189096 | 0 | 414990 | 0.0% | 114 | 479 | 4.1 / 17.2 | 0% (0/130) | – / – | {"ECONNRESET":117,"EPIPE":13} |
| single-IP flood (12.0.0.1), Shield OFF | 1000 | 7073 | 212181 | 0 | 402160 | 0.0% | 111 | 474 | 3.5 / 11.7 | 2% (1/51) | 8482.1 / 8482.1 | {"200":1,"ECONNRESET":42,"EPIPE":7,"TimeoutError":1} |
| single-IP flood (12.0.0.1), Shield ON, 500 conns | 500 | 21151 | 449 | 634094 | 10102 | 99.9% | 118 | 452 | 3.4 / 9.6 | 100% (122/122) | 36.2 / 54.1 | {"200":122} |
| distributed flood (1,000 rotating IPs), Shield ON, 500 conns | 500 | 6100 | 182979 | 0 | 62865 | 0.0% | 113 | 493 | 4.2 / 9.7 | 86% (74/86) | 123.2 / 9158.7 | {"200":74,"ECONNRESET":12} |
| single-IP flood (12.0.0.1), Shield OFF, 500 conns | 500 | 6991 | 209710 | 0 | 29845 | 0.0% | 111 | 438 | 2.5 / 16.6 | 96% (87/91) | 102.5 / 8170.2 | {"200":87,"ECONNRESET":4} |

### Fixed-rate ramp, GET /api/items/<id>, all cores, 200 conns, 4 clients

| server | target req/s | attempt | achieved req/s (completed / wall time) | p50 ms | p99 ms | max | errors+non2xx % | server CPU % | client CPU % |
|---|---|---|---|---|---|---|---|---|---|
| tvine_x8 | 1000 | 1 | 988 | 5.4 | 194.0 | 302.8 | 0.00 | 64 | 7+7+7+7 |
| tvine_x8 | 5000 | 1 | 4999 | 2.5 | 169.7 | 337.2 | 0.00 | 205 | 17+16+17+16 |
| tvine_x8 | 10000 | 1 (failed) | 9998 | 56.6 | 486.2 | 584.6 | 0.00 | 320 | 27+24+25+24 |
| tvine_x8 | 10000 | 2 (failed) | 9998 | 3.6 | 1782.9 | 1871.8 | 0.00 | 279 | 23+23+23+23 |
| express_x8 | 1000 | 1 | 1000 | 5.0 | 7.3 | 16.9 | 0.00 | 15 | 7+7+7+7 |
| express_x8 | 5000 | 1 | 5000 | 1.7 | 3.0 | 16.2 | 0.00 | 51 | 15+15+15+15 |
| express_x8 | 10000 | 1 | 9999 | 1.4 | 6.0 | 74.4 | 0.00 | 79 | 20+20+20+20 |
| express_x8 | 25000 | 1 | 24915 | 1.4 | 12.9 | 56.4 | 0.00 | 129 | 28+28+28+31 |
| express_x8 | 50000 | 1 (failed) | 49991 | 2.6 | 404.5 | 514.3 | 0.01 | 272 | 52+56+54+57 |
| express_x8 | 50000 | 2 | 49996 | 2.3 | 168.3 | 190.8 | 0.00 | 278 | 50+57+51+51 |
| express_x8 | 100000 | 1 (failed) | 13728 | 72843.2 | 94407.5 | 94413.3 | 0.00 | 102 | 94+94+93+94 |
| express_x8 | 100000 | 2 (failed) | 15395 | 61051.5 | 84928.1 | 84931.8 | 0.00 | 108 | 94+94+93+95 |

Notes on the tables:
- `django_sync` is **connection-churn bound (no keep-alive)**. The gunicorn sync worker closes the socket after every response, so the client opens a new TCP connection per request. Those runs are 10 s, not 15 s, and the 2–5 s latencies are mostly connections waiting to be accepted.
- The first 15 s django_sync runs ran out of local ports (EADDRNOTAVAIL). They stay in results.json but are superseded.
- `node`/`express` ping, get and cached at 1 process are **client-bound**: the autocannon process sits at 85–100 % CPU. A 2-client recheck of Express ping gave the same 49k, so about 45–49k is roughly the one-process Node ceiling on this box.
- Tvine is never client-bound (client 20–44 %).
- All-cores runs: 8 server processes plus 4 client processes share 8 cores, so absolute numbers are a floor. Tvine has no built-in multi-process mode: `WEB_CONCURRENCY` is only read to print a warning. `tvine_x8` uses a small `node:cluster` wrapper (`apps/tvine_app/cluster.mjs`) that runs `tvine start` 8 times on one port.

## Fixed-rate ramp: how it was measured

- The ramp section above is version 3. It uses the open-loop client in `load.mjs` (`mode: 'rate'`):
  - requests spread evenly in 1 ms slots;
  - 4 processes × 50 keep-alive sockets;
  - latency counted from the **scheduled** send time, so time spent queued in the client counts.
- Each step lasts 15 s. A step fails at p99 > 200 ms or errors > 1 %, and a failed step is retried once.
- The first two versions used autocannon `overallRate` and are invalid. autocannon gives each connection a per-second quota and resets it on a 1 s `setInterval` (`autocannon/lib/httpClient.js` lines 67–72 and 156). Against an idle 8-worker cluster that produced ~1 s stalls: p99 ≈ 970–1000 ms with the servers at 8–30 % CPU. Reproduced outside the harness. Those runs are marked superseded.
- At 100k req/s the client is the limit, not Express: 4 clients at 94 % CPU managed only ~15k completed req/s, with latency piling up in the client. So **100k req/s on /api/items/<id> was not reachable with this client on this machine.** The best measured all-cores closed-loop numbers are raw Node 89k and Express 54k.

## Where the time goes in one Tvine process (GET /api/items/<id>, 50 conns, `node --cpu-prof`)

profile: 22.3 s sampled, busy 20.5 s (92.3%)

| # | function (self time) | share of all samples |
|---|---|---|
| 1 | `refill  dist/security/ratelimit.js:30` | 16.0% |
| 2 | `prepare  node_modules/better-sqlite3/lib/methods/wrappers.js:4` | 10.7% |
| 3 | `(idle)  ` | 7.7% |
| 4 | `query  dist/data/driver.js:15` | 6.7% |
| 5 | `(garbage collector)  ` | 3.8% |
| 6 | `structuredClone  node:internal/worker/js_transferable:112` | 3.6% |
| 7 | `writevGeneric  node:internal/stream_base_commons:121` | 3.5% |
| 8 | `processTicksAndRejections  node:internal/process/task_queues:72` | 2.1% |
| 9 | `(program)  ` | 1.8% |
| 10 | `pipeline  dist/core/dispatch.js:423` | 1.6% |
| 11 | `toApiResult  dist/transport/api.js:50` | 1.4% |
| 12 | `(anonymous)  dist/core/dispatch.js:560` | 1.2% |
| 13 | `randomFillSync  node:internal/crypto/random:119` | 1.2% |
| 14 | `readFileSync  node:fs:429` | 1.1% |
| 15 | `nextTick  node:internal/process/task_queues:112` | 1.1% |

| module group | self time | share of busy |
|---|---|---|
| tvine security/ratelimit | 3602 ms | 17.5% |
| sqlite (better-sqlite3 JS) | 2582 ms | 12.6% |
| tvine data/driver | 1489 ms | 7.3% |
| tvine core/dispatch | 1257 ms | 6.1% |
| (garbage collector) | 846 ms | 4.1% |
| node:worker/js_transferable | 838 ms | 4.1% |
| node:stream_base_commons | 789 ms | 3.8% |
| tvine data/sql | 728 ms | 3.5% |
| zod | 711 ms | 3.5% |
| node:process/task_queues | 701 ms | 3.4% |
| tvine transport/api | 590 ms | 2.9% |
| (program) | 405 ms | 2.0% |
| tvine views/generic | 404 ms | 2.0% |
| node:crypto/random | 321 ms | 1.6% |
| node:fs | 302 ms | 1.5% |
| tvine data/queryset | 297 ms | 1.4% |
| node:url | 264 ms | 1.3% |
| tvine core/request | 261 ms | 1.3% |
| native/builtin | 254 ms | 1.2% |
| node:timers | 243 ms | 1.2% |
| node:async_context_frame | 189 ms | 0.9% |
| tvine middleware/index | 188 ms | 0.9% |
| node:_http_outgoing | 187 ms | 0.9% |
| tvine data/pending | 175 ms | 0.9% |

How to read it (source checked, nothing changed):
1. **`security/ratelimit.js` `refill`, 17.5 % of busy time:** the biggest single cost, even with the limit lifted to 1e9.
   - Every anonymous request gets a fresh throwaway sid.
   - So the per-sid bucket map stays at its 10,000-entry LRU cap, and each request inserts a key and evicts the oldest with `map.delete(map.keys().next().value)`.
   - In V8 that front-delete pattern leaves deleted slots that the iterator must skip.
   - Skipping the sid bucket for throwaway sessions, or using a ring or clock LRU, would remove most of this.
2. **better-sqlite3 `prepare`, 10.7 %:** `data/driver.ts` runs `db.prepare(sql).all(...)` on every query, with no statement cache. Express and raw Node prepare once.
3. **Driver, SQL compile and queryset (`data/*`), ~12 %:** the ORM's own cost per query.
4. **Request dispatch (`core/dispatch`, `transport/api`, `views/generic`), ~11 %:** includes `structuredClone` 4 % (copying session data for the handler) and zod 3.5 %.
5. **Next.js routing and the HTTP middleware stack:** about 1 % each, so they are not the bottleneck.
6. **GC:** about 4 %.

## Findings

1. **Single process, Tvine is about 4–5× slower than Express and raw Node on simple reads.**

   | endpoint | Tvine | Express | raw Node |
   |---|---|---|---|
   | get by id | 7.4k | 33.9k (client-bound) | 42k (client-bound) |
   | ping | 11.8k | 49k | 45k |

   Tvine does beat FastAPI on reads (get 7.4k vs 4.8k, list 4.6k vs 0.75k), and beats Django by 3–6×. The gap to Express is not the HTTP layer or Next.js (~1 % each). It is per-request framework work:
   - the rate-limit bookkeeping on throwaway sessions (17.5 %);
   - re-preparing every SQL statement (10.7 %);
   - ORM SQL building and dispatch, including a `structuredClone` of session data and zod validation.

2. **Writes and pages narrow the gap.**
   - POST: Tvine 4.8k vs Express 12.9k. Each Tvine POST without a cookie also creates a session, so a `Set-Cookie` comes back on every POST.
   - List (20 rows with OFFSET): Tvine 4.6k vs Express 9.5k, about 2×, because SQLite's OFFSET scan dominates.
   - Tvine p99 stays low at 50 conns: 8–22 ms.

3. **Tvine latency under concurrency.** One process stays flat at ~6–7k req/s from 10 to 500 connections, with p99 growing from 3 to 162 ms. In the fixed-rate ramp, `tvine_x8` already shows p99 ≈ 170–194 ms at 1k–5k req/s while p50 is 2.5–5 ms. It failed the 200 ms p99 bar at 10k (p99 486 ms, then 1.8 s), with servers at ~300 % of 800 % CPU. That points to periodic event-loop stalls, not to being out of CPU. Express x8 holds p99 ≤ 13 ms up to 25k req/s and passes 50k on retry (p99 168 ms).

4. **All cores, closed loop, 200 conns.**

   | | raw Node | Express | Tvine | FastAPI | Django |
   |---|---|---|---|---|---|
   | ping | 99k | 86k | 34k | 41k | 8.8k |
   | get | 89k | 54k | 17k | 15.6k | 5.7k |

   Only raw Node gets near 100k, and only on ping, with the client using ~2.7 of the 8 cores. Tvine x8 gets about 2.3–2.9× its 1-process number, and uses 2.3–2.6 GB RSS for 8 processes (~300 MB each, Next included).

5. **Memory.** The Tvine process is ~390 MB idle under load (Next is loaded in-process) vs ~130 MB for Express. On the Redis `cached` endpoint, Tvine's RSS climbed to 2.6 GB within 45 s (Express 563 MB, raw Node 483 MB, same node-redis 6.3.1). It came back down to 1.8 GB during the next endpoint, so it looks like GC heap growth rather than a confirmed leak. Worth a heap snapshot.

6. **Shield cost (enforce, default rules, 20,000 rotating IPs so the limiter never fires).**

   | endpoint | Shield OFF | Shield ON | change | added time per request |
   |---|---|---|---|---|
   | ping | 10.65k | 8.60k | −19 % | ≈ 22 µs |
   | get | 7.15k | 6.01k | −16 % | ≈ 27 µs |

   p99 rises by 2–3 ms. Over MCP it costs about 10 % on `read_page` at 50 conns (3.75k → 3.33k). At 200 conns read_page gets 2.35k with Shield vs 2.15k without, which is within noise. The typed tool `items_get` gets 1.6k vs 1.67k at 50 conns, but at 200 conns 1.35k vs 1.84k (−27 %), with p99 439 ms. No errors anywhere.

7. **Shield makes unknown API clients face a challenge.** A JSON API client with an unrecognised User-Agent (`bench/1.0`, or a browser UA without the pass cookie) gets **403 `tvine-shield: challenge`** on `/api/items/<id>`. Empty UA, `curl/*` and `Claude-User/1.0` pass. That matters for real API consumers: the overhead tests used UA `curl/8.7.1`.

8. **Single-IP flood: Shield works, and the real user is barely hurt.** 1000 connections from one IP for 30 s:
   - 99.9 % of flood requests got 429 (449 passed, i.e. 300/min + burst).
   - The server kept answering ~19k req/s, almost all 429s, at ~117 % CPU and 541 MB.
   - The 5 req/s real user on another IP had **100 % success**, p50 73 ms / p99 112 ms (3.7 / 9 ms before the flood). With 500 connections: p50 36 / p99 54 ms.
   - **Without Shield**, the same flood left the real user with **2 % success** (1 of 51; the rest ECONNRESET / EPIPE / timeouts) at 1000 conns. At 500 conns it was 96 % success but p99 8.2 s.

9. **Distributed flood (1,000 rotating IPs): Shield did not protect the real user.** This is the expected limit of per-IP rate limiting, stated plainly:
   - Each IP sends ~190 requests in 30 s, under 300/min, so **0 % got 429** and every flood request passed (6.3k req/s served).
   - The real user had **0 % success at 1000 connections** (all ECONNRESET / EPIPE) and **86 % at 500 connections** (p99 9.2 s).
   - The resets come from the kernel accept queue (`kern.ipc.somaxconn = 128`) and the event loop being saturated.
   - Stopping a distributed flood needs a CDN/WAF in front, network (ASN) rate rules, or many more processes. Tvine's own code comment in `security/ratelimit.ts` says the same.

10. **Small Tvine bug seen along the way:** over MCP the typed tool `items_get` returns `"created_at": {}`, so the Date is lost in the MCP result envelope, while HTTP `urls.ts` returns the ISO string. The typed tool also needs a `sid` from `read_page` first: without one it answers `expired_sid`, whereas `read_page` works without a sid.

## Caveats

- Single machine: client and server share 8 cores, plus ~0.5–0.8 of a core of background load (Docker VM, WindowServer, Cursor).
- `kern.ipc.somaxconn = 128` caps the accept queue. That shapes the 500/1000-connection and flood results. No sysctl was changed.
- SQLite with WAL, not Postgres. OFFSET paging cost is SQLite's.
- 1 worker per framework for the main comparison. The all-cores runs are single 15 s runs. Scale, MCP and floods are single runs.
- autocannon latency resolution is 1 ms. The `rate` client uses 1 ms slots.
- Tvine runs as a full `tvine start` (Next in-process) with its default middleware. Express, FastAPI and raw Node have no security headers. Django has Security + Common middleware.
- FastAPI's list endpoint (753 req/s) is limited by Python building rows and ISO dates under the GIL, plus threadpool hand-off. aiosqlite was not tried.
