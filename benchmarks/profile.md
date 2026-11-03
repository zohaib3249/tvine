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
