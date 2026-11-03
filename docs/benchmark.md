# Benchmark

The same JSON API written in Tvine, raw Node, Express, FastAPI and Django, measured on one laptop. The code and the raw
results are in [`benchmarks/`](../benchmarks/README.md), so you can rerun everything with one command.

**Interactive page: [zohaib3249.github.io/tvine/benchmark.html](https://zohaib3249.github.io/tvine/benchmark.html)**, every chart with hover details and the full tables
(the same file is [docs/benchmark.html](benchmark.html) in the repo).

## In short

- **Against Django:** Tvine is faster on every endpoint, 5–11× on one process.
- **Against FastAPI:** Tvine is faster on every endpoint, on one process and on eight. On a page of 20 rows it is 9×
  faster, and its insert p99 is 15× lower.
- **Against Express:** Express is 1.4–2.6× faster on raw throughput on one process (the gap is smallest on a page of
  20 and on inserts) and 2.2× on eight. The benchmark Express app does only the query and the JSON. Tvine also
  validates input, keeps sessions, rate-limits, marks agents and serves every action over MCP.
- **Shield** costs about 16–19% of throughput. During a flood from one IP, a real visitor kept 100% of their
  requests answered. Without Shield, they kept 2%. A flood spread over 1,000 IPs is not stopped by per-IP limits.

## The test

| | |
|---|---|
| Machine | Apple M1 Pro, 8 cores, 16 GB; the load tool runs on the same machine |
| Versions | tvinejs 0.3.2 (Next 16.4.2), Express 5.3.0, FastAPI 0.162.0 + uvicorn 0.54.0, Django 5.2.18 + gunicorn 26.2.0, Node 26.0.0, Python 3.14.6, Redis 7.2.5 |
| Data | the same 10,000 rows in SQLite (WAL) in every app; identical JSON responses, checked before timing |
| Endpoints | `GET /api/ping`, `GET /api/items/<id>` (one row), `GET /api/items?limit=20&offset=n` (a page), `GET /api/cached/<id>` (Redis, then the database on a miss), `POST /api/items` (insert) |
| Main runs | one process each, production mode, 50 connections, 5 s warm-up, then three 15-second runs; the median is kept |
| Tvine settings | `tvine start`; Shield and the framework's general rate limit off for the speed runs |

## One process

![Requests a second, one process each](images/benchmark-one-process.svg)

| Endpoint | Tvine | Raw Node | Express | FastAPI | Django (threads) | Django (sync) |
|---|---|---|---|---|---|---|
| Ping | 18,951 · p99 6 ms | 44,525 · 2 ms | 48,882 · 2 ms | 17,752 · 5 ms | 2,339 · 43 ms | 1,617 · 4.6 s |
| One row | 12,591 · 10 ms | 42,098 · 2 ms | 32,814 · 3 ms | 4,751 · 17 ms | 1,251 · 109 ms | 920 · 5.4 s |
| Page of 20 | 6,793 · 14 ms | 9,706 · 10 ms | 9,409 · 10 ms | 753 · 113 ms | 850 · 129 ms | 864 · 5.6 s |
| Redis cache | 17,109 · 6 ms | 42,156 · 2 ms | 34,611 · 3 ms | 7,061 · 22 ms | 1,546 · 87 ms | 1,072 · 6.0 s |
| Insert | 8,951 · 13 ms | 13,373 · 20 ms | 13,253 · 19 ms | 3,936 · 202 ms | 1,677 · 106 ms | 1,302 · 4.8 s |

Requests a second and p99 latency. Raw Node and Express reach the load tool's own limit on ping, one row and the cache,
so their real ceiling may be higher. Django's sync worker closes the connection after every response, so on this
machine it is limited by opening new connections.

## Eight processes

![Requests a second, eight processes each](images/benchmark-all-cores.svg)

| | Raw Node | Express | Tvine | FastAPI | Django |
|---|---|---|---|---|---|
| Ping | 99,133 | 103,974 | 46,411 | 40,653 | 8,809 |
| One row | 89,330 | 85,751 | 39,497 | 15,622 | 5,666 |

200 connections from four load processes on the same eight cores. Tvine runs `tvine start --workers 8`, which requires
sessions, rate limits, channels and caches on Redis so every worker shares them. The other apps keep no sessions or
rate limits.

At a fixed request rate, eight Tvine processes held 25,000 requests a second (p99 52 ms) and failed at 50,000. Eight
Express processes held 50,000 (p99 78 ms) and failed at 100,000. 100,000 a second was not reachable on this laptop:
the load processes ran out of CPU first.

## Shield

| | Off | On | Change |
|---|---|---|---|
| Ping, req/s | 10,650 | 8,604 | −19% |
| One row, req/s | 7,154 | 6,011 | −16% |

Measured from 20,000 rotating IPs so the rate limit never fired: this is the cost of the checks alone. The Shield,
MCP and flood runs are from the tvinejs 0.3.1 run.

**Agents over MCP** (no errors in any run):

| Tool | 50 agents | 200 agents |
|---|---|---|
| `read_page`, Shield on | 3,333 req/s | 2,353 req/s |
| `read_page`, Shield off | 3,748 req/s | 2,150 req/s |
| an action tool, Shield on | 1,594 req/s | 1,348 req/s |
| an action tool, Shield off | 1,669 req/s | 1,844 req/s |

### Floods

![A real visitor during a 30-second flood](images/benchmark-flood.svg)

A 30-second flood against one-row reads while a separate visitor, on another IP, asks five times a second.

| Flood | Server answered | Turned away | Visitor answered | Visitor p50 |
|---|---|---|---|---|
| One IP, 1,000 connections, Shield on | 19,297 req/s | 99.9% | **100%** | 73 ms |
| One IP, 1,000 connections, Shield off | 7,073 req/s | – | **2%** | 8.5 s |
| 1,000 IPs, 1,000 connections, Shield on | 6,304 req/s | 0% | **0%** | – |
| One IP, 500 connections, Shield on | 21,151 req/s | 99.9% | 100% | 36 ms |
| One IP, 500 connections, Shield off | 6,991 req/s | – | 95.6% | 103 ms |
| 1,000 IPs, 500 connections, Shield on | 6,100 req/s | 0% | 86% | 123 ms |

Turning a request away costs far less than serving it, so a flood from one IP is absorbed and the visitor keeps getting
pages. A flood spread over 1,000 IPs keeps every IP under the per-IP limit, so the single process fills up. Stopping that
needs a whole-site emergency mode and more processes, which are on the roadmap.

## Caveats

- One laptop: the load tool and the servers share the same cores, with a little background load. Read the numbers as
  this machine's limits, not a production ceiling.
- SQLite rather than Postgres; Redis on the same machine.
- Tvine ran as a full app with Next.js and security headers in the same process. Express, FastAPI and raw Node ran with
  no security middleware.
- The scale, eight-process, MCP and flood results are single runs.
- Tvine and Express were measured with tvinejs 0.3.2; raw Node, FastAPI and Django numbers are from the earlier run on
  the same machine.
