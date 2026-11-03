#!/bin/sh
# Rerun everything: deps, seed, own redis on 6391, every section, summary, cleanup. ~60 min.
set -e
B=$(cd "$(dirname "$0")" && pwd); cd "$B"
TVINE="$B/../packages/tvine/warp/bin/tvine.js"   # the framework from this repo (build it first: cd packages/tvine && pnpm build)
npm install --silent
[ -d .venv ] || uv venv -q --python 3.14 .venv
uv pip install -q --python .venv/bin/python fastapi 'uvicorn[standard]' 'redis>=5' 'django>=5.2,<6' gunicorn
(cd apps/express_app && npm install --silent)
# Tvine app (created with: node $TVINE startproject tvine_app --local, then the sources in apps/tvine_app/{apps,config})
[ -f apps/tvine_app/.env ] || printf "TVINE_SECRET=%s\nDATABASE_URL=file:./tvine.db\n" "$(openssl rand -hex 32)" > apps/tvine_app/.env
(cd apps/tvine_app && pnpm install --silent && node node_modules/tvine/warp/bin/tvine.js migrate \
  && BENCH_SHIELD=1 node node_modules/tvine/warp/bin/tvine.js migrate \
  && NODE_ENV=production TVINE_SECRET=$(grep TVINE_SECRET .env | cut -d= -f2) TVINE_ALLOWED_HOSTS=127.0.0.1 DATABASE_URL=file:./tvine.db pnpm tvine build)
[ -f data/seed.json ] || .venv/bin/python seed.py gen
.venv/bin/python seed.py load apps/express_app/app.db --create
.venv/bin/python seed.py load apps/fastapi_app/app.db --create
.venv/bin/python seed.py load apps/django_app/app.db --create
mkdir -p logs
redis-server --port 6391 --bind 127.0.0.1 --save '' --appendonly no --daemonize yes --pidfile "$B/logs/redis.pid" --logfile "$B/logs/redis.log"
trap 'kill $(cat "$B/logs/redis.pid") 2>/dev/null || true' EXIT
sleep 0.5
mv -f results.json "results.$(date +%s).json" 2>/dev/null || true
(cd apps/node_app && npm install --silent) && .venv/bin/python seed.py load apps/node_app/app.db --create
node bench.mjs info sanity main baseline scale allcores2 shield ramp
node summarize.mjs > summary.tables.md
node report.mjs
