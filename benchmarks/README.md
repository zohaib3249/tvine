# Benchmarks

The code behind [docs/benchmark.md](../docs/benchmark.md): the same JSON API (ping, one row, a page of 20, a Redis
cache read, an insert) written in Tvine, raw Node, Express, FastAPI and Django, and the load driver that measures them.

```bash
cd packages/tvine && pnpm build && cd ../../benchmarks
./run.sh        # ~60 minutes: installs deps, seeds 10,000 rows, runs every section, writes results.json + summary.tables.md
```

Needs Node 22.15+, Python 3.14 with `uv`, and `redis-server`. It starts its own Redis on port 6391 and the apps on
5150–5199, and stops them at the end.

| Path | What it is |
|---|---|
| `apps/tvine_app`, `apps/express_app`, `apps/fastapi_app`, `apps/django_app`, `apps/node_app` | the five apps |
| `bench.mjs` | starts each app, runs each section, records every run in `results.json` |
| `load.mjs` | load clients: autocannon, and an open-loop fixed-rate client for the ramp |
| `seed.py` | generates and loads the same 10,000 rows into each app's SQLite file |
| `summarize.mjs`, `profile-report.mjs` | turn `results.json` and the CPU profile into tables |
| `results.json` | the published run: every number, versions and settings |
| `report.mjs` | builds `docs/benchmark.html` (data embedded, no libraries) from `results.json`: `node report.mjs` |
