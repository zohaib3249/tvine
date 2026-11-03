## By endpoint (main: 1 process each, 50 connections, median of 3 × 15 s)

| endpoint | node | tvine | express | fastapi | django_sync | django_gthread |
|---|---|---|---|---|---|---|
| ping | 44525 (p99 2) | 12970 (p99 7) | 46689 (p99 2) | 17752 (p99 5) | 1617 (p99 4630) | 2339 (p99 43) |
| get | 42098 (p99 2) | 8049 (p99 12) | 31573 (p99 3) | 4751 (p99 17) | 920 (p99 5350) | 1251 (p99 109) |
| list | 9706 (p99 10) | 4681 (p99 22) | 9145 (p99 11) | 753 (p99 113) | 864 (p99 5600) | 850 (p99 129) |
| cached | 42156 (p99 2) | 11063 (p99 7) | 33283 (p99 3) | 7061 (p99 22) | 1072 (p99 5990) | 1546 (p99 87) |
| post | 13373 (p99 20) | 6195 (p99 17) | 13839 (p99 12) | 3936 (p99 202) | 1302 (p99 4830) | 1677 (p99 106) |

### Main runs, full detail

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine | ping | 50 | **12970** | 3 | 5 | 7 | 26 | 0 | 0 | 116 | 349 | 46 |
| tvine | get | 50 | **8049** | 5 | 7 | 12 | 61 | 0 | 0 | 110 | 362 | 31 |
| tvine | list | 50 | **4681** | 10 | 12 | 22 | 114 | 0 | 0 | 106 | 351 | 20 |
| tvine | cached | 50 | **11063** | 4 | 5 | 7 | 40 | 0 | 0 | 115 | 407 | 32 | hit 100.0%
| tvine | post | 50 | **6195** | 7 | 10 | 17 | 159 | 0 | 0 | 106 | 406 | 25 |
| express | ping | 50 | **46689** | 0 | 1 | 2 | 48 | 0 | 0 | 95 | 114 | 99 |
| express | get | 50 | **31573** | 1 | 1 | 3 | 31 | 0 | 0 | 95 | 96 | 82 |
| express | list | 50 | **9145** | 5 | 6 | 11 | 69 | 0 | 0 | 96 | 100 | 33 |
| express | cached | 50 | **33283** | 1 | 1 | 3 | 170 | 0 | 0 | 101 | 485 | 76 | hit 100.0%
| express | post | 50 | **13839** | 2 | 5 | 12 | 128 | 0 | 0 | 77 | 144 | 48 |
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
| express | ping | 50 | **40233** | 0 | 1 | 4 | 83 | 0 | 0 | 86 | 104 | 58+57 |

### Scale: GET /api/items/<id> by connections (single run)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tvine | get | 10 | **7995** | 1 | 2 | 3 | 18 | 0 | 0 | 112 | 364 | 31 |
| tvine | get | 50 | **8194** | 5 | 7 | 12 | 26 | 0 | 0 | 111 | 381 | 32 |
| tvine | get | 200 | **7723** | 25 | 29 | 42 | 95 | 0 | 0 | 110 | 426 | 32 |
| tvine | get | 500 | **7822** | 64 | 70 | 79 | 132 | 0 | 0 | 111 | 434 | 37 |
| node | get | 10 | **39709** | 0 | 0 | 0 | 47 | 0 | 0 | 95 | 128 | 92 |
| node | get | 50 | **41981** | 1 | 1 | 2 | 39 | 0 | 0 | 97 | 130 | 95 |
| node | get | 200 | **40842** | 4 | 5 | 9 | 65 | 0 | 0 | 97 | 139 | 95 |
| node | get | 500 | **39873** | 12 | 14 | 22 | 65 | 0 | 0 | 96 | 135 | 103 |
| express | get | 10 | **34897** | 0 | 0 | 0 | 42 | 0 | 0 | 97 | 145 | 86 |
| express | get | 50 | **34283** | 1 | 1 | 2 | 18 | 0 | 0 | 97 | 147 | 86 |
| express | get | 200 | **34094** | 5 | 6 | 10 | 80 | 0 | 0 | 97 | 129 | 86 |
| express | get | 500 | **31729** | 15 | 17 | 30 | 79 | 0 | 0 | 95 | 134 | 92 |

### All cores v2 (8 server processes, 4 client processes, 200 conns, single run)

| server | endpoint | conns | req/s | p50 ms | p90 | p99 | max | errors | non-2xx | server CPU % | RSS MB (max) | client CPU % | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| node_x8 | ping | 200 | **99133** | 1 | 3 | 19 | 206 | 0 | 0 | 299 | 1092 | 67+67+69+65 |
| node_x8 | get | 200 | **89330** | 1 | 5 | 20 | 154 | 0 | 0 | 363 | 916 | 62+65+61+65 |
| tvine_x8 | ping | 200 | **13600** | 12 | 25 | 58 | 152 | 0 | 0 | 362 | 2374 | 22+21+21+22 |
| tvine_x8 | get | 200 | **11407** | 14 | 29 | 68 | 150 | 0 | 0 | 409 | 2477 | 20+19+19+19 |
| express_x8 | ping | 200 | **92885** | 1 | 4 | 15 | 154 | 0 | 0 | 302 | 1174 | 69+62+68+65 |
| express_x8 | get | 200 | **81052** | 0 | 5 | 24 | 163 | 0 | 0 | 388 | 1163 | 55+54+54+54 |
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
| tvine_x8 | 1000 | 1 | 1000 | 6.4 | 17.2 | 56.6 | 0.00 | 86 | 6+6+6+6 |
| tvine_x8 | 5000 | 1 | 4998 | 6.1 | 76.1 | 157.4 | 0.00 | 340 | 19+19+19+19 |
| tvine_x8 | 10000 | 1 (failed) | 8576 | 1180.3 | 2532.5 | 2604.7 | 0.00 | 332 | 23+24+24+24 |
| tvine_x8 | 10000 | 2 (failed) | 9966 | 131.4 | 314.9 | 398.3 | 0.00 | 378 | 25+25+25+25 |
| express_x8 | 1000 | 1 | 1000 | 5.0 | 9.6 | 62.3 | 0.00 | 14 | 7+7+7+7 |
| express_x8 | 5000 | 1 | 4999 | 1.8 | 3.4 | 16.7 | 0.00 | 49 | 15+15+15+15 |
| express_x8 | 10000 | 1 | 9998 | 1.5 | 11.4 | 53.5 | 0.01 | 73 | 19+19+19+19 |
| express_x8 | 25000 | 1 | 24999 | 1.5 | 31.1 | 65.4 | 0.00 | 134 | 29+29+28+28 |
| express_x8 | 50000 | 1 (failed) | 49995 | 10.7 | 337.2 | 365.0 | 0.00 | 278 | 51+50+50+51 |
| express_x8 | 50000 | 2 (failed) | 49726 | 8.8 | 435.0 | 513.9 | 0.00 | 256 | 50+50+50+49 |

### Memory: one Tvine process, back-to-back 15 s runs (heap via inspector after each run)

| run | req/s | p99 ms | RSS max during run MB | heapUsed MB | heapUsed after forced GC MB | RSS after GC MB |
|---|---|---|---|---|---|---|
| start (idle) | – | – | 155 | 68.6 | 41.1 | 136.2 |
| cached #1 | 10652 | 8 | 480 | 204.6 | 57.4 | 191.2 |
| cached #2 | 10358 | 10 | 465 | 226.3 | 58.4 | 174.5 |
| cached #3 | 10250 | 11 | 451 | 190.2 | 57.3 | 158.8 |
| post #1 | 6210 | 16 | 419 | 70.8 | 55.1 | 149.8 |
| post #2 | 6059 | 17 | 427 | 92.5 | 55.1 | 156 |
| post #3 | 6242 | 16 | 418 | 161.1 | 55 | 160.2 |

### Tvine x8: built-in workers vs cluster wrapper, both with Redis backends

| variant | req/s | Redis ops/s | Redis CPU % |
|---|---|---|---|
| tvine start --workers 8 | 11075 | 334746 | 79.1 |
| node:cluster wrapper x8 (cluster.mjs), same Redis backends | 11223 | 338332 | 77.7 |

built-in workers and the wrapper are equal (~11.1k vs ~11.2k req/s) once both use Redis backends; ~19 Redis commands per anonymous GET (6 EVALSHA, 4 HSET, 4 HMGET, 4 TIME, 1 ZCOUNT), Redis at ~80% of one core. The earlier 17k (wrapper) used memory backends.
